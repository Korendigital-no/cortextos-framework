/**
 * Source-invariant: every hook that builds a ctxRoot/state path from
 * homedir() must honor process.env.CTX_ROOT first.
 *
 * Hooks run INSIDE the agent's Claude session, where the daemon injects the
 * authoritative CTX_ROOT. A hook that hardcodes ~/.cortextos/<instance>
 * reads a DIFFERENT tree than the daemon writes for any agent with a
 * non-default CTX_ROOT — e.g. hook-crash-alert missed the .session-refresh
 * marker the daemon wrote via resolvePaths(..., ctxRoot), so every refresh
 * was classified as a crash (the false-positive the marker exists to
 * prevent; upstream #550, task_1780587345408).
 *
 * Scope: src/hooks/ only. The daemon (src/daemon/) intentionally ignores an
 * inherited CTX_ROOT (see the resolvePaths purity note in utils/paths.ts) —
 * do not extend this invariant there.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const HOOKS_DIR = join(__dirname, '..', '..', '..', 'src', 'hooks');

describe('hooks honor CTX_ROOT (source invariant)', () => {
  const hookFiles = readdirSync(HOOKS_DIR).filter((f) => f.endsWith('.ts'));

  it('found hook sources to scan', () => {
    expect(hookFiles.length).toBeGreaterThan(0);
  });

  for (const file of hookFiles) {
    it(`${file}: every homedir()-based .cortextos path is guarded by process.env.CTX_ROOT`, () => {
      const src = readFileSync(join(HOOKS_DIR, file), 'utf-8');
      const offending = src
        .split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(
          ({ line }) =>
            line.includes("homedir(), '.cortextos'") &&
            !line.includes('process.env.CTX_ROOT'),
        );
      expect(
        offending.map(({ n, line }) => `${file}:${n} ${line.trim()}`),
      ).toEqual([]);
    });
  }
});
