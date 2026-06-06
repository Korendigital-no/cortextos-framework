// Dashboard SQLite path resolution — side-effect-free so tests can pin the
// contract without db.ts's module-scope singleton opening a real file.
//
// BUILD DB ISOLATION (task_1780639225902, orthogonal to the switchToWal
// retry in sqlite-wal.ts): `next build` collects page data with parallel
// workers that each evaluate db.ts at module scope. Without CTX_ROOT (CI,
// fresh clones) they used to share one .data/cortextos-default.db, which is
// what made the WAL-transition race reachable at all. Page-data collection
// needs no shared data, so during builds each worker gets its own throwaway
// file (cleaned by the build script, discarded with CI workspaces).
//
// Deliberately a per-process FILE, not :memory: — an in-memory DB skips the
// journal-mode/WAL code path entirely (PRAGMA journal_mode=WAL no-ops to
// "memory"), so builds would stop exercising the exact open sequence
// production runs. The per-run+pid file keeps the code path identical, only
// removes the shared state.
//
// Explicit CTX_ROOT always wins (a build host with a configured root has
// chosen shared state); runtime and dev are byte-for-byte unchanged because
// only the build scripts set the isolation nonce.

import path from 'path';

export interface DbPathEnv {
  /** process.env.CTX_ROOT */
  ctxRoot?: string;
  /** process.env.CTX_INSTANCE_ID */
  instanceId?: string;
  /** process.env.CORTEXTOS_BUILD_DB_ISOLATION — a per-run nonce set ONLY by
   *  the dashboard build scripts (see package.json). Deliberately NOT the CI
   *  env var: CI=true leaks into runtime processes on preview hosts, Docker
   *  images and PM2 shells, and silently switching a RUNTIME's DB path is
   *  exactly the failure this module must never cause. Runtime commands
   *  (next start/dev) never set this. */
  buildIsolationId?: string;
  /** process.pid — isolates parallel build workers within one run */
  pid: number;
}

export function resolveDbPath(env: DbPathEnv, cwd: string): string {
  const instanceId = env.instanceId || 'default';
  // Nonce + pid: the nonce isolates RUNS (pid alone reuses numbers across
  // long-lived CI workspaces and could reopen a stale worker file), the pid
  // isolates parallel workers within the run. Sanitized defensively — it
  // becomes part of a filename. The build script also cleans old
  // *-build-*.db* files so cached workspaces cannot accumulate them.
  const isolationId = (env.buildIsolationId ?? '').trim().replace(/[^a-zA-Z0-9]/g, '');

  // HERMETIC BUILDS (task_1780645402571, 5th member of the env-isolation
  // class): during a build the nonce wins over ctxRoot — DELIBERATE flip of
  // the original "explicit CTX_ROOT always wins" judgment. On the crm-dev
  // host, dashboard/.env.local carries CTX_ROOT and Next auto-loads it into
  // every build worker, so at build time ctxRoot is overwhelmingly
  // dotenv-INJECTED, not chosen — and it pointed 9 page-data workers at the
  // LIVE dashboard DB, running schema-init + migrations against prod on
  // every local build. Builds need no live data (verified: a worktree build
  // with no ctxRoot and no pre-existing DB produces a complete site), so
  // build workers always get the throwaway staging file. Runtime is
  // untouched: no runtime script sets the nonce (pinned by invariant).
  if (isolationId) {
    const isolated = path.join(cwd, '.data', `cortextos-${instanceId}-build-${isolationId}-${env.pid}.db`);
    // One loud line (cross-review LOW): expected noise in build logs (one per
    // worker), ANOMALY flag in server logs — if the nonce ever leaks into a
    // runtime env (e.g. someone adds it to .env.local, which Next also loads
    // at runtime and no source-invariant can pin), the server would silently
    // serve an empty staging DB. This line makes that diagnosable in seconds.
    console.error(`[db-path] build-isolated DB: ${isolated}`);
    return isolated;
  }
  if (env.ctxRoot) {
    return path.join(env.ctxRoot, 'dashboard', `cortextos-${instanceId}.db`);
  }
  return path.join(cwd, '.data', `cortextos-${instanceId}.db`);
}
