// Make a content edit canonical (#edit-body, policy A).
//
// The "edit body" save in the dashboard writes the post's markdown to the
// local website clone's working tree. On its own that never reaches the live
// site: Vercel deploys from origin/main, so an uncommitted working-tree change
// is visible only in the editor and diverges from what the public site (and
// any fresh clone, e.g. a research agent) reads. This helper commits the saved
// file and pushes it to origin/main so the edit becomes canonical — and,
// critically, it RETURNS a result the caller surfaces rather than swallowing
// failures silently (the original bug was a silent no-persist).
//
// Scope: a single file is staged by path — never `git add -A` — so a save can
// never sweep up unrelated working-tree edits (e.g. other posts sitting on a
// recovery branch) into the commit.

import { spawnSync } from "node:child_process";
import { normalizeGitRemotePath } from "./content-publish";

// Canonical website repo (same default + override the publish flow uses, so the
// two paths agree on what "live" means).
const DEFAULT_EXPECTED_ORIGIN = "https://github.com/Korendigital-no/Korendigital-nettside.git";

export type GitRunner = (cwd: string, args: string[]) => { status: number | null; stdout: string; stderr: string };

const defaultRunner: GitRunner = (cwd, args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8", timeout: 60_000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

export interface CommitPushResult {
  /** The local file write + commit succeeded (the edit is at least saved locally). */
  ok: boolean;
  /** The commit reached origin/main — i.e. the edit is canonical. */
  pushed: boolean;
  /**
   * Discriminator so the UI can react precisely:
   *   - "pushed"    → reached origin/main (success)
   *   - "no-change" → file already matched HEAD; nothing to do (benign success)
   *   - "not-live"  → saved locally but NOT canonical (wrong branch/origin, main
   *                   ahead, or push rejected) — the user must resolve + re-save
   *   - "error"     → git add/commit failed
   */
  kind: "pushed" | "no-change" | "not-live" | "error";
  /** Human-facing status the dashboard shows. */
  message: string;
}

/**
 * Stage exactly `relPath`, commit it, and push to origin/main. Never throws.
 *
 * Safety invariants (each verified before committing, so a save can never
 * deploy something it shouldn't):
 *   - origin points at the canonical website repo (else a stale fork);
 *   - HEAD is the `main` branch (never publish from a recovery/publish branch);
 *   - main has no local commits ahead of origin/main (else the push would carry
 *     unrelated history).
 * If the push itself fails after the commit, the commit is rolled back (soft)
 * so it can't be swept into a later publish PR — the edit stays on disk.
 */
export async function commitAndPushContentFile(
  repoPath: string,
  relPath: string,
  commitMessage: string,
  run: GitRunner = defaultRunner,
): Promise<CommitPushResult> {
  // ORIGIN VALIDATION: the clone's `origin` must point at the canonical website
  // repo, or `git push origin main` would deploy the edit to a stale fork while
  // we falsely report it live. Mirrors the publish flow's expected-origin guard.
  const expectedOrigin = process.env.WEBSITE_REPO_ORIGIN_URL ?? DEFAULT_EXPECTED_ORIGIN;
  const originRes = run(repoPath, ["remote", "get-url", "origin"]);
  const originUrl = (originRes.stdout || "").trim();
  if (originRes.status !== 0 || !originUrl || normalizeGitRemotePath(originUrl) !== normalizeGitRemotePath(expectedOrigin)) {
    return {
      ok: true,
      pushed: false,
      kind: "not-live",
      message: `Saved locally but NOT published — website clone origin is '${originUrl || "unset"}', expected '${expectedOrigin}'. The edit did not reach the canonical repo. Fix the origin remote first.`,
    };
  }

  // `git push origin main` deploys the WHOLE branch history, not just this
  // commit. Require a clean main base before committing.
  const branch = run(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branchName = (branch.stdout || "").trim();
  if (branch.status !== 0 || branchName !== "main") {
    return {
      ok: true,
      pushed: false,
      kind: "not-live",
      message: `Saved locally but NOT published — the website clone is on '${branchName || "unknown"}', not main. The edit will not go live until the clone is back on main.`,
    };
  }
  // Fetch so origin/main is current; best-effort (offline just over-counts).
  run(repoPath, ["fetch", "origin", "main"]);
  const ahead = run(repoPath, ["rev-list", "--count", "origin/main..HEAD"]);
  const aheadN = Number.parseInt((ahead.stdout || "").trim(), 10);
  if (ahead.status !== 0 || !Number.isFinite(aheadN) || aheadN > 0) {
    const n = Number.isFinite(aheadN) ? aheadN : "unverified";
    return {
      ok: true,
      pushed: false,
      kind: "not-live",
      message: `Saved locally but NOT published — local main has ${n} unpushed commit(s); publishing this edit would also deploy them. Reconcile main with origin/main first.`,
    };
  }

  const add = run(repoPath, ["add", "--", relPath]);
  if (add.status !== 0) {
    return { ok: false, pushed: false, kind: "error", message: `git add failed: ${(add.stderr || "").trim()}` };
  }

  // Nothing staged means the on-disk file already matches HEAD — a no-op save.
  const staged = run(repoPath, ["diff", "--cached", "--quiet", "--", relPath]);
  if (staged.status === 0) {
    return { ok: true, pushed: false, kind: "no-change", message: "No change to commit." };
  }

  const commit = run(repoPath, ["commit", "-m", commitMessage, "--", relPath]);
  if (commit.status !== 0) {
    // Commit failed but the file is still staged from `git add`. Unstage it so a
    // later publishApproved() (which commits without a pathspec) can't sweep
    // this edit into its PR. The edit remains in the working tree (saved).
    run(repoPath, ["reset", "HEAD", "--", relPath]);
    return { ok: false, pushed: false, kind: "error", message: `git commit failed: ${(commit.stderr || "").trim()}` };
  }

  const push = run(repoPath, ["push", "origin", "main"]);
  if (push.status !== 0) {
    // Roll back the commit AND unstage (`--mixed`) so the edit reverts to a
    // plain working-tree change — never a committed or staged state that a later
    // publish PR's branch-from-HEAD / pathspec-less commit could sweep up. The
    // edit is still on disk; the user resolves the push problem and re-saves.
    run(repoPath, ["reset", "--mixed", "HEAD~1"]);
    return {
      ok: true,
      pushed: false,
      kind: "not-live",
      message: `Saved locally but NOT published — push to origin/main failed (commit rolled back + unstaged so it can't leak into a publish PR). Resolve and re-save: ${(push.stderr || "").trim()}`,
    };
  }

  // "pushed" means the markdown reached origin/main (canonical source). Whether
  // it renders on the public blog depends on the post's published status — so we
  // report "pushed to origin/main", not "live", here.
  return { ok: true, pushed: true, kind: "pushed", message: "Saved and pushed to origin/main." };
}
