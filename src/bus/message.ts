import { readdirSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import type { InboxMessage, Priority, BusPaths } from '../types/index.js';
import { PRIORITY_MAP } from '../types/index.js';
import { atomicWriteSync, durableAtomicWriteSync, durableUnlinkSync, ensureDir } from '../utils/atomic.js';
import { acquireLock, releaseLock, withFileLockAsync, withFileLockSync } from '../utils/lock.js';
import { randomString } from '../utils/random.js';
import { validateAgentName, validatePriority } from '../utils/validate.js';
import { signInboxMessage, verifyInboxMessage, logSignatureShadow } from './message-signing.js';

// ---------------------------------------------------------------------------
// Security: per-agent Ed25519 bus message signing
// ---------------------------------------------------------------------------
// Phase 1 is intentionally SHADOW/backward-compatible: senders sign new
// messages, receivers verify when possible, but unsigned/invalid messages are
// still delivered and only logged. Enforce-reject is a later explicit flip.

/**
 * Send a message to another agent's inbox.
 * Creates a JSON file with format: {pnum}-{epochMs}-from-{sender}-{rand5}.json
 * Identical to bash send-message.sh output.
 */
export function sendMessage(
  paths: BusPaths,
  from: string,
  to: string,
  priority: Priority,
  text: string,
  replyTo?: string,
): string {
  validateAgentName(from);
  validateAgentName(to);
  validatePriority(priority);

  const pnum = PRIORITY_MAP[priority];
  const epochMs = Date.now();
  const rand = randomString(5);
  const msgId = `${epochMs}-${from}-${rand}`;
  const filename = `${pnum}-${epochMs}-from-${from}-${rand}.json`;

  const unsignedMessage: Omit<InboxMessage, 'signature' | 'sig'> = {
    id: msgId,
    from,
    to,
    priority,
    timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z'),
    text,
    reply_to: replyTo || null,
  };
  const message = signInboxMessage(paths, unsignedMessage);

  // Write to target agent's inbox
  const inboxDir = join(paths.ctxRoot, 'inbox', to);
  ensureDir(inboxDir);
  atomicWriteSync(join(inboxDir, filename), JSON.stringify(message));

  return msgId;
}

/**
 * Check inbox for pending messages.
 * Reads inbox directory, moves messages to inflight, returns sorted array.
 * Recovers stale inflight messages (>5 minutes old).
 * Identical to bash check-inbox.sh behavior.
 */
export interface CheckInboxOptions {
  /**
   * Active-turn delivery lease. A message already injected into a live agent
   * turn must not be injected again every five minutes while that same turn is
   * still running. Direct CLI check-inbox calls retain the legacy five-minute
   * recovery behaviour unless they opt in explicitly.
   */
  deferWhileAgentActive?: boolean;
}

export function checkInbox(paths: BusPaths, options: CheckInboxOptions = {}): InboxMessage[] {
  const { inbox, inflight } = paths;
  ensureDir(inbox);
  ensureDir(inflight);

  // Acquire lock
  if (!acquireLock(inbox)) {
    return [];
  }

  try {
    // ACK receipts are the durable source of truth. Reconcile them before any
    // stale recovery so a reply/explicit ACK that raced a queue move can never
    // be injected again — including after a daemon restart.
    reconcileAckReceipts(paths);
    pruneAckReceipts(paths);

    // Recover stale inflight messages (>5 min old) for redelivery; parks
    // messages that exhausted MAX_REDELIVERIES in processed/ (loudly).
    recoverStaleInflight(inflight, inbox, 300, paths.processed, {
      stateDir: paths.stateDir,
      deferWhileAgentActive: options.deferWhileAgentActive ?? false,
    });

    // Read and sort messages by filename (priority then timestamp)
    const files = readdirSync(inbox)
      .filter(f => f.endsWith('.json') && !f.startsWith('.'))
      .sort();

    if (files.length === 0) {
      return [];
    }

    const messages: InboxMessage[] = [];
    for (const file of files) {
      const srcPath = join(inbox, file);
      try {
        const content = readFileSync(srcPath, 'utf-8');
        const msg: InboxMessage = JSON.parse(content);

        // Doc-1 phase 1: verify in shadow, but ALWAYS accept. This preserves the
        // existing fleet bus while we observe unsigned/invalid senders before a
        // later explicit enforce flip.
        logSignatureShadow(paths, msg, verifyInboxMessage(paths.ctxRoot, msg));

        // A recovered record may carry confirmation for its PREVIOUS attempt.
        // Clear it before the next inject so a daemon crash/failure between
        // checkInbox and PTY delivery receives the ordinary 5-minute retry,
        // never the 30-minute active-turn lease.
        if (msg.injection_confirmed_at) {
          delete msg.injection_confirmed_at;
          atomicWriteSync(srcPath, JSON.stringify(msg));
        }

        // Move to inflight
        const destPath = join(inflight, file);
        renameSync(srcPath, destPath);
        // Restart the redelivery clock at DELIVERY time: rename preserves
        // mtime, so a message that waited in inbox/ longer than the stale
        // threshold (agent down, boot backlog) would otherwise land in
        // inflight/ already "stale" and immediately re-recover on the next
        // cycle — burning through MAX_REDELIVERIES in minutes while the
        // agent is actively handling it. "Un-ACK'd after 5 min" is defined
        // from delivery, not from send.
        try {
          const deliveredAt = new Date();
          utimesSync(destPath, deliveredAt, deliveredAt);
        } catch { /* best effort — worst case is an early redelivery */ }
        messages.push(msg);
      } catch {
        // Move corrupt files to .errors/
        const errDir = join(inbox, '.errors');
        ensureDir(errDir);
        try {
          renameSync(srcPath, join(errDir, file));
        } catch {
          // Ignore if move fails
        }
      }
    }

    return messages;
  } finally {
    releaseLock(inbox);
  }
}

/**
 * Mark only messages whose bytes were successfully injected into the agent.
 * The confirmation is deliberately separate from checkInbox's queue move:
 * process death or NOT_RUNNING between those operations must not look like an
 * active turn and suppress retry for 30 minutes.
 */
export function markInboxInjected(paths: BusPaths, messageIds: string[]): number {
  if (messageIds.length === 0) return 0;
  ensureDir(paths.inbox);
  ensureDir(paths.inflight);
  const wanted = new Set(messageIds);

  const doMark = (): number => {
    let marked = 0;
    let files: string[];
    try {
      files = readdirSync(paths.inflight).filter(f => f.endsWith('.json'));
    } catch {
      return 0;
    }
    for (const file of files) {
      const filePath = join(paths.inflight, file);
      try {
        const msg = JSON.parse(readFileSync(filePath, 'utf-8')) as InboxMessage;
        if (!wanted.has(msg.id)) continue;
        atomicWriteSync(filePath, JSON.stringify({
          ...msg,
          injection_confirmed_at: new Date().toISOString(),
        }));
        marked++;
      } catch {
        // Leave the message unconfirmed: ordinary five-minute recovery is the
        // safe fallback when confirmation cannot be persisted.
      }
    }
    return marked;
  };

  try {
    return withFileLockSync(paths.inbox, doMark, { timeoutMs: 2_000 });
  } catch {
    return 0;
  }
}

/**
 * Revalidate selected inflight messages and hold the inbox mutex through their
 * asynchronous PTY injection. ACK writes use the same mutex, so either the ACK
 * linearizes first (the message is filtered out) or delivery linearizes first
 * (the later ACK legitimately acknowledges that delivery).
 */
export function withInboxDeliveryLock<T>(
  paths: BusPaths,
  selected: InboxMessage[],
  deliver: (eligible: InboxMessage[]) => Promise<T>,
): Promise<T> {
  ensureDir(paths.inbox);
  ensureDir(paths.inflight);
  return withFileLockAsync(paths.inbox, async () => {
    reconcileAckReceipts(paths);
    const inflightIds = new Set<string>();
    for (const file of readdirSync(paths.inflight).filter(f => f.endsWith('.json'))) {
      try {
        const msg = JSON.parse(readFileSync(join(paths.inflight, file), 'utf-8')) as InboxMessage;
        inflightIds.add(msg.id);
      } catch {
        // Unrelated corrupt records are handled by the ordinary queue path.
      }
    }
    return deliver(selected.filter(msg => inflightIds.has(msg.id)));
  }, { timeoutMs: 2_000 });
}

/**
 * Durably acknowledge a message from any queue state.
 *
 * The receipt is persisted before queue reconciliation, so a concurrent
 * recovery/move or process crash cannot turn a successful ACK into a later
 * redelivery.
 *
 * Takes the same inbox lock as checkInbox (cross-review HIGH #3): the
 * fast-checker's recoverStaleInflight and the agent's CLI ack run in
 * separate processes and both move files out of inflight/. Unlocked, the
 * interleaving "recover wins, ack ENOENTs silently" re-delivered a
 * message the agent had already handled. Receipt creation and queue mutation
 * happen under that shared lock, so a lock timeout fails loudly without an
 * unsafe unlocked fallback; the caller can retry the ACK without ambiguity.
 */
export type AckInboxResult = 'acked' | 'already-acked' | 'not-found';

export function ackInbox(paths: BusPaths, messageId: string): AckInboxResult {
  const { inbox, inflight, processed } = paths;
  ensureDir(inbox);
  ensureDir(inflight);
  const requestedAckAt = new Date().toISOString();

  const doAck = (): AckInboxResult => {
    // Persist intent before mutating queue records, but under the same lock as
    // delivery selection + PTY submission. This makes ACK-vs-delivery order
    // unambiguous while retaining receipt-first crash recovery.
    const { acked_at: ackedAt } = writeAckReceipt(paths, messageId, requestedAckAt);
    // Search every authoritative queue state under the SAME inbox lock.
    // A stale recovery can move inflight -> inbox immediately before an ACK,
    // and the retry cap can park inflight -> processed before a long-running
    // agent turn gets to send its reply. Restricting ACK to inflight made both
    // cases silent no-ops even though the CLI printed "ACK'd".
    for (const dir of [inflight, inbox, processed]) {
      let files: string[];
      try {
        files = readdirSync(dir).filter(f => f.endsWith('.json'));
      } catch {
        continue;
      }

      for (const file of files) {
        const sourcePath = join(dir, file);
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(readFileSync(sourcePath, 'utf-8')) as Record<string, unknown>;
        } catch {
          // An unrelated corrupt record must not prevent ACKing the requested
          // ID. Once a record parses and matches, persistence errors below are
          // deliberately allowed to propagate to the CLI.
          continue;
        }
        if (msg.id !== messageId) continue;
        if (msg.acknowledged === true && typeof msg.acked_at === 'string') {
          return 'already-acked';
        }

        markMessageAcknowledged(sourcePath, join(processed, file), msg, ackedAt);
        return 'acked';
      }
    }
    return 'not-found';
  };

  return withFileLockSync(inbox, doAck, { timeoutMs: 2_000 });
}

interface AckReceipt {
  id: string;
  acked_at: string;
}

class InvalidAckReceiptError extends Error {}

function ackReceiptPath(paths: BusPaths, messageId: string): string {
  const digest = createHash('sha256').update(messageId).digest('hex');
  return join(paths.stateDir, 'message-acks', `${digest}.json`);
}

function writeAckReceipt(paths: BusPaths, messageId: string, ackedAt: string): AckReceipt {
  const path = ackReceiptPath(paths, messageId);
  try {
    const existing = readAckReceipt(paths, messageId);
    if (existing) return existing; // preserve the first valid ACK time
  } catch (err) {
    // A new explicit ACK is authoritative and may repair a syntactically
    // corrupt receipt. Real I/O/permission failures still propagate.
    if (!(err instanceof InvalidAckReceiptError)) throw err;
  }
  const receipt = { id: messageId, acked_at: ackedAt } satisfies AckReceipt;
  durableAtomicWriteSync(path, JSON.stringify(receipt));
  return receipt;
}

function readAckReceipt(paths: BusPaths, messageId: string): AckReceipt | null {
  let raw: string;
  try {
    raw = readFileSync(ackReceiptPath(paths, messageId), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    throw new InvalidAckReceiptError(
      `Malformed ACK receipt for ${messageId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !('id' in parsed) ||
    !('acked_at' in parsed) ||
    parsed.id !== messageId ||
    typeof parsed.acked_at !== 'string'
  ) {
    throw new InvalidAckReceiptError(`Invalid ACK receipt fields for ${messageId}`);
  }
  return { id: parsed.id, acked_at: parsed.acked_at };
}

function markMessageAcknowledged(
  sourcePath: string,
  destinationPath: string,
  msg: Record<string, unknown>,
  ackedAt: string,
): void {
  durableAtomicWriteSync(destinationPath, JSON.stringify({
    ...msg,
    acknowledged: true,
    acked_at: ackedAt,
  }));
  if (sourcePath !== destinationPath) durableUnlinkSync(sourcePath);
}

/** Called only while checkInbox holds the inbox mutex. */
function reconcileAckReceipts(paths: BusPaths): void {
  for (const dir of [paths.inflight, paths.inbox, paths.processed]) {
    let files: string[];
    try {
      files = readdirSync(dir).filter(f => f.endsWith('.json'));
    } catch {
      continue;
    }

    for (const file of files) {
      const sourcePath = join(dir, file);
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(readFileSync(sourcePath, 'utf-8')) as Record<string, unknown>;
      } catch {
        // Corrupt queue files remain for normal .errors handling.
        continue;
      }
      if (typeof msg.id !== 'string') continue;
      if (msg.acknowledged === true && typeof msg.acked_at === 'string') continue;
      const receipt = readAckReceipt(paths, msg.id);
      if (!receipt) continue;
      // Never continue into stale recovery if a matching receipt exists but
      // its processed state cannot be persisted. Throwing aborts this poll and
      // preserves the source record for a later safe reconciliation.
      markMessageAcknowledged(sourcePath, join(paths.processed, file), msg, receipt.acked_at);
    }
  }
}

function pruneAckReceipts(paths: BusPaths): void {
  const dir = join(paths.stateDir, 'message-acks');
  let files: string[];
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch {
    return;
  }
  const cutoff = Date.now() - ACK_RECEIPT_RETENTION_MS;
  for (const file of files) {
    try {
      const path = join(dir, file);
      if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
    } catch {
      // Best-effort bounded cleanup; delivery correctness is unaffected.
    }
  }
}

/**
 * Maximum number of stale-inflight recoveries (= redelivery attempts) per
 * message before it is parked. Each recovery re-injects the message into
 * the session; a message that has been delivered MAX+1 times without an
 * ACK is either being ignored or the agent's ACK discipline is broken —
 * keeping it looping adds noise without progress. Parked messages land in
 * processed/ with their redeliveries count intact (auditable) and a LOUD
 * stderr line names them.
 */
export const MAX_REDELIVERIES = 3;

/**
 * A successfully injected message may legitimately sit in inflight while an
 * agent performs a long tool-heavy turn. Five-minute re-injection during that
 * turn only queues duplicate user messages; it does not improve durability.
 * After 30 minutes we retry anyway so a wedged turn cannot suppress delivery
 * forever. MAX_REDELIVERIES remains the final hard cap.
 */
export const ACTIVE_DELIVERY_LEASE_SECONDS = 30 * 60;

/**
 * Stop/turn-completed hooks can fire just before a queued injected message
 * starts its own turn. Give that queue a short window to ACK before treating
 * the prior delivery as abandoned.
 */
export const POST_TURN_ACK_GRACE_SECONDS = 5 * 60;

/** ACK receipts retain a bounded crash-recovery horizon, then self-prune. */
const ACK_RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

interface RecoveryOptions {
  stateDir?: string;
  deferWhileAgentActive?: boolean;
}

/**
 * Recover stale inflight messages (older than thresholdSeconds) back to inbox.
 *
 * Increments a `redeliveries` counter in the message JSON on every
 * recovery. After MAX_REDELIVERIES the message is parked in processedDir
 * instead — loudly. (Dispatch-bug fix 2026-06-07: redelivery is now real —
 * the fast-checker no longer acks at injection time — so an un-ACK'd
 * message would otherwise redeliver every 5 minutes forever.)
 */
function recoverStaleInflight(
  inflightDir: string,
  inboxDir: string,
  thresholdSeconds: number,
  processedDir?: string,
  options: RecoveryOptions = {},
): void {
  const now = Math.floor(Date.now() / 1000);
  let files: string[];
  try {
    files = readdirSync(inflightDir).filter(f => f.endsWith('.json'));
  } catch {
    return;
  }

  for (const file of files) {
    const filePath = join(inflightDir, file);
    try {
      const stat = statSync(filePath);
      const mtime = Math.floor(stat.mtimeMs / 1000);
      if (now - mtime <= thresholdSeconds) continue;

      // Count this recovery on the message so redelivery is bounded.
      let msg: InboxMessage;
      try {
        msg = JSON.parse(readFileSync(filePath, 'utf-8'));
      } catch {
        // Unparseable — recover without a counter (legacy behavior) so a
        // corrupt-but-recoverable file still gets one more chance; the
        // checkInbox read will route it to .errors/ if truly corrupt.
        renameSync(filePath, join(inboxDir, file));
        continue;
      }

      if (
        options.deferWhileAgentActive &&
        typeof msg.injection_confirmed_at === 'string' &&
        Number.isFinite(Date.parse(msg.injection_confirmed_at)) &&
        shouldDeferForActiveAgent(Date.parse(msg.injection_confirmed_at), options.stateDir, now * 1000)
      ) {
        continue;
      }

      const redeliveries = (msg.redeliveries ?? 0) + 1;
      if (processedDir && redeliveries > MAX_REDELIVERIES) {
        // LOUD park — never a silent drop. The message was delivered
        // MAX_REDELIVERIES+1 times without an ACK.
        console.error(
          `[bus/message] REDELIVERY EXHAUSTED: message ${msg.id} from '${msg.from}' ` +
          `redelivered ${MAX_REDELIVERIES}x without ACK — parking in processed/. ` +
          `Text head: ${String(msg.text).slice(0, 120)}`,
        );
        ensureDir(processedDir);
        atomicWriteSync(join(processedDir, file), JSON.stringify({ ...msg, redeliveries, redelivery_exhausted: true }));
        unlinkSync(filePath);
        continue;
      }

      atomicWriteSync(filePath, JSON.stringify({ ...msg, redeliveries }));
      renameSync(filePath, join(inboxDir, file));
    } catch {
      // Ignore stat/move errors
    }
  }
}

/**
 * Infer whether an inflight delivery is still being handled from the durable
 * Stop/turn-completed marker. This survives daemon restarts and works for both
 * Claude hooks and codex-app-server's native turn/completed event.
 */
function shouldDeferForActiveAgent(
  deliveredAtMs: number,
  stateDir: string | undefined,
  nowMs: number,
): boolean {
  if (nowMs - deliveredAtMs > ACTIVE_DELIVERY_LEASE_SECONDS * 1000) {
    return false;
  }

  if (!stateDir) return false;
  const idleFlag = join(stateDir, 'last_idle.flag');
  try {
    const idleAtMs = statSync(idleFlag).mtimeMs;
    // No completion since this delivery: the agent is still processing it (or
    // it is queued behind the current turn), so reinjection would be a dupe.
    if (idleAtMs <= deliveredAtMs) return true;
    // A completion did occur, but the delivery may be the next queued turn.
    // Allow its reply/explicit ACK to land before retrying.
    return nowMs - idleAtMs <= POST_TURN_ACK_GRACE_SECONDS * 1000;
  } catch {
    // No completion marker yet: assume active, bounded by the 30-minute lease.
    return true;
  }
}
