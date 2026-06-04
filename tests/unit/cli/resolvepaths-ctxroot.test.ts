/**
 * CLI resolvePaths ctxRoot threading (task_1780603297377 + task_1780603297435).
 *
 * THE CLASS (same as the P2 measurement-ctxRoot fix, task_1780542355208):
 * resolvePaths() is a PURE function — it does not read CTX_ROOT. Callers must
 * thread ctxRoot from resolveEnv(); a call without it silently falls back to
 * ~/.cortextos/<instanceId>, which is invisible on prod (where CTX_ROOT equals
 * the fallback) but writes to the WRONG tree under CTX_ROOT-override deploys.
 * notify-agent.ts additionally hand-rolled `join(homedir(), '.cortextos', ...)`
 * for the signal path, and import-agent.ts did the same for agent registration.
 *
 * Pins:
 *  1. BEHAVIOUR — notify-agent CLI with CTX_ROOT set writes the urgent-signal
 *     under CTX_ROOT, and nothing lands under the homedir fallback.
 *  2. SOURCE — both CLI files resolve through resolveEnv, contain no
 *     hand-rolled homedir-ctxRoot derivation, and every resolvePaths() call
 *     threads env.ctxRoot. Scoped to these two files: the bus.ts call sites
 *     are pinned by the P2 fix's own invariant (PR #63, separate branch).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

let savedEnv: Record<string, string | undefined>;
let tmpRoot: string;
let tmpHome: string;
let cwdBefore: string;

beforeEach(() => {
  savedEnv = Object.fromEntries(
    Object.keys(process.env)
      .filter(k => k.startsWith('CTX_'))
      .concat('HOME')
      .map(k => [k, process.env[k]]),
  );
  for (const k of Object.keys(savedEnv)) {
    if (k !== 'HOME') delete process.env[k];
  }
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxroot-override-'));
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fallback-home-'));
  cwdBefore = process.cwd();
  process.chdir(tmpRoot); // no stray .cortextos-env from the repo
  vi.resetModules();
});

afterEach(() => {
  process.chdir(cwdBefore);
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('CTX_') && !(k in savedEnv)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('notify-agent threads CTX_ROOT (behaviour)', () => {
  it('writes the urgent signal under CTX_ROOT, not the homedir fallback', async () => {
    process.env.CTX_ROOT = tmpRoot;
    process.env.HOME = tmpHome; // make the fallback observable and isolated

    const { notifyAgentCommand } = await import('../../../src/cli/notify-agent.js');
    notifyAgentCommand.exitOverride();
    notifyAgentCommand.parse(['target-agent', 'wake up', '--from', 'tester'], { from: 'user' });

    const signalPath = path.join(tmpRoot, 'state', 'target-agent', '.urgent-signal');
    expect(fs.existsSync(signalPath), `signal must land under CTX_ROOT: ${signalPath}`).toBe(true);
    const signal = JSON.parse(fs.readFileSync(signalPath, 'utf8'));
    expect(signal.from).toBe('tester');
    expect(signal.message).toBe('wake up');

    // The OLD bug: signal written under ~/.cortextos/<instance> regardless of
    // CTX_ROOT. Nothing may land under the homedir fallback tree.
    expect(
      fs.existsSync(path.join(tmpHome, '.cortextos')),
      'homedir fallback tree must NOT be created when CTX_ROOT is set',
    ).toBe(false);
  });
});

describe('source-invariant: CLI files thread ctxRoot through resolveEnv', () => {
  const FILES = ['src/cli/notify-agent.ts', 'src/cli/import-agent.ts'];

  it.each(FILES)('%s resolves env via resolveEnv and never hand-rolls ctxRoot', file => {
    const src = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
    expect(src, `${file} must call resolveEnv()`).toMatch(/resolveEnv\(/);
    expect(src, `${file} must not hand-roll the homedir ctxRoot fallback`).not.toMatch(
      /homedir\(\),\s*['"`]\.cortextos['"`]/,
    );
  });

  it.each(FILES)('%s threads env.ctxRoot into every resolvePaths call', file => {
    const src = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
    const calls = src.match(/resolvePaths\([^)]*\)/g) ?? [];
    expect(calls.length, `${file} should still call resolvePaths`).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call, `${file}: ${call} must pass env.ctxRoot as the 4th argument`).toMatch(
        /env\.ctxRoot\s*\)$/,
      );
    }
  });
});
