/**
 * approval-store.ts — the action-gate's network-free approval I/O.
 *
 * Deliberately separate from src/bus/approval.ts (which pulls in Telegram /
 * message / activity-channel network code): the gate core, and especially the
 * PreToolUse hook surface with its ≤5s budget, must NEVER block on the network
 * inside a decision. So the gate writes the pending approval FILE synchronously
 * here (the dashboard is the durable approval surface — it lists this dir); the
 * Telegram *nudge* is a separate, surface-owned concern (CLI awaits it before
 * exit; hook enqueues it). Rows are byte-compatible with src/bus/approval.ts so
 * listApprovals / the dashboard / update-approval all see them.
 */

import { readdirSync, readFileSync, renameSync } from 'fs';
import { join } from 'path';
import type { Approval, ApprovalCategory, BusPaths } from '../types/index.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { randomString } from '../utils/random.js';

export type ApprovalLookup = { state: 'approved' | 'pending' | 'none'; id?: string };

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Read approval rows from a dir, skipping consumed claims and corrupt files. */
function scanApprovals(dir: string, match: (a: Approval) => boolean): Approval | null {
  let files: string[];
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.json') && !f.endsWith('.consumed.json'));
  } catch {
    return null; // missing dir
  }
  for (const file of files) {
    try {
      const a: Approval = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
      if (match(a)) return a;
    } catch {
      // skip corrupt row — an unreadable row must not blind the lookup
    }
  }
  return null;
}

/**
 * Look up an approval bound to (org, requesting_agent, category, fingerprint).
 * Binding to org + agent (not just category/fp) prevents one agent's approval
 * from being replayed by another (P2-7).
 *  - resolved/ approved + matching + consumed_at empty ⇒ `approved`
 *  - pending/ matching ⇒ `pending` (don't create a duplicate)
 *  - else ⇒ `none`
 */
export function findApproval(
  paths: BusPaths,
  org: string,
  agent: string,
  category: ApprovalCategory,
  fingerprint: string,
): ApprovalLookup {
  const resolvedDir = join(paths.approvalDir, 'resolved');
  const pendingDir = join(paths.approvalDir, 'pending');

  const approved = scanApprovals(resolvedDir, a =>
    a.status === 'approved' &&
    a.action_fingerprint === fingerprint &&
    a.requesting_agent === agent &&
    a.org === org &&
    !a.consumed_at,
  );
  if (approved) return { state: 'approved', id: approved.id };

  const pending = scanApprovals(pendingDir, a =>
    a.status === 'pending' &&
    a.action_fingerprint === fingerprint &&
    a.requesting_agent === agent &&
    a.org === org,
  );
  if (pending) return { state: 'pending', id: pending.id };

  return { state: 'none' };
}

/**
 * Atomically consume (single-use spend) an approved row. The claim is the atomic
 * `renameSync` of resolved/<id>.json → resolved/<id>.consumed.json: only ONE
 * concurrent contender's rename succeeds; the loser gets ENOENT and returns false
 * (→ the gate re-blocks). This closes the read-modify-write race (P1-5) — two
 * attempts can both observe `consumed_at == null`, but only the rename winner runs.
 * Pattern: the proven orphan-reap atomic-claim (MEMORY 2026-06-11).
 */
export function consumeApproval(paths: BusPaths, id: string): boolean {
  const resolvedDir = join(paths.approvalDir, 'resolved');
  const src = join(resolvedDir, `${id}.json`);
  const dst = join(resolvedDir, `${id}.consumed.json`);
  try {
    renameSync(src, dst); // atomic claim — winner only
  } catch {
    return false; // ENOENT (lost the race / already consumed) — re-block
  }
  // Best-effort stamp consumed_at AFTER winning the claim (the rename already
  // decided the winner; a failure here does not un-consume).
  try {
    const a: Approval = JSON.parse(readFileSync(dst, 'utf-8'));
    a.consumed_at = isoNow();
    a.updated_at = a.consumed_at;
    atomicWriteSync(dst, JSON.stringify(a));
  } catch {
    // ignore — the .consumed.json rename is the durable single-use marker
  }
  return true;
}

export interface PendingApprovalInput {
  agent: string;
  org: string;
  category: ApprovalCategory;
  title: string;
  description: string;
  action_fingerprint: string;
}

/**
 * Write a pending approval row synchronously (NO network). Returns its id. Used by
 * the gate when a gated action has no existing approval. The Telegram nudge is the
 * caller's (surface's) responsibility — see module header.
 */
export function writePendingApproval(paths: BusPaths, input: PendingApprovalInput): string {
  const epoch = Math.floor(Date.now() / 1000);
  const id = `approval_${epoch}_${randomString(5)}`;
  const now = isoNow();
  const approval: Approval = {
    id,
    title: input.title,
    requesting_agent: input.agent,
    org: input.org,
    category: input.category,
    status: 'pending',
    description: input.description,
    created_at: now,
    updated_at: now,
    resolved_at: null,
    resolved_by: null,
    action_fingerprint: input.action_fingerprint,
    consumed_at: null,
  };
  const pendingDir = join(paths.approvalDir, 'pending');
  ensureDir(pendingDir);
  atomicWriteSync(join(pendingDir, `${id}.json`), JSON.stringify(approval));
  return id;
}
