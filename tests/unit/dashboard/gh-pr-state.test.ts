import { describe, it, expect, beforeEach, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

function mockSpawnSync(returns: { status: number; stdout?: string; stderr?: string }) {
  const fn = vi.fn().mockReturnValue({
    status: returns.status,
    stdout: returns.stdout ?? '',
    stderr: returns.stderr ?? '',
    pid: 0,
    output: [],
    signal: null,
  });
  vi.doMock('node:child_process', () => ({ spawnSync: fn }));
  vi.doMock('@/lib/content', () => ({ getWebsiteRepoPath: () => '/tmp/fake-website' }));
  return fn;
}

describe('gh-pr-state cache', () => {
  it('returns OPEN when gh reports OPEN', async () => {
    mockSpawnSync({ status: 0, stdout: '{"state":"OPEN"}' });
    const { fetchPrState, _clearCacheForTests } = await import('../../../dashboard/src/lib/gh-pr-state');
    _clearCacheForTests();
    expect(await fetchPrState('https://github.com/o/r/pull/1')).toBe('OPEN');
  });

  it('returns MERGED when gh reports MERGED', async () => {
    mockSpawnSync({ status: 0, stdout: '{"state":"MERGED"}' });
    const { fetchPrState, _clearCacheForTests } = await import('../../../dashboard/src/lib/gh-pr-state');
    _clearCacheForTests();
    expect(await fetchPrState('https://github.com/o/r/pull/2')).toBe('MERGED');
  });

  it('returns CLOSED when gh reports CLOSED', async () => {
    mockSpawnSync({ status: 0, stdout: '{"state":"CLOSED"}' });
    const { fetchPrState, _clearCacheForTests } = await import('../../../dashboard/src/lib/gh-pr-state');
    _clearCacheForTests();
    expect(await fetchPrState('https://github.com/o/r/pull/3')).toBe('CLOSED');
  });

  it('returns UNKNOWN on non-zero gh exit', async () => {
    mockSpawnSync({ status: 1, stderr: 'gh: not authenticated' });
    const { fetchPrState, _clearCacheForTests } = await import('../../../dashboard/src/lib/gh-pr-state');
    _clearCacheForTests();
    expect(await fetchPrState('https://github.com/o/r/pull/4')).toBe('UNKNOWN');
  });

  it('returns UNKNOWN on unparseable stdout', async () => {
    mockSpawnSync({ status: 0, stdout: 'not json at all' });
    const { fetchPrState, _clearCacheForTests } = await import('../../../dashboard/src/lib/gh-pr-state');
    _clearCacheForTests();
    expect(await fetchPrState('https://github.com/o/r/pull/5')).toBe('UNKNOWN');
  });

  it('returns UNKNOWN when state value is unrecognized', async () => {
    mockSpawnSync({ status: 0, stdout: '{"state":"WEIRDSTATE"}' });
    const { fetchPrState, _clearCacheForTests } = await import('../../../dashboard/src/lib/gh-pr-state');
    _clearCacheForTests();
    expect(await fetchPrState('https://github.com/o/r/pull/6')).toBe('UNKNOWN');
  });

  it('caches result for same URL — second call does not shell out again', async () => {
    const spawnMock = mockSpawnSync({ status: 0, stdout: '{"state":"OPEN"}' });
    const { fetchPrState, _clearCacheForTests } = await import('../../../dashboard/src/lib/gh-pr-state');
    _clearCacheForTests();
    await fetchPrState('https://github.com/o/r/pull/7');
    await fetchPrState('https://github.com/o/r/pull/7');
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('separates cache by URL', async () => {
    const spawnMock = mockSpawnSync({ status: 0, stdout: '{"state":"OPEN"}' });
    const { fetchPrState, _clearCacheForTests } = await import('../../../dashboard/src/lib/gh-pr-state');
    _clearCacheForTests();
    await fetchPrState('https://github.com/o/r/pull/8');
    await fetchPrState('https://github.com/o/r/pull/9');
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });
});
