// cortextOS Dashboard - Auth middleware
// Checks for next-auth session cookie; redirects to /login if missing.
// Cannot import auth.ts directly because it chains to better-sqlite3,
// which is not available in the Edge Runtime.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { jwtVerify, jwtDecrypt } from 'jose';
import { hkdf } from '@panva/hkdf';

// Allowed CORS origins - localhost dev + configured deployment URL + mobile app
// Built once at module load: env-derived origins are validated via `new URL()`,
// malformed values are dropped with a warning, and wildcards are explicitly rejected.
function buildAllowedOrigins(): string[] {
  const staticOrigins = ['http://localhost:3000', 'http://localhost:3001'];
  const envCandidates: Array<[string, string | undefined]> = [
    ['NEXTAUTH_URL', process.env.NEXTAUTH_URL],
    ['DASHBOARD_URL', process.env.DASHBOARD_URL],
    ['MOBILE_APP_ORIGIN', process.env.MOBILE_APP_ORIGIN],
  ];

  const validated: string[] = [];
  for (const [name, raw] of envCandidates) {
    if (!raw) continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed === '*') {
      console.warn(
        `[middleware] Ignoring wildcard CORS origin from ${name}; wildcards are not allowed.`,
      );
      continue;
    }
    try {
      validated.push(new URL(trimmed).origin);
    } catch {
      console.warn(
        `[middleware] Ignoring malformed CORS origin from ${name}: ${JSON.stringify(raw)}`,
      );
    }
  }

  return Array.from(new Set([...staticOrigins, ...validated]));
}

const ALLOWED_ORIGINS: string[] = buildAllowedOrigins();

function getAllowedOrigin(requestOrigin: string | null): string | null {
  if (requestOrigin && ALLOWED_ORIGINS.includes(requestOrigin)) return requestOrigin;
  return null;
}

/**
 * Apply CORS + Vary headers only when the request had a non-empty origin AND
 * we resolved it against the whitelist. Returning `Access-Control-Allow-Origin: null`
 * for unrelated/same-origin requests advertises a permissive policy that some
 * legacy CORS implementations treat as accept-any. Omitting the header is the
 * safer default for non-CORS requests.
 */
function applyCorsHeaders(headers: Headers, allowedOrigin: string | null): void {
  if (!allowedOrigin) return;
  headers.set('Access-Control-Allow-Origin', allowedOrigin);
  headers.set('Vary', 'Origin');
}

/**
 * Public path predicate. Uses segment-exact comparison so `/login` matches
 * `/login` and `/login/<anything>` but NOT `/login-bypass` or `/loginx`.
 */
export function isPublicPath(pathname: string): boolean {
  // Static segment whitelist. `/icons` + `/offline` are PWA assets: the browser
  // fetches them on first load (often from the unauthenticated /login screen) to
  // register the service worker and render the offline shell. Gating them behind
  // auth makes the SW script + manifest resolve to a /login redirect (HTML),
  // which the browser rejects — breaking install/offline. They carry no
  // user data, so they are safe to serve publicly.
  const publicSegments = ['/login', '/api/auth', '/_next', '/icons', '/offline'];
  for (const seg of publicSegments) {
    if (pathname === seg || pathname.startsWith(seg + '/')) return true;
  }
  // Webhook endpoints under /api/crm/webhooks/<provider>
  if (pathname.startsWith('/api/crm/webhooks/')) return true;
  // GAP-0034 (upstream #547 parity): the workflows health probe must be
  // reachable from monitoring contexts (load balancers, watcher crons, external
  // watchdogs) without a session cookie — auth-gating defeats its purpose.
  // Exact match only; everything else under /api/workflows stays gated.
  if (pathname === '/api/workflows/health') return true;
  // Special files — favicon + PWA root assets (service worker + web manifest).
  if (
    pathname === '/favicon.ico' ||
    pathname === '/sw.js' ||
    pathname === '/manifest.webmanifest'
  ) {
    return true;
  }
  return false;
}

/**
 * Reconstruct an Auth.js session-token cookie from its chunked form. When a
 * JWE session exceeds ~4 KB, NextAuth v5 splits it into `<name>.0`, `<name>.1`,
 * ... contiguous integer chunks. The middleware would otherwise miss valid
 * large sessions entirely.
 *
 * Returns the joined value, or null when neither the exact-named cookie nor
 * a `.0` chunk is present.
 */
function readSessionCookie(
  request: NextRequest,
  baseName: string,
): string | null {
  const exact = request.cookies.get(baseName)?.value;
  if (exact) return exact;
  // Check chunked variant
  if (!request.cookies.get(`${baseName}.0`)) return null;
  const parts: string[] = [];
  for (let i = 0; i < 50; i++) {
    const chunk = request.cookies.get(`${baseName}.${i}`)?.value;
    if (chunk === undefined) break; // contiguous-only; stop on first gap
    parts.push(chunk);
  }
  return parts.length > 0 ? parts.join('') : null;
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const requestOrigin = request.headers.get('origin');
  const allowedOrigin = getAllowedOrigin(requestOrigin);

  // Handle CORS preflight requests
  if (request.method === 'OPTIONS') {
    const preflight = new NextResponse(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
      },
    });
    applyCorsHeaders(preflight.headers, allowedOrigin);
    return preflight;
  }

  // Allow public paths
  // Security (H7): SSE endpoints require ?token=<jwt> auth — removed from public whitelist
  if (isPublicPath(pathname)) {
    const response = NextResponse.next();
    applyCorsHeaders(response.headers, allowedOrigin);
    return response;
  }

  // Check for next-auth session token cookie (web dashboard).
  // Validates the JWT via decryption, matching NextAuth v5's JWE scheme.
  // Supports BOTH single-cookie and chunked-cookie variants (NextAuth v5
  // chunks large sessions into authjs.session-token.0, .1, ...).
  let hasSession = false;
  const cookieNames = ['authjs.session-token', '__Secure-authjs.session-token'] as const;
  let sessionCookieName: string | undefined;
  let sessionCookieValue: string | null = null;

  for (const name of cookieNames) {
    const val = readSessionCookie(request, name);
    if (val) {
      sessionCookieName = name;
      sessionCookieValue = val;
      break;
    }
  }

  if (sessionCookieValue && sessionCookieName) {
    const authSecret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
    if (authSecret) {
      try {
        const encryptionKey = await hkdf('sha256', authSecret, sessionCookieName, `Auth.js Generated Encryption Key (${sessionCookieName})`, 64);
        await jwtDecrypt(sessionCookieValue, encryptionKey, {
          clockTolerance: 15,
          keyManagementAlgorithms: ['dir'],
          contentEncryptionAlgorithms: ['A256CBC-HS512', 'A256GCM'],
        });
        hasSession = true;
      } catch {
        hasSession = false;
      }
    }
  }

  // Check for Bearer token (mobile app)
  const authHeader = request.headers.get('Authorization');
  let hasBearerToken = false;

  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    if (token.length > 0) {
      // Mobile JWT secret defaults to AUTH_SECRET only when MOBILE_JWT_SECRET
      // is not configured. Production deployments should set a distinct
      // MOBILE_JWT_SECRET so a compromised mobile token cannot decrypt the
      // dashboard session cookie's JWE (and vice versa).
      const mobileSecret = process.env.MOBILE_JWT_SECRET ?? process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
      if (!mobileSecret) {
        console.error(
          '[proxy] CRITICAL: Bearer token presented but no signing secret configured. Refusing request.',
          { pathname, method: request.method },
        );
        const res = NextResponse.json(
          { error: 'Server misconfiguration: auth secret not configured' },
          { status: 500 },
        );
        applyCorsHeaders(res.headers, allowedOrigin);
        return res;
      }
      try {
        const secret = new TextEncoder().encode(mobileSecret);
        // Tightened: pin algorithm to HS256, require exp + iat, cap age at 24h,
        // and check issuer/audience when configured. Without these, any JWT
        // signed with the shared secret (including no-exp tokens from other
        // contexts) would authenticate protected APIs.
        await jwtVerify(token, secret, {
          algorithms: ['HS256'],
          requiredClaims: ['exp', 'iat'],
          maxTokenAge: '24h',
          clockTolerance: 15,
          ...(process.env.MOBILE_JWT_ISSUER ? { issuer: process.env.MOBILE_JWT_ISSUER } : {}),
          ...(process.env.MOBILE_JWT_AUDIENCE ? { audience: process.env.MOBILE_JWT_AUDIENCE } : {}),
        });
        hasBearerToken = true;
      } catch {
        hasBearerToken = false;
      }
    }
  }

  if (!hasSession && !hasBearerToken) {
    // For API routes, return 401 instead of redirect
    if (pathname.startsWith('/api/')) {
      const res = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      applyCorsHeaders(res.headers, allowedOrigin);
      return res;
    }
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('callbackUrl', pathname);
    return NextResponse.redirect(loginUrl);
  }

  const response = NextResponse.next();
  applyCorsHeaders(response.headers, allowedOrigin);
  // Standard security headers
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'no-referrer');
  if (process.env.NODE_ENV === 'production') {
    response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  return response;
}

export const config = {
  matcher: [
    // Match all routes except static files
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
