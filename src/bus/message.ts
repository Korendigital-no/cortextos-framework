import { readdirSync, readFileSync, renameSync, statSync, existsSync, unlinkSync, utimesSync } from 'fs';
import { join } from 'path';
import type { InboxMessage, Priority, BusPaths } from '../types/index.js';
import { PRIORITY_MAP } from '../types/index.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { acquireLock, releaseLock, withFileLockSync } from '../utils/lock.js';
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
export function checkInbox(paths: BusPaths): InboxMessage[] {
  const { inbox, inflight } = paths;
  ensureDir(inbox);
  ensureDir(inflight);

  // Acquire lock
  if (!acquireLock(inbox)) {
    return [];
  }

  try {
    // Recover stale inflight messages (>5 min old) for redelivery; parks
    // messages that exhausted MAX_REDELIVERIES in processed/ (loudly).
    recoverStaleInflight(inflight, inbox, 300, paths.processed);

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
 * Acknowledge a message by moving it from inflight to processed.
 * Identical to bash ack-inbox.sh behavior.
 *
 * Takes the same inbox lock as checkInbox (cross-review HIGH #3): the
 * fast-checker's recoverStaleInflight and the agent's CLI ack run in
 * separate processes and both move files out of inflight/. Unlocked, the
 * interleaving "recover wins, ack ENOENTs silently" re-delivered a
 * message the agent had already handled. If the lock cannot be acquired
 * within the timeout we ack UNLOCKED rather than lose the ack — the
 * pre-fix behavior, as a degraded fallback.
 */
export function ackInbox(paths: BusPaths, messageId: string): void {
  const { inbox, inflight, processed } = paths;
  ensureDir(processed);

  const doAck = (): void => {
    // Find the file in inflight that contains this message ID
    let files: string[];
    try {
      files = readdirSync(inflight).filter(f => f.endsWith('.json'));
    } catch {
      return;
    }

    for (const file of files) {
      const filePath = join(inflight, file);
      try {
        const content = readFileSync(filePath, 'utf-8');
        const msg = JSON.parse(content);
        if (msg.id === messageId) {
          renameSync(filePath, join(processed, file));
          return;
        }
      } catch {
        // Skip corrupt files
      }
    }
  };

  try {
    withFileLockSync(inbox, doAck, { timeoutMs: 2_000 });
  } catch {
    // Lock unavailable (contention/timeout) — never drop the ack.
    doAck();
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
      let msg: InboxMessage & { redeliveries?: number };
      try {
        msg = JSON.parse(readFileSync(filePath, 'utf-8'));
      } catch {
        // Unparseable — recover without a counter (legacy behavior) so a
        // corrupt-but-recoverable file still gets one more chance; the
        // checkInbox read will route it to .errors/ if truly corrupt.
        renameSync(filePath, join(inboxDir, file));
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
