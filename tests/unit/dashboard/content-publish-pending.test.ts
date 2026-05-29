import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pending-sidecar-'));
  process.env.CTX_ROOT = tmpRoot;
  vi.resetModules();
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  delete process.env.CTX_ROOT;
});

describe('content-publish-pending sidecar', () => {
  it('readPending returns empty object when sidecar does not exist', async () => {
    const { readPending } = await import('../../../dashboard/src/lib/content-publish-pending');
    expect(await readPending()).toEqual({});
  });

  it('upsertPending creates sidecar with entry then readPending sees it', async () => {
    const { upsertPending, readPending } = await import('../../../dashboard/src/lib/content-publish-pending');
    await upsertPending({
      'my-post': { prUrl: 'https://github.com/o/r/pull/1', branch: 'blog/x', publishedAt: '2026-05-29T12:00:00Z' },
    });
    const pending = await readPending();
    expect(Object.keys(pending)).toEqual(['my-post']);
    expect(pending['my-post'].prUrl).toBe('https://github.com/o/r/pull/1');
  });

  it('upsertPending merges with existing entries, does not replace', async () => {
    const { upsertPending, readPending } = await import('../../../dashboard/src/lib/content-publish-pending');
    await upsertPending({
      'post-a': { prUrl: 'https://github.com/o/r/pull/1', branch: 'b1', publishedAt: '2026-05-29T12:00:00Z' },
    });
    await upsertPending({
      'post-b': { prUrl: 'https://github.com/o/r/pull/2', branch: 'b2', publishedAt: '2026-05-29T12:01:00Z' },
    });
    const pending = await readPending();
    expect(Object.keys(pending).sort()).toEqual(['post-a', 'post-b']);
  });

  it('deletePending removes only specified slugs', async () => {
    const { upsertPending, readPending, deletePending } = await import('../../../dashboard/src/lib/content-publish-pending');
    await upsertPending({
      'post-a': { prUrl: 'pra', branch: 'a', publishedAt: '2026-05-29T12:00:00Z' },
      'post-b': { prUrl: 'prb', branch: 'b', publishedAt: '2026-05-29T12:01:00Z' },
      'post-c': { prUrl: 'prc', branch: 'c', publishedAt: '2026-05-29T12:02:00Z' },
    });
    await deletePending(['post-a', 'post-c']);
    const pending = await readPending();
    expect(Object.keys(pending)).toEqual(['post-b']);
  });

  it('deletePending no-ops when slug list is empty', async () => {
    const { upsertPending, readPending, deletePending } = await import('../../../dashboard/src/lib/content-publish-pending');
    await upsertPending({
      'post-a': { prUrl: 'pra', branch: 'a', publishedAt: '2026-05-29T12:00:00Z' },
    });
    await deletePending([]);
    const pending = await readPending();
    expect(Object.keys(pending)).toEqual(['post-a']);
  });

  it('deletePending tolerates unknown slugs without touching the file', async () => {
    const { upsertPending, readPending, deletePending } = await import('../../../dashboard/src/lib/content-publish-pending');
    await upsertPending({
      'post-a': { prUrl: 'pra', branch: 'a', publishedAt: '2026-05-29T12:00:00Z' },
    });
    await deletePending(['does-not-exist']);
    const pending = await readPending();
    expect(Object.keys(pending)).toEqual(['post-a']);
  });

  it('readPending returns empty object on corrupt JSON instead of throwing', async () => {
    const { readPending } = await import('../../../dashboard/src/lib/content-publish-pending');
    const fp = path.join(tmpRoot, 'state', 'dashboard', 'content-publish-pending.json');
    await fs.mkdir(path.dirname(fp), { recursive: true });
    await fs.writeFile(fp, '{not valid json', 'utf-8');
    expect(await readPending()).toEqual({});
  });

  it('readPending returns empty object on array (wrong shape)', async () => {
    const { readPending } = await import('../../../dashboard/src/lib/content-publish-pending');
    const fp = path.join(tmpRoot, 'state', 'dashboard', 'content-publish-pending.json');
    await fs.mkdir(path.dirname(fp), { recursive: true });
    await fs.writeFile(fp, '[]', 'utf-8');
    expect(await readPending()).toEqual({});
  });
});
