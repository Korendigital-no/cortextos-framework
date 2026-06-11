import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  acquireLock,
  releaseLock,
  withFileLockSync,
  stealStaleLock,
  EMPTY_LOCK_STALE_MS,
  STEAL_TTL_MS,
} from '../../../src/utils/lock';

/** Backdate a path's mtime so it looks `ageMs` old. */
function backdate(path: string, ageMs: number): void {
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(path, t, t);
}

describe('mkdir-based locking', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-lock-test-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('acquires lock on empty directory', () => {
    expect(acquireLock(testDir)).toBe(true);
    releaseLock(testDir);
  });

  it('prevents double acquire', () => {
    expect(acquireLock(testDir)).toBe(true);
    // Same process, same PID - should fail since lock.d already exists
    // (but our PID check will see it's our own process and succeed)
    // Actually, mkdir will fail because it already exists, then we check PID
    // Since it's our own PID, it sees process alive and returns false
    expect(acquireLock(testDir)).toBe(false);
    releaseLock(testDir);
  });

  it('releases lock correctly', () => {
    expect(acquireLock(testDir)).toBe(true);
    releaseLock(testDir);
    expect(acquireLock(testDir)).toBe(true);
    releaseLock(testDir);
  });
});

// Regression: incident 2026-06-03/04 — a process crashed between mkdirSync(.lock.d)
// and writeFileSync(pid), leaving an EMPTY lock dir. Every later acquirer treated
// it as "holder mid-acquire, retry" forever → check-inbox returned [] for 13 hours.
// An empty .lock.d older than EMPTY_LOCK_STALE_MS cannot be a live mid-acquire
// (the mkdir→write gap is microseconds) and must be recovered.
describe('empty/corrupt .lock.d recovery (crash between mkdir and pid-write)', () => {
  let testDir: string;
  let lockDir: string;
  let pidFile: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-lock-stale-'));
    lockDir = join(testDir, '.lock.d');
    pidFile = join(lockDir, 'pid');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('FRESH empty .lock.d is NOT stolen (holder may be mid-acquire)', () => {
    mkdirSync(lockDir); // no pid yet — a live holder could be between mkdir and write
    expect(acquireLock(testDir)).toBe(false);
    expect(existsSync(lockDir)).toBe(true); // untouched
  });

  it('OLD empty .lock.d (crashed holder) is recovered and the lock acquired', () => {
    mkdirSync(lockDir);
    backdate(lockDir, EMPTY_LOCK_STALE_MS + 5_000);
    expect(acquireLock(testDir)).toBe(true);
    // We now hold it for real: our pid is written.
    expect(readFileSync(pidFile, 'utf-8').trim()).toBe(String(process.pid));
    releaseLock(testDir);
  });

  it('FRESH corrupt (empty) pid file is NOT stolen', () => {
    mkdirSync(lockDir);
    writeFileSync(pidFile, '');
    expect(acquireLock(testDir)).toBe(false);
  });

  it('OLD corrupt pid file is recovered (same crash class: died mid-write)', () => {
    mkdirSync(lockDir);
    writeFileSync(pidFile, 'not-a-pid');
    backdate(lockDir, EMPTY_LOCK_STALE_MS + 5_000);
    backdate(pidFile, EMPTY_LOCK_STALE_MS + 5_000);
    expect(acquireLock(testDir)).toBe(true);
    expect(readFileSync(pidFile, 'utf-8').trim()).toBe(String(process.pid));
    releaseLock(testDir);
  });

  it('an OLD lock dir with a VALID LIVE pid is still respected (no steal)', () => {
    mkdirSync(lockDir);
    writeFileSync(pidFile, String(process.pid)); // our own live pid = live holder
    backdate(lockDir, EMPTY_LOCK_STALE_MS + 5_000);
    backdate(pidFile, EMPTY_LOCK_STALE_MS + 5_000);
    expect(acquireLock(testDir)).toBe(false);
  });

  it('withFileLockSync recovers end-to-end from a crashed-holder empty lock', () => {
    mkdirSync(lockDir);
    backdate(lockDir, EMPTY_LOCK_STALE_MS + 5_000);
    const out = withFileLockSync(testDir, () => 'ran', { timeoutMs: 2_000 });
    expect(out).toBe('ran');
    expect(existsSync(lockDir)).toBe(false); // released cleanly
  });

  it('withFileLockSync still times out against a FRESH empty lock (no premature steal)', () => {
    mkdirSync(lockDir); // fresh — could be a live mid-acquire
    expect(() => withFileLockSync(testDir, () => 'ran', { timeoutMs: 250 }))
      .toThrow(/failed to acquire lock/);
  });

  it('#76 P2: a steal-mutex orphaned with a LIVE pid but aged past STEAL_TTL is reaped (no deadlock)', () => {
    // A stealable stale lock...
    mkdirSync(lockDir);
    backdate(lockDir, EMPTY_LOCK_STALE_MS + 5_000);
    // ...but a prior stealer's finally-cleanup failed, orphaning the steal-mutex
    // with its still-LIVE pid (this process). Aged past STEAL_TTL = provably
    // orphaned despite the live pid — the exact deadlock #76 P2 fixes: the old
    // code saw lockState='held' and never reaped, so recovery hung forever.
    const stealDir = lockDir + '.steal.d';
    mkdirSync(stealDir);
    writeFileSync(join(stealDir, 'pid'), String(process.pid));
    backdate(stealDir, STEAL_TTL_MS + 5_000);

    const out = withFileLockSync(testDir, () => 'ran', { timeoutMs: 3_000 });
    expect(out).toBe('ran');
    expect(existsSync(stealDir)).toBe(false); // orphan reaped, not deadlocked
  });

  it('TTL safety: a FRESH steal-mutex (a live steal in progress) is NOT falsely reaped', () => {
    mkdirSync(lockDir);
    backdate(lockDir, EMPTY_LOCK_STALE_MS + 5_000);
    // A real steal in progress: the mutex is young and its holder is live.
    const stealDir = lockDir + '.steal.d';
    mkdirSync(stealDir);
    writeFileSync(join(stealDir, 'pid'), String(process.pid)); // live pid, fresh mtime
    // Must back off WITHOUT reaping — reaping a live steal would reopen the
    // double-acquire race the whole mechanism closes.
    expect(stealStaleLock(lockDir, pidFile)).toBe(false);
    expect(existsSync(stealDir)).toBe(true); // untouched
  });
});

// Regression: double-acquire race in stale-lock recovery (codex bycatch, 2026-06-05).
// Two processes could both pass the staleness check on the same stale .lock.d;
// the loser's rmSync then deleted the WINNER'S fresh lock, and both entered the
// critical section. Recovery is now serialized through an exclusive steal-mutex
// (.lock.d.steal.d) with staleness re-verified under the mutex.
describe('steal-mutex: serialized stale-lock recovery (double-acquire race)', () => {
  let testDir: string;
  let lockDir: string;
  let pidFile: string;
  let stealDir: string;
  let stealPidFile: string;

  /** Create a stale (crashed-holder, empty) .lock.d. */
  function makeStaleLock(): void {
    mkdirSync(lockDir);
    backdate(lockDir, EMPTY_LOCK_STALE_MS + 5_000);
  }

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-lock-steal-'));
    lockDir = join(testDir, '.lock.d');
    pidFile = join(lockDir, 'pid');
    stealDir = join(testDir, '.lock.d.steal.d');
    stealPidFile = join(stealDir, 'pid');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('steals a stale lock in a single acquireLock call (normal recovery path)', () => {
    makeStaleLock();
    expect(acquireLock(testDir)).toBe(true);
    expect(readFileSync(pidFile, 'utf-8').trim()).toBe(String(process.pid));
    // The steal-mutex must be released after a successful steal.
    expect(existsSync(stealDir)).toBe(false);
    releaseLock(testDir);
  });

  it('while a LIVE stealer holds the steal-mutex, a contender backs off and does NOT touch the stale lock', () => {
    makeStaleLock();
    // Simulate another process mid-steal: live pid in the steal-mutex.
    mkdirSync(stealDir);
    writeFileSync(stealPidFile, String(process.pid)); // our own pid = alive
    expect(acquireLock(testDir)).toBe(false);
    // The stale lock and the other stealer's mutex are both untouched.
    expect(existsSync(lockDir)).toBe(true);
    expect(existsSync(stealDir)).toBe(true);
    expect(readFileSync(stealPidFile, 'utf-8').trim()).toBe(String(process.pid));
  });

  it('a FRESH empty steal-mutex (stealer mid-acquire) is respected, not reaped', () => {
    makeStaleLock();
    mkdirSync(stealDir); // no pid yet — stealer could be between mkdir and write
    expect(acquireLock(testDir)).toBe(false);
    expect(existsSync(stealDir)).toBe(true);
  });

  it('an OLD empty steal-mutex (stealer crashed mid-steal) is reaped; retry then succeeds', () => {
    makeStaleLock();
    mkdirSync(stealDir);
    backdate(stealDir, EMPTY_LOCK_STALE_MS + 5_000);
    // First call reaps the crashed mutex and backs off (caller retries).
    expect(acquireLock(testDir)).toBe(false);
    expect(existsSync(stealDir)).toBe(false);
    // Retry wins the fresh mutex and completes the steal.
    expect(acquireLock(testDir)).toBe(true);
    expect(readFileSync(pidFile, 'utf-8').trim()).toBe(String(process.pid));
    releaseLock(testDir);
  });

  it('a steal-mutex held by a DEAD pid is reaped; retry then succeeds', () => {
    makeStaleLock();
    mkdirSync(stealDir);
    writeFileSync(stealPidFile, '999999999'); // not a live pid
    expect(acquireLock(testDir)).toBe(false);
    expect(existsSync(stealDir)).toBe(false);
    expect(acquireLock(testDir)).toBe(true);
    releaseLock(testDir);
  });

  it('re-verifies under the mutex: a lock replaced by a LIVE holder is NOT stolen', () => {
    // Simulates the original race: we observed a stale lock, but by the time we
    // win the steal-mutex another stealer has already recovered it and now
    // holds a fresh, valid lock. stealStaleLock must back off without rm.
    mkdirSync(lockDir);
    writeFileSync(pidFile, String(process.pid)); // live holder
    expect(stealStaleLock(lockDir, pidFile)).toBe(false);
    expect(existsSync(lockDir)).toBe(true);
    expect(readFileSync(pidFile, 'utf-8').trim()).toBe(String(process.pid));
    expect(existsSync(stealDir)).toBe(false); // mutex released
  });

  it('re-verify "free": lock released before we won the mutex → plain acquire, no rm', () => {
    // The stale lock vanished entirely (previous stealer finished + released).
    // stealStaleLock should just mkdir-acquire (atomic vs fresh acquirers).
    expect(stealStaleLock(lockDir, pidFile)).toBe(true);
    expect(readFileSync(pidFile, 'utf-8').trim()).toBe(String(process.pid));
    expect(existsSync(stealDir)).toBe(false);
    releaseLock(testDir);
  });

  it('a stale lock with a DEAD pid is still stolen through the mutex in one call', () => {
    mkdirSync(lockDir);
    writeFileSync(pidFile, '999999999'); // dead holder
    expect(acquireLock(testDir)).toBe(true);
    expect(readFileSync(pidFile, 'utf-8').trim()).toBe(String(process.pid));
    expect(existsSync(stealDir)).toBe(false);
    releaseLock(testDir);
  });

  it('withFileLockSync recovers end-to-end even when a crashed steal-mutex is also present', () => {
    makeStaleLock();
    mkdirSync(stealDir);
    backdate(stealDir, EMPTY_LOCK_STALE_MS + 5_000);
    const out = withFileLockSync(testDir, () => 'ran', { timeoutMs: 2_000 });
    expect(out).toBe('ran');
    expect(existsSync(lockDir)).toBe(false);
    expect(existsSync(stealDir)).toBe(false);
  });
});
