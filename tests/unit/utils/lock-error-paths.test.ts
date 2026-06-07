/**
 * tests/unit/utils/lock-error-paths.test.ts — filesystem-failure paths in
 * stealStaleLock (cross-review findings on the steal-mutex fix).
 *
 * Lives in its own file because it partial-mocks 'fs'; the behavioural lock
 * tests in lock.test.ts run against the real filesystem.
 *
 * Pins two contracts:
 *  1. The finally-release of the steal-mutex is best-effort: an EPERM from
 *     rmSync(stealDir) must NOT escape stealStaleLock (an exception out of a
 *     finally would replace the result and crash withFileLockSync's retry
 *     loop, while permanently orphaning the mutex).
 *  2. Real FS failures inside the steal (EPERM/ENOSPC on the recreate) must
 *     PROPAGATE — same contract as acquireLock — so callers surface the error
 *     instead of silently spinning to timeout. Only EEXIST means contention.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    rmSync: vi.fn(actual.rmSync),
    mkdirSync: vi.fn(actual.mkdirSync),
  };
});

import { rmSync, mkdirSync, mkdtempSync, writeFileSync, existsSync, utimesSync, readFileSync } from 'fs';
import { acquireLock, releaseLock, EMPTY_LOCK_STALE_MS } from '../../../src/utils/lock';

const actualFs = await vi.importActual<typeof import('fs')>('fs');

const mockedRm = vi.mocked(rmSync);
const mockedMkdir = vi.mocked(mkdirSync);

function errnoError(code: string): NodeJS.ErrnoException {
  const e = new Error(code) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

describe('stealStaleLock filesystem-failure paths', () => {
  let testDir: string;
  let lockDir: string;
  let pidFile: string;
  let stealDir: string;

  /** Seed a stale (crashed-holder, empty) .lock.d so acquireLock takes the steal path. */
  function makeStaleLock(): void {
    actualFs.mkdirSync(lockDir);
    const t = (Date.now() - (EMPTY_LOCK_STALE_MS + 60_000)) / 1000;
    utimesSync(lockDir, t, t);
  }

  beforeEach(() => {
    mockedRm.mockImplementation((...args) => actualFs.rmSync(...(args as Parameters<typeof actualFs.rmSync>)));
    mockedMkdir.mockImplementation((...args) => actualFs.mkdirSync(...(args as Parameters<typeof actualFs.mkdirSync>)));
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-lock-errpath-'));
    lockDir = join(testDir, '.lock.d');
    pidFile = join(lockDir, 'pid');
    stealDir = join(testDir, '.lock.d.steal.d');
  });

  afterEach(() => {
    mockedRm.mockImplementation((...args) => actualFs.rmSync(...(args as Parameters<typeof actualFs.rmSync>)));
    mockedMkdir.mockImplementation((...args) => actualFs.mkdirSync(...(args as Parameters<typeof actualFs.mkdirSync>)));
    actualFs.rmSync(testDir, { recursive: true, force: true });
  });

  it('EPERM on the finally-release of the steal-mutex does NOT escape — steal still succeeds', () => {
    makeStaleLock();
    mockedRm.mockImplementation((path, opts) => {
      if (path === stealDir) throw errnoError('EPERM');
      return actualFs.rmSync(path as Parameters<typeof actualFs.rmSync>[0], opts);
    });
    // The steal itself succeeds; the failed mutex cleanup must be swallowed.
    expect(acquireLock(testDir)).toBe(true);
    expect(readFileSync(pidFile, 'utf-8').trim()).toBe(String(process.pid));
    // Cleanup genuinely failed — the orphaned mutex is left for later reaping.
    expect(existsSync(stealDir)).toBe(true);
    releaseLock(testDir);
  });

  it('an orphaned steal-mutex from a failed cleanup is reaped once its holder is gone', () => {
    // Simulate the aftermath of the case above, but with a DEAD holder pid.
    makeStaleLock();
    actualFs.mkdirSync(stealDir);
    writeFileSync(join(stealDir, 'pid'), '999999999');
    expect(acquireLock(testDir)).toBe(false); // reaps the orphan, backs off
    expect(existsSync(stealDir)).toBe(false);
    expect(acquireLock(testDir)).toBe(true); // retry completes the steal
    releaseLock(testDir);
  });

  it('EPERM on the lock recreate PROPAGATES (no silent spin-to-timeout) and the mutex is still released', () => {
    makeStaleLock();
    mockedMkdir.mockImplementation((path, opts) => {
      if (path === lockDir) throw errnoError('EPERM');
      return actualFs.mkdirSync(path as Parameters<typeof actualFs.mkdirSync>[0], opts);
    });
    expect(() => acquireLock(testDir)).toThrow(/EPERM/);
    // finally still ran: the steal-mutex was cleaned up despite the throw.
    expect(existsSync(stealDir)).toBe(false);
  });

  it('EEXIST on the lock recreate means a fresh acquirer won — back off, no throw', () => {
    makeStaleLock();
    mockedMkdir.mockImplementation((path, opts) => {
      if (path === lockDir) throw errnoError('EEXIST');
      return actualFs.mkdirSync(path as Parameters<typeof actualFs.mkdirSync>[0], opts);
    });
    expect(acquireLock(testDir)).toBe(false);
    expect(existsSync(stealDir)).toBe(false); // mutex released
  });
});
