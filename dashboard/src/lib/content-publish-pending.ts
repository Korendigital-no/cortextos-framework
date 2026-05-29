// Sidecar state for the content-publish flow.
//
// Problem: publishApproved() flips status: approved → published on disk,
// commits the change on a publish branch, opens a PR, then checks out
// back to startBranch. The checkout reverts the working-tree files to
// startBranch's state (status: approved), so the dashboard list view
// shows the post in the Approved tab instead of Published until the PR
// merges AND Vilhelm pulls the merged main.
//
// Solution: keep a sidecar JSON in the dashboard's state dir (NOT in the
// website repo, so it survives git checkouts/pulls). On every list-posts,
// content.ts reads the sidecar and overrides status to "published" for
// any slug whose PR is still open. Once the PR is merged or closed, the
// entry self-heals out of the sidecar.

import fs from "node:fs/promises";
import path from "node:path";
import { CTX_ROOT } from "@/lib/config";

export interface PendingEntry {
  /** PR URL returned by gh pr create. */
  prUrl: string;
  /** Branch the PR was opened from. */
  branch: string;
  /** ISO timestamp when publishApproved wrote this entry. */
  publishedAt: string;
}

/** Map keyed by post slug. */
export type PendingMap = Record<string, PendingEntry>;

function sidecarPath(): string {
  return path.join(CTX_ROOT, "state", "dashboard", "content-publish-pending.json");
}

export async function readPending(): Promise<PendingMap> {
  const fp = sidecarPath();
  try {
    const raw = await fs.readFile(fp, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as PendingMap;
    }
    return {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    // Corrupt sidecar should not break the dashboard. Log + return empty.
    console.error("[content-publish-pending] failed to read sidecar:", err);
    return {};
  }
}

async function writeAtomic(content: string): Promise<void> {
  const fp = sidecarPath();
  await fs.mkdir(path.dirname(fp), { recursive: true });
  const tmp = `${fp}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, content, "utf-8");
  await fs.rename(tmp, fp);
}

export async function upsertPending(entries: Record<string, PendingEntry>): Promise<void> {
  const current = await readPending();
  const merged = { ...current, ...entries };
  await writeAtomic(JSON.stringify(merged, null, 2) + "\n");
}

export async function deletePending(slugs: string[]): Promise<void> {
  if (slugs.length === 0) return;
  const current = await readPending();
  let mutated = false;
  for (const slug of slugs) {
    if (slug in current) {
      delete current[slug];
      mutated = true;
    }
  }
  if (!mutated) return;
  await writeAtomic(JSON.stringify(current, null, 2) + "\n");
}
