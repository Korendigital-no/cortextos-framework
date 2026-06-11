import { mkdirSync, writeFileSync, readFileSync, rmSync, statSync, renameSync } from 'fs';
import { join } from 'path';

/**
 * Age past which a .lock.d with NO (or corrupt) pid file is considered a
 * crashed-holder artifact rather than a live mid-acquire.
 *
 * The mkdir→writeFileSync gap in acquireLock is two back-to-back syscalls
 * (microseconds); no live holder sits in it for 10 seconds. But a process that
 * dies INSIDE that gap leaves an empty .lock.d that — without this recovery —
 * livelocks every future acquirer forever (incident 2026-06-03/04: builder
 * crashed mid-acquire at 15:15 and check-inbox returned [] for 13 hours).
 */
export const EMPTY_LOCK_STALE_MS = 10_000;

/**
 * True when the lock dir exists, is older than EMPTY_LOCK_STALE_MS, and STILL
 * has no parseable pid — i.e. the holder crashed between mkdir and pid-write
 * (or mid-write), so the pid will never appear and waiting is futile.
 *
 * The pid re-read just before returning narrows the TOCTOU window: a holder
 * that somehow wrote its pid after our first failed read is detected here and
 * left alone (the normal alive-check path will then handle it on retry).
 */
function emptyLockIsStale(lockDir: string, pidFile: string): boolean {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(lockDir).mtimeMs;
  } catch {
    // Lock dir vanished (holder released / another stealer won) — let the
    // caller retry; the next mkdirSync will simply succeed.
    return false;
  }
  if (Date.now() - mtimeMs < EMPTY_LOCK_STALE_MS) return false;

  try {
    const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
    return isNaN(pid); // corrupt pid that never became valid in >10s = same crash class
  } catch {
    return true; // still no pid file after >10s — crashed holder
  }
}

/**
 * Full state of a lock dir, used to re-verify staleness UNDER the steal-mutex
 * and to recover a crashed steal-mutex itself.
 *
 * - 'free'  — dir does not exist (released, or a previous stealer finished)
 * - 'held'  — valid pid belonging to a live process (or too fresh to judge)
 * - 'stale' — dead pid, or no/corrupt pid older than EMPTY_LOCK_STALE_MS
 */
function lockState(lockDir: string, pidFile: string): 'free' | 'held' | 'stale' {
  try {
    statSync(lockDir);
  } catch {
    return 'free';
  }
  let storedPid: number;
  try {
    storedPid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
  } catch {
    storedPid = NaN;
  }
  if (isNaN(storedPid)) {
    // No/corrupt pid: a live holder may be mid-acquire (microsecond gap) —
    // only an OLD empty/corrupt lock is a crashed holder.
    return emptyLockIsStale(lockDir, pidFile) ? 'stale' : 'held';
  }
  try {
    process.kill(storedPid, 0);
    return 'held';
  } catch {
    return 'stale';
  }
}

/**
 * Bounded retries when releasing the steal-mutex in the finally (#76 P2): a
 * transient EPERM/EBUSY on the first rmSync would otherwise orphan the mutex
 * with this process's LIVE pid. We do NOT reap a live-pid mutex (see
 * stealStaleLock — age alone cannot prove a live holder is orphaned; a
 * suspended process can exceed any TTL and resume into a double-acquire), so a
 * persistent failure leaves a residual orphan that only clears when THIS
 * process dies (its pid goes dead → reapable). Retrying makes that residual
 * rare; the residual itself is an accepted, restart-recoverable deadlock —
 * strictly preferable to the double-acquire an age-based reap would reintroduce.
 */
const STEAL_RELEASE_RETRIES = 3;

/** Monotonic per-process counter giving each reap a UNIQUE rename destination
 *  (codex r7 P2): a leftover dir from a failed cleanup can never block a later
 *  reap onto a fixed name. */
let reapSeq = 0;

/**
 * Recover a stale .lock.d, serialized through an exclusive steal-mutex.
 *
 * THE RACE THIS CLOSES (double-acquire): two processes both pass the staleness
 * check on the same stale lock; A steals (rm → mkdir → write pid) and enters
 * the critical section; B's rmSync then deletes A's FRESH lock and B "steals"
 * too — both believe they hold the lock, and A's orphaned acquisition lets a
 * third process in as well.
 *
 * Fix: only the holder of `<lockDir>.steal.d` (atomic mkdirSync — exactly one
 * winner) may perform destructive recovery, and it re-verifies staleness UNDER
 * the mutex. Once re-verified, the stale dir is frozen: its holder is dead (it
 * cannot release), other stealers are locked out of the mutex, and fresh
 * acquirers get EEXIST off the still-existing dir — so the rm cannot hit
 * anyone's live lock. If re-verify says 'free' instead, the rm is SKIPPED and
 * we fall through to a plain mkdir, which races fresh acquirers atomically.
 *
 * A stealer that crashes mid-steal orphans the mutex. An orphan is reaped ONLY
 * when its holder is provably DEAD (lockState 'stale'), and the reap is ATOMIC
 * via renameSync to a UNIQUE destination (#76 P1 + codex r7 P2): only one
 * contender can rename a given source path, so the rm can never hit a freshly
 * recreated mutex, and a leftover dir from a failed cleanup can never block a
 * later reap. We deliberately do NOT reap a LIVE-pid mutex by age (codex r7 P1):
 * a process suspended mid-steal (scheduler stall / wall-clock jump) can exceed
 * any TTL and then resume into a double-acquire — age alone cannot prove a live
 * holder is orphaned. The residual (a live-pid orphan from a failed cleanup)
 * self-heals when that process dies (pid → dead → reapable) and is an accepted
 * rare restart-recoverable deadlock — never a correctness (double-acquire) bug.
 *
 * Returns true if the lock was acquired; false to let the caller back off and
 * retry (mutex contention, reaped-crashed-mutex, or lock no longer stale).
 *
 * Exported for tests.
 */
export function stealStaleLock(lockDir: string, pidFile: string): boolean {
  const stealDir = lockDir + '.steal.d';
  const stealPidFile = join(stealDir, 'pid');

  try {
    mkdirSync(stealDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    // Another stealer holds the mutex, or one orphaned it. We do NOT do a racy
    // check-then-rmSync here (#76 P1): two contenders could both classify the
    // mutex stale, and one rmSync could then delete a mutex a third contender
    // freshly recreated in the gap, reopening the double-acquire race.
    //
    // Reap ONLY a mutex whose holder is provably DEAD (codex r7 P1: age cannot
    // prove a live holder is orphaned — a suspended process can exceed any TTL
    // then resume into a double-acquire). Reap ATOMICALLY: rename the orphan to
    // a UNIQUE destination (codex r7 P2: a leftover from a failed cleanup can't
    // block a later reap), so only one contender claims the specific instance;
    // the rest get ENOENT and back off, and the rm can never hit a fresh mutex.
    if (lockState(stealDir, stealPidFile) === 'stale') {
      const reapDir = `${stealDir}.reap.${process.pid}.${reapSeq++}`;
      try {
        rmSync(reapDir, { recursive: true, force: true }); // clear any leftover (failed prior cleanup / pid reuse)
        renameSync(stealDir, reapDir);                      // atomic claim of THIS instance
        rmSync(reapDir, { recursive: true, force: true });  // remove the claimed dead orphan
      } catch {
        // Lost the claim (ENOENT — another contender already renamed/reaped it)
        // or a transient FS error: back off and let the retry path re-evaluate.
      }
    }
    return false;
  }

  try {
    writeFileSync(stealPidFile, String(process.pid));
    // Re-verify under the mutex: the lock we observed as stale may have been
    // recovered by a previous mutex holder and could now be live.
    const state = lockState(lockDir, pidFile);
    if (state === 'held') return false;
    if (state === 'stale') {
      // Frozen (see above) — safe to remove.
      rmSync(lockDir, { recursive: true, force: true });
    }
    // 'free' (or just-removed): plain atomic acquire. EEXIST here means a
    // fresh acquirer got in first — back off, do NOT rm again.
    mkdirSync(lockDir);
    writeFileSync(pidFile, String(process.pid));
    return true;
  } catch (err) {
    // Same contract as acquireLock: only EEXIST means contention (a fresh
    // acquirer beat us to the recreated lock). EPERM / ENOSPC / EROFS are
    // real filesystem failures — propagate so withFileLockSync surfaces the
    // error instead of silently spinning to timeout.
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    return false;
  } finally {
    // Release the steal-mutex with BOUNDED RETRIES (#76 P2). Must NOT throw: an
    // exception out of a finally would replace the function's result and crash
    // the caller's retry loop. If every retry fails (persistent EPERM/EBUSY) the
    // mutex is orphaned with our LIVE pid; we deliberately do NOT age-reap a
    // live-pid mutex (that reopens the double-acquire — codex r7 P1), so this
    // residual clears only when this process dies (pid → dead → reapable). That
    // is an accepted, rare, restart-recoverable deadlock — strictly preferable
    // to corruption; retrying here makes it rare. Do NOT "fix" the residual by
    // reintroducing an age-based or check-then-rm reap of a live-pid mutex.
    for (let i = 0; i < STEAL_RELEASE_RETRIES; i++) {
      try {
        rmSync(stealDir, { recursive: true, force: true });
        break;
      } catch {
        // transient (EPERM/EBUSY) — retry; never throw out of finally
      }
    }
  }
}

/**
 * Acquire a mutex lock using mkdir (atomic on all filesystems).
 * Matches the bash pattern: mkdir .lock.d with PID tracking.
 *
 * Returns true if lock acquired, false if another process holds it.
 * Automatically recovers stale locks (dead process).
 */
export function acquireLock(dir: string): boolean {
  const lockDir = join(dir, '.lock.d');
  const pidFile = join(lockDir, 'pid');

  try {
    mkdirSync(lockDir);
    writeFileSync(pidFile, String(process.pid));
    return true;
  } catch (err) {
    // Only EEXIST means contention. EACCES / ENOSPC / EROFS / etc. are real
    // filesystem failures — propagate so the caller (withFileLockSync) does
    // not loop forever against a directory that will never be writable.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') {
      throw err;
    }
    // mkdirSync failed with EEXIST — another process holds (or is mid-acquire
    // of) the lock.  We must NOT treat the gap between mkdirSync and
    // writeFileSync as "stale" — doing so allows two acquirers to interleave
    // and BOTH believe they hold the lock (the actual race that broke iter
    // 12).  When the PID file is missing, the holder is mid-acquire; the
    // caller should retry.
    let storedPidRaw: string;
    try {
      storedPidRaw = readFileSync(pidFile, 'utf-8').trim();
    } catch {
      // PID file not yet written.  EITHER the holder is mid-acquire (the gap
      // is microseconds — refuse and let the caller retry) OR it crashed in
      // that gap, in which case the pid will NEVER appear and refusing forever
      // livelocks every waiter (the 2026-06-03/04 inbox incident).  An empty
      // .lock.d older than EMPTY_LOCK_STALE_MS cannot be a live mid-acquire —
      // recover it through the serialized steal-mutex.
      if (emptyLockIsStale(lockDir, pidFile)) {
        return stealStaleLock(lockDir, pidFile);
      }
      return false;
    }

    const storedPid = parseInt(storedPidRaw, 10);
    if (isNaN(storedPid) || storedPidRaw === '') {
      // Corrupt PID file.  Same crash class as the empty dir: if it has been
      // corrupt for longer than any live mid-write could explain, the writer
      // died and no future pass will ever make it valid — recover.  Fresh
      // corruption gets the benefit of the doubt (caller retries).
      if (emptyLockIsStale(lockDir, pidFile)) {
        return stealStaleLock(lockDir, pidFile);
      }
      return false;
    }

    // Check if process is still alive
    try {
      process.kill(storedPid, 0);
      // Process is alive - lock is held
      return false;
    } catch {
      // Process is dead — stale lock; recover through the serialized
      // steal-mutex (a bare rm+mkdir+write here is the double-acquire race).
      return stealStaleLock(lockDir, pidFile);
    }
  }
}

/**
 * Release a mutex lock.
 */
export function releaseLock(dir: string): void {
  const lockDir = join(dir, '.lock.d');
  try {
    rmSync(lockDir, { recursive: true, force: true });
  } catch {
    // Ignore errors on release
  }
}

/**
 * Inter-process lock options for `withFileLockSync`.
 */
export interface FileLockOptions {
  /** Total time to wait for the lock before throwing. Default 5000ms. */
  timeoutMs?: number;
  /** First retry delay; doubles up to maxBackoffMs. Default 5ms. */
  initialBackoffMs?: number;
  /** Cap on retry delay. Default 100ms. */
  maxBackoffMs?: number;
}

// SharedArrayBuffer + Atomics.wait gives us a clean cross-thread sleep
// from sync code without spinning the CPU.  One module-scoped buffer is
// reused across calls; we never write to it (only sleep on a wait that
// always times out at `ms`).
const SLEEP_SAB  = new SharedArrayBuffer(4);
const SLEEP_VIEW = new Int32Array(SLEEP_SAB);

/**
 * Acquire `dir`'s mutex, run `fn`, then release the lock — even if `fn`
 * throws.  Retries with exponential backoff (capped) until `timeoutMs`.
 *
 * Use this around any read-modify-write sequence on a per-agent file
 * (crons.json etc.) so two concurrent processes can't lose each other's
 * mutations between the read and the write (the atomic rename in
 * writeCrons is per-write only — it does NOT make the surrounding
 * read-modify-write transactional).
 *
 * @throws if the lock cannot be acquired within `timeoutMs`.
 */
export function withFileLockSync<T>(
  dir: string,
  fn: () => T,
  opts: FileLockOptions = {},
): T {
  const timeoutMs    = opts.timeoutMs        ?? 5_000;
  const initBackoff  = opts.initialBackoffMs ?? 5;
  const maxBackoff   = opts.maxBackoffMs     ?? 100;

  // Use process.hrtime.bigint() instead of Date.now() so the timeout works
  // under vi.useFakeTimers() (which freezes Date.now).  hrtime reads the
  // monotonic clock via syscall and is not stubbed by fake-timer libraries.
  const start = process.hrtime.bigint();
  const timeoutNs = BigInt(timeoutMs) * 1_000_000n;
  let backoff = initBackoff;

  while (!acquireLock(dir)) {
    if (process.hrtime.bigint() - start > timeoutNs) {
      throw new Error(
        `withFileLockSync: failed to acquire lock on "${dir}" within ${timeoutMs}ms`,
      );
    }
    Atomics.wait(SLEEP_VIEW, 0, 0, backoff);
    backoff = Math.min(backoff * 2, maxBackoff);
  }

  try {
    return fn();
  } finally {
    releaseLock(dir);
  }
}
