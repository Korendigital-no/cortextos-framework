/**
 * tests/integration/lock-steal-race.test.ts — stale-lock steal double-acquire race
 *
 * Pins the double-acquire race in src/utils/lock.ts stale-lock recovery
 * (codex bycatch, 2026-06-05): two processes could both pass the staleness
 * check on the same stale .lock.d; the loser's rmSync then deleted the
 * WINNER'S fresh lock and both entered the critical section.
 *
 * The repro seeds a stale (crashed-holder) .lock.d, then spawns N real child
 * processes (via tsx, importing the production lock module) that rendezvous
 * on a "go" file and burst into withFileLockSync simultaneously — so the
 * initial acquisitions all funnel through the steal path at once. Each
 * critical section does a deliberately widened read-modify-write on a shared
 * counter AND maintains a holder-flag file:
 *
 *   - any overlap of two critical sections loses a counter increment
 *     (final counter < N * iters), and
 *   - an interloper sees the holder-flag already present (violation log).
 *
 * Pre-fix, the burst makes several children "win" the steal together.
 * Post-fix, recovery is serialized through the .lock.d.steal.d mutex and
 * both invariants hold.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { EMPTY_LOCK_STALE_MS } from '../../src/utils/lock';

const execFileAsync = promisify(execFile);

const REPO_ROOT = join(__dirname, '..', '..');
const LOCK_MODULE = join(REPO_ROOT, 'src', 'utils', 'lock.ts');

const N_CHILDREN = 8;
const ITERS = 15;

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'lock-steal-race-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** Worker source — written to tmp and run with tsx so it uses the REAL lock module. */
function workerSource(): string {
  return `
import { withFileLockSync } from ${JSON.stringify(LOCK_MODULE)};
import { readFileSync, writeFileSync, existsSync, rmSync, appendFileSync } from 'fs';
import { join } from 'path';

const [dir, goFile, readyDir] = process.argv.slice(2);
const counterFile = join(dir, 'counter');
const holderFlag = join(dir, 'holder-flag');
const violationsFile = join(dir, 'violations');

// Signal the test we are booted and parked, then HOT-spin until it drops the
// go file, so all children hit the seeded stale lock within microseconds of
// each other — the steal window is microseconds wide, so a coarse (ms) poll
// would never line them up.
writeFileSync(join(readyDir, 'ready-' + process.pid), '1');
const sab = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(goFile)); // eslint-disable-line no-extra-semi

for (let i = 0; i < ${ITERS}; i++) {
  withFileLockSync(dir, () => {
    if (existsSync(holderFlag)) {
      appendFileSync(violationsFile, 'overlap pid=' + process.pid + ' iter=' + i + '\\n');
    }
    writeFileSync(holderFlag, String(process.pid));
    const v = parseInt(readFileSync(counterFile, 'utf-8'), 10);
    Atomics.wait(sab, 0, 0, 2); // widen the critical section
    writeFileSync(counterFile, String(v + 1));
    rmSync(holderFlag, { force: true });
  }, { timeoutMs: 60_000 });
}
`;
}

describe('stale-lock steal under real multi-process contention', () => {
  it(
    `${N_CHILDREN} processes bursting through a stale lock never overlap critical sections`,
    async () => {
      const workDir = join(tmpRoot, 'work');
      mkdirSync(workDir);
      writeFileSync(join(workDir, 'counter'), '0');

      // Seed a stale (crashed-holder, empty) .lock.d so every child's FIRST
      // acquisition goes through the steal path simultaneously.
      const lockDir = join(workDir, '.lock.d');
      mkdirSync(lockDir);
      const old = (Date.now() - (EMPTY_LOCK_STALE_MS + 60_000)) / 1000;
      utimesSync(lockDir, old, old);

      const workerFile = join(tmpRoot, 'worker.ts');
      writeFileSync(workerFile, workerSource());
      const goFile = join(tmpRoot, 'go');
      const readyDir = join(tmpRoot, 'ready');
      mkdirSync(readyDir);

      const children = Array.from({ length: N_CHILDREN }, () =>
        execFileAsync(
          process.execPath,
          [join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), workerFile, workDir, goFile, readyDir],
          { cwd: REPO_ROOT, timeout: 110_000 },
        ),
      );

      // Wait until EVERY child reports booted-and-parked (tsx boot time varies
      // wildly on loaded CI machines — a fixed sleep would let stragglers miss
      // the contention burst), then fire.
      const { readdirSync } = await import('fs');
      const deadline = Date.now() + 60_000;
      while (readdirSync(readyDir).length < N_CHILDREN) {
        if (Date.now() > deadline) throw new Error('children failed to reach rendezvous in 60s');
        await new Promise((r) => setTimeout(r, 50));
      }
      writeFileSync(goFile, 'go');

      await Promise.all(children);

      const violationsFile = join(workDir, 'violations');
      const violations = existsSync(violationsFile) ? readFileSync(violationsFile, 'utf-8') : '';
      expect(violations).toBe('');

      const counter = parseInt(readFileSync(join(workDir, 'counter'), 'utf-8'), 10);
      expect(counter).toBe(N_CHILDREN * ITERS);

      // Nothing left behind: lock and steal-mutex both released.
      expect(existsSync(lockDir)).toBe(false);
      expect(existsSync(join(workDir, '.lock.d.steal.d'))).toBe(false);
    },
    120_000,
  );
});
