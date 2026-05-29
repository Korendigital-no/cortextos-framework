/**
 * dashboard/src/lib/__tests__/client-tasks.test.ts
 *
 * Unit tests for the client-task delete mutation helper used by the client
 * detail page. The helper wraps `fetch(DELETE …)` and normalises the result
 * into a discriminated union so the UI can update local state or surface a
 * toast without duplicating fetch/error plumbing.
 *
 * These tests cover the helper's contract — the data layer the UI sits on:
 *   - the correct endpoint + method are hit
 *   - success is reported so the row can be removed from local state
 *   - 404 is idempotent (already-gone counts as success)
 *   - server / network errors are reported so a toast can be shown
 *
 * The helper performs exactly one fetch per call and never fetches on its own,
 * which is what lets the dialog's Cancel path be a true no-op (it simply never
 * calls deleteClientTask).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { deleteClientTask } from '@/lib/client-tasks';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn() as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockFetch() {
  return globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
}

describe('deleteClientTask — endpoint', () => {
  it('issues a DELETE to the correct client/task endpoint', async () => {
    mockFetch().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true }),
    });

    await deleteClientTask('client-1', 'task-9');

    expect(mockFetch()).toHaveBeenCalledTimes(1);
    expect(mockFetch()).toHaveBeenCalledWith(
      '/api/clients/client-1/tasks/task-9',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('url-encodes ids with special characters', async () => {
    mockFetch().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true }),
    });

    await deleteClientTask('a/b', 'c d');

    expect(mockFetch()).toHaveBeenCalledWith(
      '/api/clients/a%2Fb/tasks/c%20d',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});

describe('deleteClientTask — success', () => {
  it('reports ok so the caller can remove the row from local state', async () => {
    mockFetch().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true }),
    });

    const result = await deleteClientTask('client-1', 'task-9');

    expect(result).toEqual({ ok: true });
  });
});

describe('deleteClientTask — idempotency', () => {
  it('treats a 404 (already gone) as success so the row is still removed', async () => {
    mockFetch().mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ error: 'Task not found' }),
    });

    const result = await deleteClientTask('client-1', 'ghost');

    expect(result).toEqual({ ok: true });
  });
});

describe('deleteClientTask — errors surface for a toast', () => {
  it('falls back to a generic message when the body has no error field', async () => {
    mockFetch().mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
    });

    const result = await deleteClientTask('client-1', 'task-9');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/failed|delete/i);
  });

  it('reports a network/exception error without throwing', async () => {
    mockFetch().mockRejectedValueOnce(new Error('network down'));

    const result = await deleteClientTask('client-1', 'task-9');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/network down/i);
  });

  it('survives a non-JSON error body', async () => {
    mockFetch().mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error('not json');
      },
    });

    const result = await deleteClientTask('client-1', 'task-9');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/failed|delete/i);
  });
});
