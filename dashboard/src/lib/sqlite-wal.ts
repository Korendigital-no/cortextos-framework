// Race-safe WAL activation for SQLite databases opened by multiple processes.
//
// THE BUG CLASS (task_1780568342981, reproduced 19/900 in a 6-worker stress
// harness): `PRAGMA journal_mode = WAL` can return SQLITE_BUSY WITHOUT
// consulting the busy handler while another connection holds the exclusive
// lock for the journal-mode transition — busy_timeout does not cover this
// window. Worse, the natural recovery (reading `PRAGMA journal_mode` to see
// whether the other process won) hits the SAME window and throws the same
// uncaught SQLITE_BUSY. In CI this killed `next build` page-data collection
// (3 workers racing to initialize a fresh DB at module eval, PR #58).
//
// THE FIX: retry both the switch and the verification read in a bounded loop.
// The contention window is milliseconds wide, so the first few retries
// almost always succeed; the deadline only bounds pathological cases.
//
// MIRROR: src/bus/sqlite-wal.ts is a deliberate copy of this module
// (the dashboard bundle must not import framework src/). A parity test pins
// the two copies against drift, same convention as the CRM schema mirrors
// guarded by tests/unit/dashboard/schema-drift.test.ts.

/** Structural interface so unit tests can drive the loop with a fake. */
export interface WalCapableDb {
  pragma(sql: string): unknown;
}

export interface SwitchToWalOptions {
  /** Total time budget before giving up. Injectable for fast tests. */
  deadlineMs?: number;
  /** Initial sleep between retries; doubles up to maxBackoffMs. */
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  /** Injectable sleep for deterministic tests. Defaults to a synchronous
   *  Atomics.wait sleep (module-eval callers cannot await). */
  sleep?: (ms: number) => void;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isBusy(err: unknown): boolean {
  return (err as NodeJS.ErrnoException & { code?: string })?.code === 'SQLITE_BUSY';
}

/**
 * Switch the connection's journal mode to WAL, tolerating the
 * concurrent-transition window. Returns when this connection either performed
 * the switch or observed that another process already did. Non-BUSY errors
 * propagate immediately. Throws after deadlineMs of persistent contention.
 */
export function switchToWal(db: WalCapableDb, opts: SwitchToWalOptions = {}): void {
  const deadlineMs = opts.deadlineMs ?? 10_000;
  const initBackoff = opts.initialBackoffMs ?? 5;
  const maxBackoff = opts.maxBackoffMs ?? 50;
  const sleep = opts.sleep ?? sleepSync;

  // hrtime, not Date.now(): monotonic and immune to vi.useFakeTimers()
  // (same precedent as src/utils/lock.ts withFileLockSync).
  const start = process.hrtime.bigint();
  const deadlineNs = BigInt(deadlineMs) * BigInt(1_000_000);
  let backoff = initBackoff;

  for (;;) {
    try {
      db.pragma('journal_mode = WAL');
      return;
    } catch (err) {
      if (!isBusy(err)) throw err;
    }
    // Another process may have completed the switch while we were blocked —
    // but this read can hit the same transition window and return BUSY too,
    // so it gets the same tolerance.
    try {
      const rows = db.pragma('journal_mode') as Array<{ journal_mode: string }>;
      if (rows[0]?.journal_mode === 'wal') return;
    } catch (err) {
      if (!isBusy(err)) throw err;
    }
    if (process.hrtime.bigint() - start > deadlineNs) {
      throw new Error(
        `switchToWal: SQLITE_BUSY persisted past ${deadlineMs}ms — ` +
          `another process appears stuck holding the journal-mode transition lock`,
      );
    }
    sleep(backoff);
    backoff = Math.min(backoff * 2, maxBackoff);
  }
}
