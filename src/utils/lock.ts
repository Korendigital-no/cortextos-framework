import { mkdirSync, rmdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'fs';
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
      // recover it with the same atomic rm+mkdir steal as the dead-pid path.
      if (emptyLockIsStale(lockDir, pidFile)) {
        try {
          rmSync(lockDir, { recursive: true, force: true });
          mkdirSync(lockDir);
          writeFileSync(pidFile, String(process.pid));
          return true;
        } catch {
          // Another process beat us to the steal — let caller retry.
          return false;
        }
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
        try {
          rmSync(lockDir, { recursive: true, force: true });
          mkdirSync(lockDir);
          writeFileSync(pidFile, String(process.pid));
          return true;
        } catch {
          return false;
        }
      }
      return false;
    }

    // Check if process is still alive
    try {
      process.kill(storedPid, 0);
      // Process is alive - lock is held
      return false;
    } catch {
      // Process is dead - stale lock, remove and re-acquire atomically.
      try {
        rmSync(lockDir, { recursive: true, force: true });
        mkdirSync(lockDir);
        writeFileSync(pidFile, String(process.pid));
        return true;
      } catch {
        // Another process beat us to the steal — let caller retry.
        return false;
      }
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
