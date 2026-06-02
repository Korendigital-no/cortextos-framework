/**
 * Tests for the Server Action auth guard (src/lib/require-session.ts) and a
 * source-level invariant that EVERY server action calls it.
 *
 * BACKGROUND: Next.js Server Actions are public HTTP endpoints dispatched on a
 * POST to any App Router route via the `Next-Action` header; their ids leak in
 * the public `/_next/static` bundles, and proxy.ts lets public paths (/login,
 * /offline, /icons) through. So an unauthenticated caller can invoke any action
 * unless the action authenticates itself. React Doctor flagged 23 such actions
 * with no auth check. requireSession() is the fix; these tests guard both the
 * helper's behaviour and the invariant that it is wired into every action so a
 * newly-added action without a guard fails CI.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

// Mock the auth module so the helper test doesn't pull in better-sqlite3.
vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));
import { auth } from '@/lib/auth';
import { requireSession } from '@/lib/require-session';

const mockAuth = auth as unknown as ReturnType<typeof vi.fn>;

describe('requireSession — behaviour', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws Unauthorized when there is no session', async () => {
    mockAuth.mockResolvedValueOnce(null);
    await expect(requireSession()).rejects.toThrow(/unauthorized/i);
  });

  it('throws Unauthorized when the session has no user', async () => {
    mockAuth.mockResolvedValueOnce({ expires: 'soon' });
    await expect(requireSession()).rejects.toThrow(/unauthorized/i);
  });

  it('returns the session when a user is present', async () => {
    const session = { user: { name: 'Vilhelm', id: '1' }, expires: 'later' };
    mockAuth.mockResolvedValueOnce(session);
    await expect(requireSession()).resolves.toEqual(session);
  });
});

describe('server-action auth invariant — every action calls requireSession', () => {
  const ACTIONS_DIR = path.join(__dirname, '..', 'actions');
  // file -> expected number of exported server actions (update when adding actions)
  const FILES: Record<string, number> = {
    'settings.ts': 12,
    'goals.ts': 7,
    'skills.ts': 3,
    'approvals.ts': 1,
  };

  for (const [file, expectedCount] of Object.entries(FILES)) {
    it(`${file}: all ${expectedCount} exported actions call requireSession()`, () => {
      const src = readFileSync(path.join(ACTIONS_DIR, file), 'utf8');
      const actionCount = (src.match(/export async function/g) ?? []).length;
      const guardCount = (src.match(/await requireSession\(\)/g) ?? []).length;

      // The file declares the actions we expect (catches an action added without
      // updating this test) ...
      expect(actionCount).toBe(expectedCount);
      // ... and there is exactly one guard per exported action.
      expect(guardCount).toBe(actionCount);
      // ... and the guard is actually imported.
      expect(src).toMatch(/from '@\/lib\/require-session'/);
    });
  }
});
