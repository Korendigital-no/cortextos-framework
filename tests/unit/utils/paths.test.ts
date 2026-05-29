import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { homedir } from 'os';
import { join } from 'path';
import { resolvePaths } from '../../../src/utils/paths';

/**
 * resolvePaths is a PURE function of its arguments. It must NOT read
 * process.env.CTX_ROOT itself — the authoritative ctxRoot is resolved once
 * by resolveEnv() (honoring CTX_ROOT + the agent .env) and threaded in by
 * callers as the explicit `ctxRootOverride` argument. Reading the ambient
 * env var inside this resolver would silently redirect writes for any caller
 * that did not opt in (notably the daemon, which deliberately ignores an
 * inherited parent-shell CTX_ROOT), producing split-brain state/IPC roots.
 *
 * Test isolation works because tests set CTX_ROOT, the CLI's resolveEnv()
 * picks it up into env.ctxRoot, and bus.ts threads that into resolvePaths —
 * NOT because resolvePaths reads the env var directly.
 */
describe('resolvePaths', () => {
  const savedCtxRoot = process.env.CTX_ROOT;

  beforeEach(() => {
    delete process.env.CTX_ROOT;
  });

  afterEach(() => {
    if (savedCtxRoot === undefined) delete process.env.CTX_ROOT;
    else process.env.CTX_ROOT = savedCtxRoot;
  });

  it('derives from ~/.cortextos/{instance} when no override is given', () => {
    const paths = resolvePaths('spark', 'default', 'eros-os');
    const expectedRoot = join(homedir(), '.cortextos', 'default');
    expect(paths.ctxRoot).toBe(expectedRoot);
    expect(paths.stateDir).toBe(join(expectedRoot, 'state', 'spark'));
    expect(paths.analyticsDir).toBe(join(expectedRoot, 'orgs', 'eros-os', 'analytics'));
  });

  it('roots all paths at the explicit override (the test-isolation seam)', () => {
    const paths = resolvePaths('spark', 'default', 'eros-os', '/tmp/ctx-isolated-xyz');
    expect(paths.ctxRoot).toBe('/tmp/ctx-isolated-xyz');
    expect(paths.stateDir).toBe(join('/tmp/ctx-isolated-xyz', 'state', 'spark'));
    expect(paths.analyticsDir).toBe(
      join('/tmp/ctx-isolated-xyz', 'orgs', 'eros-os', 'analytics'),
    );
    expect(paths.inbox).toBe(join('/tmp/ctx-isolated-xyz', 'inbox', 'spark'));
    // Crucially, NOT under the user's home dir.
    expect(paths.analyticsDir.startsWith(homedir())).toBe(false);
  });

  it('IGNORES process.env.CTX_ROOT — purity guard (daemon must not be hijacked)', () => {
    process.env.CTX_ROOT = '/tmp/ambient-should-be-ignored';
    const paths = resolvePaths('spark', 'default', 'eros-os');
    // Falls back to homedir-derived, NOT the ambient env var.
    expect(paths.ctxRoot).toBe(join(homedir(), '.cortextos', 'default'));
    expect(paths.ctxRoot).not.toBe('/tmp/ambient-should-be-ignored');
  });

  it('explicit override wins even when CTX_ROOT env is set', () => {
    process.env.CTX_ROOT = '/tmp/from-env';
    const paths = resolvePaths('spark', 'default', 'eros-os', '/tmp/from-override');
    expect(paths.ctxRoot).toBe('/tmp/from-override');
  });

  it('no org → org-scoped dirs root directly at the override', () => {
    const paths = resolvePaths('spark', 'default', undefined, '/tmp/explicit');
    expect(paths.ctxRoot).toBe('/tmp/explicit');
    expect(paths.analyticsDir).toBe(join('/tmp/explicit', 'analytics'));
  });
});
