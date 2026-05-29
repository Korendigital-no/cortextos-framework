// Publish flow: flip all 'approved' posts to 'published' (frontmatter
// write), commit on a fresh feature branch, push, open a PR via gh CLI.
// The PR is NOT auto-merged — Vilhelm reviews + merges on GitHub. Merge
// to main triggers the Vercel deploy.
//
// Safety:
// - Rate-limited to one invocation per 30 seconds (in-process). Prevents
//   accidental triple-click → triple PR. Per-IP would be nicer for
//   multi-user dashboards; this is single-tenant so process-global is fine.
// - spawnSync called with array args (never shell-interpolated). Slugs
//   used in the branch name + commit message + PR title are validated
//   against SLUG_REGEX upstream.
// - Branch + PR base hardcoded: branch = publish/<timestamp>, PR base = main.
// - On any failure: rollback the status flips AND delete the local branch
//   (and the remote branch if push succeeded) so the next publish attempt
//   starts from a clean state.
// - PR-only policy (CLAUDE.md): never `git push origin main` directly.

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { getAllPosts, getWebsiteRepoPath, setStatus, type ContentPost } from "@/lib/content";
import { upsertPending } from "@/lib/content-publish-pending";

const RATE_LIMIT_WINDOW_MS = 30_000;
let lastPublishAt = 0;

export interface PublishResult {
  ok: boolean;
  published: ContentPost[];
  message: string;
  prUrl?: string;
  branch?: string;
  gitLog?: string;
}

export interface PublishOptions {
  /** When true, do everything except the git push + PR create (diagnostics). */
  dryRun?: boolean;
}

function runGit(cwd: string, args: string[]): SpawnSyncReturns<Buffer> {
  return spawnSync("git", args, { cwd, encoding: "buffer", timeout: 60_000 });
}

function runGh(cwd: string, args: string[]): SpawnSyncReturns<Buffer> {
  return spawnSync("gh", args, { cwd, encoding: "buffer", timeout: 60_000 });
}

function bufferToString(b: Buffer | string | undefined): string {
  if (!b) return "";
  return Buffer.isBuffer(b) ? b.toString("utf-8") : b;
}

/** Build a slug-friendly summary for the branch name from the post slugs. */
function buildBranchSummary(slugs: string[]): string {
  if (slugs.length === 1) return slugs[0].slice(0, 40);
  return `${slugs.length}-posts`;
}

function todayYYYYMMDD(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Normalize any git remote URL to `owner/repo` lowercase form so HTTPS, SSH,
 * trailing-slash, and `.git`-suffix variants all compare equal. Returns the
 * lowercased input unchanged if it doesn't look like a git URL — that yields
 * a hard-fail in the caller, which is the right behavior (we'd rather refuse
 * to publish than guess).
 *
 * Examples:
 *   https://github.com/Foo/Bar.git  -> foo/bar
 *   git@github.com:Foo/Bar.git      -> foo/bar
 *   https://github.com/Foo/Bar/     -> foo/bar
 *   https://github.com/Foo/Bar      -> foo/bar
 */
export function normalizeGitRemotePath(url: string): string {
  const m = url.match(/[:/]([^/:]+\/[^/:]+?)(?:\.git)?\/?$/);
  return (m ? m[1] : url).toLowerCase();
}

const DEFAULT_EXPECTED_ORIGIN = "https://github.com/Korendigital-no/Korendigital-nettside.git";

export async function publishApproved(opts: PublishOptions = {}): Promise<PublishResult> {
  const now = Date.now();
  if (now - lastPublishAt < RATE_LIMIT_WINDOW_MS) {
    const wait = Math.ceil((RATE_LIMIT_WINDOW_MS - (now - lastPublishAt)) / 1000);
    return {
      ok: false,
      published: [],
      message: `Rate-limited. Try again in ${wait}s.`,
    };
  }
  lastPublishAt = now;

  const posts = await getAllPosts();
  const approved = posts.filter((p) => p.status === "approved");
  if (approved.length === 0) {
    return { ok: false, published: [], message: "No approved posts to publish." };
  }

  // PREFLIGHT (codex HIGH#1 + HIGH#3 + round-3 HIGH#1):
  // Run ALL invariant checks BEFORE any disk mutation. If preflight fails
  // we return without touching the working tree or status fields. Order:
  //   - gh CLI installed + authenticated (otherwise pr create later would
  //     leave a committed/pushed branch with no PR)
  //   - startBranch is a real, non-detached branch (otherwise we can't
  //     restore working state if something goes wrong)
  // No `flipped` state exists yet, so failure is a clean exit.
  const cwd = getWebsiteRepoPath();
  const ghVersion = runGh(cwd, ["--version"]);
  if (ghVersion.status !== 0) {
    return { ok: false, published: [], message: "gh CLI not installed or not on PATH. Cannot publish via PR." };
  }
  const ghAuth = runGh(cwd, ["auth", "status"]);
  if (ghAuth.status !== 0) {
    return { ok: false, published: [], message: "gh CLI not authenticated. Run `gh auth login` on the dashboard host." };
  }
  const startBranchResult = runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const startBranch = bufferToString(startBranchResult.stdout).trim();
  if (startBranchResult.status !== 0 || !startBranch || startBranch === "HEAD") {
    return {
      ok: false,
      published: [],
      message: `git rev-parse failed or returned ${JSON.stringify(startBranch)} (detached HEAD or non-git repo). Refusing to mutate.`,
    };
  }

  // Origin URL check: the local website clone's `origin` must point at the
  // canonical Korendigital-no/Korendigital-nettside repo. The repo moved
  // from vkoren04/ → Korendigital-no/ on 2026-05-29 and is now PRIVATE; a
  // stale clone with the old origin will push to a fork that no longer
  // accepts the push or open a PR against the wrong base. Catching it here
  // prevents a half-published state on disk (frontmatter flipped, branch
  // committed, push fails, rollback runs).
  const expectedOriginRaw = process.env.WEBSITE_REPO_ORIGIN_URL ?? DEFAULT_EXPECTED_ORIGIN;
  const expectedRepoPath = normalizeGitRemotePath(expectedOriginRaw);
  const originUrlResult = runGit(cwd, ["remote", "get-url", "origin"]);
  const originUrl = bufferToString(originUrlResult.stdout).trim();
  if (originUrlResult.status !== 0 || !originUrl) {
    return {
      ok: false,
      published: [],
      message: `git remote get-url origin failed in ${cwd}. Set up the origin remote first:\n  cd ${cwd}\n  git remote add origin ${expectedOriginRaw}\n  git fetch origin`,
    };
  }
  const actualRepoPath = normalizeGitRemotePath(originUrl);
  if (actualRepoPath !== expectedRepoPath) {
    return {
      ok: false,
      published: [],
      message:
        `Website repo origin mismatch — refusing to publish.\n` +
        `  Expected: ${expectedRepoPath}\n` +
        `  Got:      ${actualRepoPath}  (${originUrl})\n\n` +
        `Fix on the dashboard host:\n` +
        `  cd ${cwd}\n` +
        `  git remote set-url origin ${expectedOriginRaw}\n` +
        `  git fetch origin\n\n` +
        `If the canonical URL has legitimately changed, set the WEBSITE_REPO_ORIGIN_URL env var to the new URL and restart the dashboard.`,
    };
  }

  // Dry-run short-circuit BEFORE any mutation. Returns the list of posts
  // that would have been published. Earlier ordering flipped to disk first,
  // which left files mutated when the caller passed ?dryRun=true (codex
  // round-4 HIGH).
  if (opts.dryRun) {
    return {
      ok: true,
      published: approved,
      message: `Dry run: would publish ${approved.length} post(s) (${approved.map((p) => p.slug).join(", ")}).`,
    };
  }

  // 1. Flip each approved → published in frontmatter (atomic per file).
  //    Preflight has already cleared, so any failure here can roll back
  //    just the disk mutations.
  const flipped: ContentPost[] = [];
  try {
    for (const p of approved) {
      const updated = await setStatus(p.slug, "published");
      flipped.push(updated);
    }
  } catch (err) {
    for (const f of flipped) {
      try { await setStatus(f.slug, "approved"); } catch { /* best effort */ }
    }
    return {
      ok: false,
      published: [],
      message: `Status flip failed, rolled back: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const slugList = flipped.map((p) => p.slug).join(", ");
  const slugs = flipped.map((p) => p.slug);
  const commitMsg = `publish: ${flipped.length} post${flipped.length === 1 ? "" : "s"}: ${slugList}`;
  const baseBranchName = `blog/publish-${todayYYYYMMDD()}-${buildBranchSummary(slugs)}`;
  const filePaths = flipped.map((p) => `content/blog/${p.filename}`);

  // 2. Create a fresh branch off current HEAD. Try up to 5 suffixed names
  //    if collisions exist locally; check remote too via ls-remote so we
  //    don't try to push over an existing remote branch (per codex HIGH#4).
  let actualBranch: string | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = attempt === 0
      ? baseBranchName
      : `${baseBranchName}-${Date.now().toString(36).slice(-4)}-${attempt}`;
    // Local check
    const showLocal = runGit(cwd, ["show-ref", "--verify", `refs/heads/${candidate}`]);
    if (showLocal.status === 0) continue; // exists locally
    // Remote check
    const lsRemote = runGit(cwd, ["ls-remote", "--exit-code", "--heads", "origin", candidate]);
    if (lsRemote.status === 0) continue; // exists on remote

    const created = runGit(cwd, ["checkout", "-b", candidate]);
    if (created.status === 0) {
      actualBranch = candidate;
      break;
    }
  }
  if (!actualBranch) {
    await rollbackStatusOnly(flipped);
    return {
      ok: false,
      published: [],
      message: `Could not allocate a fresh publish branch after 5 attempts (last base: ${baseBranchName}). Clean up stale branches and retry.`,
    };
  }

  // 3. Stage ONLY the specific flipped post files. `git add content/blog`
  //    would sweep unapproved drafts and bypass the approve gate.
  const addResult = runGit(cwd, ["add", "--", ...filePaths]);
  if (addResult.status !== 0) {
    return rollback(flipped, "git add failed", bufferToString(addResult.stderr), cwd, startBranch, actualBranch);
  }

  // 4. git commit.
  const commitResult = runGit(cwd, ["commit", "-m", commitMsg]);
  if (commitResult.status !== 0) {
    const stderr = bufferToString(commitResult.stderr);
    if (!stderr.includes("nothing to commit")) {
      return rollback(flipped, "git commit failed", stderr, cwd, startBranch, actualBranch);
    }
    // nothing to commit → status flips already matched HEAD; clean up branch.
    return rollback(
      flipped,
      "git commit: nothing to commit (status already published on disk)",
      stderr,
      cwd, startBranch, actualBranch,
    );
  }

  // 5. Push branch to origin (NOT to main — branch only).
  const pushResult = runGit(cwd, ["push", "-u", "origin", actualBranch]);
  if (pushResult.status !== 0) {
    return rollback(flipped, "git push (branch) failed", bufferToString(pushResult.stderr), cwd, startBranch, actualBranch);
  }

  // 6. Open PR via gh CLI. NO auto-merge — Vilhelm reviews + merges on GitHub.
  const prTitle = commitMsg;
  const prBody = [
    `Auto-generated by dashboard /content publish action.`,
    ``,
    `**Posts being published:**`,
    ...flipped.map((p) => `- \`${p.slug}\` — ${p.title}`),
    ``,
    `Merging this PR triggers Vercel deploy to korendigital.no.`,
  ].join("\n");
  const prResult = runGh(cwd, ["pr", "create", "--base", "main", "--head", actualBranch, "--title", prTitle, "--body", prBody]);
  if (prResult.status !== 0) {
    // PR creation failed but branch pushed successfully. Leave the remote
    // branch in place so Vilhelm can open the PR manually, but ALWAYS
    // return the local checkout to startBranch — otherwise the next
    // publish would branch off this stale publish branch and stack commits
    // (per codex HIGH#1).
    const checkoutBack = runGit(cwd, ["checkout", startBranch]);
    const checkoutNote = checkoutBack.status !== 0
      ? ` WARNING: failed to checkout back to ${startBranch} (stderr: ${bufferToString(checkoutBack.stderr).slice(0, 200)}). Repo is on ${actualBranch}.`
      : "";
    return {
      ok: false,
      published: flipped,
      message: `Branch ${actualBranch} pushed but gh pr create failed. Open the PR manually on GitHub. stderr: ${bufferToString(prResult.stderr).slice(0, 300)}.${checkoutNote}`,
      branch: actualBranch,
    };
  }
  const prUrl = bufferToString(prResult.stdout).trim().split("\n").pop() ?? "";

  // 7. Record pending PR state in the dashboard's sidecar so the list view
  //    can show these posts as "published" until the PR merges. Without
  //    this, the upcoming `git checkout startBranch` reverts the working
  //    tree to startBranch's state (status: approved), and the UI would
  //    show the post in the Approved tab even though the PR is open and
  //    awaiting merge. Sidecar lives outside the website repo so it's
  //    immune to git checkouts/pulls. Self-heals via gh pr view in
  //    content.ts when state == MERGED or CLOSED.
  if (prUrl) {
    const publishedAt = new Date().toISOString();
    const entries: Record<string, { prUrl: string; branch: string; publishedAt: string }> = {};
    for (const p of flipped) {
      entries[p.slug] = { prUrl, branch: actualBranch, publishedAt };
    }
    try {
      await upsertPending(entries);
    } catch (err) {
      // Sidecar write failure is non-fatal: PR is created either way.
      // Log + continue. UI will be wrong (post shows as approved) but
      // git state is correct and Vilhelm can still merge the PR.
      console.error("[content-publish] sidecar upsert failed:", err);
    }
  }

  // 8. Return to starting branch so the working tree is clean for the next
  //    publish (or for manual git activity).
  runGit(cwd, ["checkout", startBranch]);

  const gitLog = [
    `# git checkout -b ${actualBranch}`,
    `# git add -- ${filePaths.join(' ')}\n${bufferToString(addResult.stdout)}${bufferToString(addResult.stderr)}`,
    `# git commit -m "${commitMsg}"\n${bufferToString(commitResult.stdout)}${bufferToString(commitResult.stderr)}`,
    `# git push -u origin ${actualBranch}\n${bufferToString(pushResult.stdout)}${bufferToString(pushResult.stderr)}`,
    `# gh pr create\n${bufferToString(prResult.stdout)}${bufferToString(prResult.stderr)}`,
  ].join("\n---\n");

  return {
    ok: true,
    published: flipped,
    message: `PR opened: ${flipped.length} post(s) (${slugList}). Review + merge on GitHub to trigger Vercel deploy.`,
    prUrl,
    branch: actualBranch,
    gitLog,
  };
}

/**
 * Status-only rollback. Used in preflight-failure paths where no git mutation
 * has happened yet (so there's no branch to clean up).
 */
async function rollbackStatusOnly(flipped: ContentPost[]): Promise<void> {
  for (const f of flipped) {
    try { await setStatus(f.slug, "approved"); } catch { /* best effort */ }
  }
}

async function rollback(
  flipped: ContentPost[],
  stage: string,
  stderr: string,
  cwd?: string,
  startBranch?: string,
  branchToDelete?: string | null,
): Promise<PublishResult> {
  // Per codex HIGH#2: only delete the publish branch AFTER we've confirmed
  // the checkout back to startBranch succeeded. Without that confirmation,
  // `git branch -D <current-branch>` fails AND any subsequent setStatus()
  // writes mutate the wrong working tree.
  let checkoutOk = true;
  let cleanupNote = "";
  if (cwd && startBranch) {
    const checkoutBack = runGit(cwd, ["checkout", startBranch]);
    if (checkoutBack.status !== 0) {
      checkoutOk = false;
      cleanupNote = ` WARNING: failed to checkout back to ${startBranch} — branch deletion + status revert SKIPPED to avoid corrupting state. Manual cleanup required (publish branch: ${branchToDelete}).`;
    } else if (branchToDelete) {
      const del = runGit(cwd, ["branch", "-D", branchToDelete]);
      if (del.status !== 0) {
        cleanupNote = ` Note: branch -D ${branchToDelete} failed (stderr: ${bufferToString(del.stderr).slice(0, 150)}). Branch may still exist locally.`;
      } else {
        cleanupNote = ` Local branch ${branchToDelete} deleted.`;
      }
    }
  }
  // Only mutate status back if working tree is on the right branch.
  if (checkoutOk) {
    await rollbackStatusOnly(flipped);
  }
  return {
    ok: false,
    published: [],
    message: `${stage}; ${checkoutOk ? "rolled back status flips" : "STATUS NOT ROLLED BACK (see warning)"}.${cleanupNote} stderr: ${stderr.slice(0, 500)}`,
  };
}
