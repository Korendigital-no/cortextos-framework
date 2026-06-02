// cortextOS Dashboard - Server Action auth guard
//
// WHY THIS EXISTS: Next.js Server Actions are public HTTP endpoints. They are
// dispatched on a POST to ANY App Router route via the `Next-Action` header
// (keyed by action id, not the URL path), and their ids are discoverable in the
// public `/_next/static` bundles. proxy.ts lets public paths (/login, /offline,
// /icons) through with NextResponse.next(), so an unauthenticated caller can
// POST a server action to a public route and have it execute — the middleware
// redirect never runs for those paths. Next's built-in Origin=Host check only
// blocks cross-site *browser* requests, not a deliberate scripted request.
//
// Therefore EVERY server action that touches data must authenticate itself.
// Do not rely on middleware for server actions. Call requireSession() as the
// first statement of every exported action.

import { auth } from '@/lib/auth';

/**
 * Ensures the caller has a valid authenticated session. Throws on failure so it
 * can be the first line of any server action regardless of that action's return
 * type (data-returning actions and ActionResult-returning actions alike). The
 * thrown error surfaces to the client as a rejected action — an unauthenticated
 * attacker gets nothing.
 */
export async function requireSession() {
  const session = await auth();
  if (!session?.user) {
    throw new Error('Unauthorized');
  }
  return session;
}
