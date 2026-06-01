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
import {
  getAllPosts,
  getWebsiteRepoPath,
  readStatusFromDisk,
  revertToApproved,
  setStatus,
  type ContentPost,
} from "@/lib/content";
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

/**
 * True if a raw post blob's frontmatter declares status: published. Reads only
 * the fenced `---` block and the top-level `status:` line, tolerating quotes
 * and a trailing `# comment`. Used to verify the STAGED git blob before commit
 * without pulling gray-matter into this module's hot path.
 */
export function stagedBlobIsPublished(blob: string): boolean {
  const fence = blob.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\s*(\r?\n|$)/);
  if (!fence) return false;
  for (const line of fence[1].split(/\r?\n/)) {
    const m = line.match(/^status:\s*(.*)$/);
    if (!m) continue;
    let v = m[1].trim();
    // Strip an unquoted trailing comment.
    if (!/^["']/.test(v)) v = v.replace(/\s+#.*$/, "").trim();
    // Strip surrounding quotes.
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    return v === "published";
  }
  return false;
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

  // SNAPSHOT-FRESHNESS GUARD (race-guard R1): the publish branch is cut from
  // the current local HEAD (startBranch) a few lines down. If origin/<startBranch>
  // has advanced since this clone last synced, that snapshot is STALE — the PR
  // would be based on an old main and could publish content that silently reverts
  // newer commits. This is the "publish raced a later edit" class: a publish PR
  // opened against an old main while a direct edit landed newer commits; only
  // GitHub's 3-way merge reconciled it last time, which was luck, not design.
  // Fetch the latest ref and refuse to publish from a stale base — before any
  // mutation, so failure is a clean exit. (Read-only: git fetch + rev-list don't
  // touch the working tree, so the intentionally-uncommitted approve flip is
  // safe.)
  const fetchRes = runGit(cwd, ["fetch", "origin", startBranch]);
  if (fetchRes.status !== 0) {
    return {
      ok: false,
      published: [],
      message:
        `git fetch origin ${startBranch} failed — cannot verify the publish base is current, ` +
        `refusing to publish from a possibly-stale snapshot. ${bufferToString(fetchRes.stderr).trim()}`,
    };
  }
  const behindRes = runGit(cwd, ["rev-list", "--count", `${startBranch}..origin/${startBranch}`]);
  const behindCount = Number.parseInt(bufferToString(behindRes.stdout).trim(), 10);
  if (behindRes.status === 0 && Number.isFinite(behindCount) && behindCount > 0) {
    return {
      ok: false,
      published: [],
      message:
        `origin/${startBranch} has ${behindCount} new commit(s) since this clone last synced. ` +
        `Publishing now would branch from a stale snapshot and could race a newer edit ` +
        `(silently reverting it on merge). Fast-forward first, then retry:\n` +
        `  cd ${cwd}\n  git pull --ff-only origin ${startBranch}`,
    };
  }

  // CLOBBER PROTECTION (#edit-body): this flow ends with `git checkout
  // startBranch`, which reverts the working tree — so an UNCOMMITTED body edit
  // sitting in content/blog would be silently destroyed. The fix is policy A
  // itself: every "edit body" save now commits the file to origin/main
  // immediately (commitAndPushContentFile), so a body edit is never an
  // uncommitted working-tree change and cannot be clobbered here. We do NOT add
  // a blanket "refuse if content/blog is dirty" guard, because the normal
  // approve→publish path INTENTIONALLY leaves the approve status-flip
  // uncommitted for this function to read and commit (codex: such a guard would
  // block the very file it is meant to publish). If a save's commit step fails,
  // the dashboard already surfaces sync.ok=false so the user resolves it.

  // Capture each post's pre-flip date BEFORE setStatus stamps the publish date
  // onto it (codex P2). Every rollback path restores these so a failed publish
  // can never leave an approved post wearing a publish-date it never published
  // under. Captured from `approved` (the pre-flip snapshot).
  const originalDates = new Map(approved.map((p) => [p.slug, p.date] as const));

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
      // revertToApproved (not setStatus) so the failed-publish stamp is
      // cleared and the approval trail is preserved — see codex HIGH#3.
      // Pass the original date so the publish-date stamp is undone too.
      try { await revertToApproved(f.slug, originalDates.get(f.slug)); } catch { /* best effort */ }
    }
    return {
      ok: false,
      published: [],
      message: `Status flip failed, rolled back: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 2. VERIFY-ON-DISK guardrail (blocks the "blog-filter-bug" class).
  //    Before we commit/push/PR, re-read each flipped post's LITERAL BYTES
  //    ON DISK and assert its status is actually "published". setStatus
  //    returned a post object claiming success, but a partial atomic-write or
  //    schema quirk could mean the bytes on disk don't match. Committing here
  //    would ship a PR whose post still renders as approved (doesn't appear on
  //    the live blog) — exactly the failure we're hardening against.
  //    readStatusFromDisk bypasses getAllPosts + applyPublishSidecar so the
  //    sidecar's "PR-awaiting-merge → show as published" override can NEVER
  //    mask a still-approved file (codex HIGH#1). This is a true disk
  //    round-trip, not a re-read of the in-memory `flipped` object or the
  //    sidecar-overlaid view.
  //    On ANY mismatch: roll the status flips back (no branch exists yet, so
  //    rollbackStatusOnly is the correct path) and return ok:false naming the
  //    offending slug(s). Nothing is committed, pushed, or PR'd.
  const notPublished: string[] = [];
  for (const f of flipped) {
    const onDiskStatus = await readStatusFromDisk(f.slug);
    if (onDiskStatus !== "published") {
      notPublished.push(f.slug);
    }
  }
  if (notPublished.length > 0) {
    await rollbackStatusOnly(flipped, originalDates);
    return {
      ok: false,
      published: [],
      message:
        `Pre-publish verification failed — these post(s) did not flip to "published" on disk: ${notPublished.join(", ")}. ` +
        `Nothing was committed, pushed, or PR'd; status flips rolled back. Inspect the file(s) and retry.`,
    };
  }

  const slugList = flipped.map((p) => p.slug).join(", ");
  const slugs = flipped.map((p) => p.slug);
  const commitMsg = `publish: ${flipped.length} post${flipped.length === 1 ? "" : "s"}: ${slugList}`;
  const baseBranchName = `blog/publish-${todayYYYYMMDD()}-${buildBranchSummary(slugs)}`;
  const filePaths = flipped.map((p) => `content/blog/${p.filename}`);

  // 3. Create a fresh branch off current HEAD. Try up to 5 suffixed names
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
    await rollbackStatusOnly(flipped, originalDates);
    return {
      ok: false,
      published: [],
      message: `Could not allocate a fresh publish branch after 5 attempts (last base: ${baseBranchName}). Clean up stale branches and retry.`,
    };
  }

  // 4. Stage ONLY the specific flipped post files. `git add content/blog`
  //    would sweep unapproved drafts and bypass the approve gate.
  const addResult = runGit(cwd, ["add", "--", ...filePaths]);
  if (addResult.status !== 0) {
    return rollback(flipped, "git add failed", bufferToString(addResult.stderr), cwd, startBranch, actualBranch, originalDates);
  }

  // 4b. VERIFY-STAGED-BLOB guardrail (closes the TOCTTOU window — codex
  //     HIGH#2). The step-2 disk check ran before branch creation; a
  //     concurrent edit could have reverted a file to "approved" in the
  //     interim. `git commit` snapshots the STAGED blob, so we read exactly
  //     that blob back (`git show :<path>`) and assert it declares
  //     `status: published` in its frontmatter. This is the last gate before
  //     the commit captures the bytes — anything that didn't make it into the
  //     index as published is caught here, not shipped.
  const badStaged: string[] = [];
  for (const p of flipped) {
    const rel = `content/blog/${p.filename}`;
    const show = runGit(cwd, ["show", `:${rel}`]);
    const blob = bufferToString(show.stdout);
    if (show.status !== 0 || !stagedBlobIsPublished(blob)) {
      badStaged.push(p.slug);
    }
  }
  if (badStaged.length > 0) {
    return rollback(
      flipped,
      `staged content for ${badStaged.join(", ")} is not "published" (concurrent edit?) — refusing to commit`,
      "",
      cwd, startBranch, actualBranch, originalDates,
    );
  }

  // 5. git commit.
  const commitResult = runGit(cwd, ["commit", "-m", commitMsg]);
  if (commitResult.status !== 0) {
    const stderr = bufferToString(commitResult.stderr);
    if (!stderr.includes("nothing to commit")) {
      return rollback(flipped, "git commit failed", stderr, cwd, startBranch, actualBranch, originalDates);
    }
    // nothing to commit → status flips already matched HEAD; clean up branch.
    return rollback(
      flipped,
      "git commit: nothing to commit (status already published on disk)",
      stderr,
      cwd, startBranch, actualBranch, originalDates,
    );
  }

  // 6. Push branch to origin (NOT to main — branch only).
  const pushResult = runGit(cwd, ["push", "-u", "origin", actualBranch]);
  if (pushResult.status !== 0) {
    return rollback(flipped, "git push (branch) failed", bufferToString(pushResult.stderr), cwd, startBranch, actualBranch, originalDates);
  }

  // 7. Open PR via gh CLI. NO auto-merge — Vilhelm reviews + merges on GitHub.
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

  // 8. Record pending PR state in the dashboard's sidecar so the list view
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

  // 9. Return to starting branch so the working tree is clean for the next
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
async function rollbackStatusOnly(
  flipped: ContentPost[],
  originalDates?: Map<string, string>,
): Promise<void> {
  for (const f of flipped) {
    // revertToApproved clears the failed-publish stamp (publishedAt/By) and
    // preserves the approval trail — a plain setStatus(slug,"approved") would
    // re-stamp approvedAt/By and leave stale publish metadata (codex HIGH#3).
    // The original date (when supplied) also undoes the publish-date stamp
    // (codex P2), so a pre-branch failure leaves the file byte-identical to its
    // pre-publish state.
    try { await revertToApproved(f.slug, originalDates?.get(f.slug)); } catch { /* best effort */ }
  }
}

async function rollback(
  flipped: ContentPost[],
  stage: string,
  stderr: string,
  cwd?: string,
  startBranch?: string,
  branchToDelete?: string | null,
  originalDates?: Map<string, string>,
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
  // Only mutate status back if working tree is on the right branch. The
  // checkout above already restored each file to startBranch's version (original
  // date included), so passing originalDates here is defensive/uniform — it
  // keeps the revert correct even if checkout semantics change (codex P2).
  if (checkoutOk) {
    await rollbackStatusOnly(flipped, originalDates);
  }
  return {
    ok: false,
    published: [],
    message: `${stage}; ${checkoutOk ? "rolled back status flips" : "STATUS NOT ROLLED BACK (see warning)"}.${cleanupNote} stderr: ${stderr.slice(0, 500)}`,
  };
}
