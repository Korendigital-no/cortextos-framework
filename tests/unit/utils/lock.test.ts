import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { acquireLock, releaseLock, withFileLockSync, EMPTY_LOCK_STALE_MS } from '../../../src/utils/lock';

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
});
