/**
 * Dashboard DB path resolution + build isolation (task_1780639225902).
 *
 * DEFENSE-IN-DEPTH, orthogonal to the switchToWal fix (PR #65): the WAL
 * retry closes the journal-mode race at the source; this removes the SHARED
 * STATE that made `next build` page-data workers contend on one SQLite file
 * at all. Page-data collection needs no shared data — during builds each
 * worker gets its own throwaway DB file.
 *
 * THE ACTIVATION SIGNAL is an explicit per-run nonce
 * (CORTEXTOS_BUILD_DB_ISOLATION) set ONLY by the dashboard build scripts —
 * deliberately NOT the CI env var. CI=true leaks into runtime processes on
 * preview hosts, Docker images and PM2 shells, and silently switching a
 * RUNTIME's DB path is exactly the failure this module must never cause
 * (codex R1 finding). The nonce also isolates RUNS: pid alone reuses numbers
 * across long-lived CI workspaces and could reopen a stale worker file.
 *
 * Per-process FILE, not :memory:, deliberately: an in-memory DB skips the
 * journal-mode/WAL code path entirely (PRAGMA journal_mode=WAL no-ops to
 * "memory"), so builds would stop exercising the exact open-sequence that
 * production runs.
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { resolveDbPath } from '../../../dashboard/src/lib/db-path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CWD = '/work/site';

describe('resolveDbPath', () => {
  it('honors explicit ctxRoot — isolation nonce is irrelevant there', () => {
    expect(resolveDbPath({ ctxRoot: '/srv/ctx', buildIsolationId: '17499', pid: 42 }, CWD)).toBe(
      path.join('/srv/ctx', 'dashboard', 'cortextos-default.db'),
    );
  });

  it('runtime/dev fallback (no nonce): unchanged .data path, no suffix', () => {
    expect(resolveDbPath({ pid: 42 }, CWD)).toBe(
      path.join(CWD, '.data', 'cortextos-default.db'),
    );
  });

  it('build nonce without ctxRoot: per-run + per-process suffix isolates workers', () => {
    expect(resolveDbPath({ buildIsolationId: '17499', pid: 42 }, CWD)).toBe(
      path.join(CWD, '.data', 'cortextos-default-build-17499-42.db'),
    );
    // distinct workers (same run) -> distinct files
    expect(resolveDbPath({ buildIsolationId: '17499', pid: 43 }, CWD)).not.toBe(
      resolveDbPath({ buildIsolationId: '17499', pid: 42 }, CWD),
    );
    // distinct runs (pid reuse in cached workspace) -> distinct files
    expect(resolveDbPath({ buildIsolationId: '20000', pid: 42 }, CWD)).not.toBe(
      resolveDbPath({ buildIsolationId: '17499', pid: 42 }, CWD),
    );
  });

  it('blank/whitespace nonce means no isolation (env strings are not booleans)', () => {
    for (const id of ['', '   ']) {
      expect(resolveDbPath({ buildIsolationId: id, pid: 42 }, CWD)).toBe(
        path.join(CWD, '.data', 'cortextos-default.db'),
      );
    }
  });

  it('sanitizes the nonce — it becomes part of a filename', () => {
    expect(resolveDbPath({ buildIsolationId: '../..//17 49;9', pid: 7 }, CWD)).toBe(
      path.join(CWD, '.data', 'cortextos-default-build-17499-7.db'),
    );
  });

  it('treats an EMPTY ctxRoot as unset (dotenv-loaded .env.local cannot be un-set, only blanked)', () => {
    // Next.js auto-loads dashboard/.env.local (which carries CTX_ROOT on the
    // crm-dev host) into build workers, and dotenv never overrides an
    // existing env var — so the only way to neutralize it for a CI-like
    // build is CTX_ROOT="". Empty string must mean "no root", giving the
    // fallback + build isolation, never path.join('', ...).
    expect(resolveDbPath({ ctxRoot: '', buildIsolationId: '17499', pid: 42 }, CWD)).toBe(
      path.join(CWD, '.data', 'cortextos-default-build-17499-42.db'),
    );
  });

  it('honors instanceId in all modes', () => {
    expect(resolveDbPath({ instanceId: 'staging', pid: 1 }, CWD)).toBe(
      path.join(CWD, '.data', 'cortextos-staging.db'),
    );
    expect(resolveDbPath({ ctxRoot: '/srv/ctx', instanceId: 'staging', pid: 1 }, CWD)).toBe(
      path.join('/srv/ctx', 'dashboard', 'cortextos-staging.db'),
    );
    expect(resolveDbPath({ instanceId: 'staging', buildIsolationId: '9', pid: 7 }, CWD)).toBe(
      path.join(CWD, '.data', 'cortextos-staging-build-9-7.db'),
    );
  });

  it('source-invariant: db.ts resolves its path through resolveDbPath, no inline derivation, no CI sniffing', () => {
    const src = readFileSync(path.join(REPO_ROOT, 'dashboard/src/lib/db.ts'), 'utf8');
    expect(src, 'db.ts must use resolveDbPath').toMatch(/resolveDbPath\(/);
    expect(src, 'db.ts must not derive the DB filename inline').not.toMatch(
      /`cortextos-\$\{instanceId\}/,
    );
    expect(src, 'db.ts must not branch on process.env.CI (runtime-leak footgun)').not.toMatch(
      /process\.env\.CI\b/,
    );
  });

  it('source-invariant: build scripts set the nonce and clean stale isolation files; runtime scripts do not', () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'dashboard/package.json'), 'utf8'));
    for (const script of ['build', 'build:prod']) {
      expect(pkg.scripts[script], `${script} must set the isolation nonce`).toMatch(
        /CORTEXTOS_BUILD_DB_ISOLATION=/,
      );
      expect(pkg.scripts[script], `${script} must clean stale isolation files`).toMatch(
        /rm -f \.data\/cortextos-\*-build-\*\.db\*/,
      );
    }
    for (const script of ['start', 'start:prod', 'dev']) {
      expect(pkg.scripts[script], `${script} must NOT set the isolation nonce`).not.toMatch(
        /CORTEXTOS_BUILD_DB_ISOLATION/,
      );
    }
  });
});
