/**
 * switchToWal: race-safe WAL activation (task_1780568342981).
 *
 * THE BUG: `PRAGMA journal_mode = WAL` can return SQLITE_BUSY without
 * consulting the busy handler while another process holds the journal-mode
 * transition lock, and the recovery read of `PRAGMA journal_mode` hits the
 * SAME window. The previous inline guard caught the first BUSY but let the
 * second escape — killing `next build` page-data collection at module eval
 * (CI flake, PR #58 attempt 1; reproduced locally 19/900 in a 6-worker
 * stress harness, every failure at the verification read).
 *
 * These tests drive the retry loop with a fake db — the race itself is
 * timing-dependent, but the loop's CONTRACT is fully deterministic:
 * every (switch outcome, read outcome) sequence the race can produce is
 * enumerated below. Sleeps are injected so nothing here waits real time.
 *
 * Both production copies (src/bus/sqlite-wal.ts and its deliberate mirror
 * dashboard/src/lib/sqlite-wal.ts) are pinned identical by the parity test,
 * and the source-invariant test pins all four production open-sequences
 * (db.ts, crm-db.ts) to USE the helper instead of a bare WAL pragma.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { switchToWal, type WalCapableDb } from '../../../src/bus/sqlite-wal.js';
import { switchToWal as switchToWalDash } from '../../../dashboard/src/lib/sqlite-wal';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function busyError(): Error {
  const err = new Error('database is locked') as Error & { code: string };
  err.code = 'SQLITE_BUSY';
  return err;
}

/** Fake db: scripted outcomes per pragma call, recorded call log. */
function fakeDb(script: {
  switch: Array<'ok' | 'busy' | Error>;
  read: Array<'wal' | 'delete' | 'busy' | Error>;
}): WalCapableDb & { calls: string[] } {
  const switchOutcomes = [...script.switch];
  const readOutcomes = [...script.read];
  const calls: string[] = [];
  return {
    calls,
    pragma(sql: string) {
      if (sql === 'journal_mode = WAL') {
        calls.push('switch');
        const outcome = switchOutcomes.shift() ?? 'busy';
        if (outcome === 'ok') return [{ journal_mode: 'wal' }];
        if (outcome === 'busy') throw busyError();
        throw outcome;
      }
      if (sql === 'journal_mode') {
        calls.push('read');
        const outcome = readOutcomes.shift() ?? 'busy';
        if (outcome === 'busy') throw busyError();
        if (outcome instanceof Error) throw outcome;
        return [{ journal_mode: outcome }];
      }
      throw new Error(`unexpected pragma: ${sql}`);
    },
  };
}

const noSleep = { sleep: () => {} };

describe('switchToWal retry contract', () => {
  it('returns immediately when the switch succeeds first try', () => {
    const db = fakeDb({ switch: ['ok'], read: [] });
    switchToWal(db, noSleep);
    expect(db.calls).toEqual(['switch']);
  });

  it('returns when the verification read shows another process won', () => {
    const db = fakeDb({ switch: ['busy'], read: ['wal'] });
    switchToWal(db, noSleep);
    expect(db.calls).toEqual(['switch', 'read']);
  });

  it('THE REPRODUCED CI FLAKE: read is BUSY too, then a later switch succeeds', () => {
    // worker B: switch BUSY -> read BUSY (the previously-uncaught escape)
    // -> retry -> switch succeeds once A's transition completes.
    const db = fakeDb({ switch: ['busy', 'ok'], read: ['busy'] });
    switchToWal(db, noSleep);
    expect(db.calls).toEqual(['switch', 'read', 'switch']);
  });

  it('survives several full busy/busy rounds before the read sees wal', () => {
    const db = fakeDb({
      switch: ['busy', 'busy', 'busy'],
      read: ['busy', 'busy', 'wal'],
    });
    switchToWal(db, noSleep);
    expect(db.calls).toEqual(['switch', 'read', 'switch', 'read', 'switch', 'read']);
  });

  it('keeps retrying when the read returns a non-wal mode (switch not yet won by anyone)', () => {
    const db = fakeDb({ switch: ['busy', 'ok'], read: ['delete'] });
    switchToWal(db, noSleep);
    expect(db.calls).toEqual(['switch', 'read', 'switch']);
  });

  it('rethrows a non-BUSY switch error immediately, no retries', () => {
    const corruption = Object.assign(new Error('database disk image is malformed'), {
      code: 'SQLITE_CORRUPT',
    });
    const db = fakeDb({ switch: [corruption], read: [] });
    expect(() => switchToWal(db, noSleep)).toThrow(/malformed/);
    expect(db.calls).toEqual(['switch']);
  });

  it('rethrows a non-BUSY read error immediately, no retries', () => {
    const ioerr = Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' });
    const db = fakeDb({ switch: ['busy'], read: [ioerr] });
    expect(() => switchToWal(db, noSleep)).toThrow(/disk I\/O/);
    expect(db.calls).toEqual(['switch', 'read']);
  });

  it('throws a diagnostic error when BUSY persists past the deadline', () => {
    const db = fakeDb({ switch: [], read: [] }); // everything defaults to busy
    expect(() => switchToWal(db, { ...noSleep, deadlineMs: 0 })).toThrow(
      /SQLITE_BUSY persisted past 0ms/,
    );
  });

  it('backoff doubles from initialBackoffMs and caps at maxBackoffMs', () => {
    const sleeps: number[] = [];
    const db = fakeDb({
      switch: ['busy', 'busy', 'busy', 'busy', 'busy', 'ok'],
      read: ['busy', 'busy', 'busy', 'busy', 'busy'],
    });
    switchToWal(db, {
      sleep: ms => sleeps.push(ms),
      initialBackoffMs: 5,
      maxBackoffMs: 50,
    });
    expect(sleeps).toEqual([5, 10, 20, 40, 50]);
  });
});

describe('mirror parity and production usage', () => {
  it('dashboard mirror is code-identical to the framework copy (comments may differ)', () => {
    const strip = (src: string) =>
      src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/\s+/g, ' ')
        .trim();
    const framework = strip(readFileSync(path.join(REPO_ROOT, 'src/bus/sqlite-wal.ts'), 'utf8'));
    const dashboard = strip(
      readFileSync(path.join(REPO_ROOT, 'dashboard/src/lib/sqlite-wal.ts'), 'utf8'),
    );
    expect(dashboard).toBe(framework);
  });

  it('both copies export the same function (smoke: dashboard copy honors the contract)', () => {
    const db = fakeDb({ switch: ['busy', 'ok'], read: ['busy'] });
    switchToWalDash(db, noSleep);
    expect(db.calls).toEqual(['switch', 'read', 'switch']);
  });

  it('production open-sequences use the helper — no bare WAL pragma remains', () => {
    // Closes the class: a third copy of the raced inline guard (or a revert)
    // in either production open-sequence fails here. Scoped to the two
    // open-sequence files — test files may use the bare pragma legitimately.
    for (const file of ['dashboard/src/lib/db.ts', 'src/bus/crm-db.ts']) {
      const src = readFileSync(path.join(REPO_ROOT, file), 'utf8');
      expect(src, `${file} must route WAL activation through switchToWal`).toMatch(
        /switchToWal\(/,
      );
      expect(src, `${file} must not contain a bare journal_mode = WAL pragma`).not.toMatch(
        /pragma\(\s*['"`]journal_mode\s*=\s*WAL/i,
      );
    }
  });
});
