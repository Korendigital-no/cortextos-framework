// cortextOS Dashboard - interpret the credentials-callback result on the login page.
//
// Why this exists: the login page used to POST the callback with
// `fetch(..., { redirect: 'follow' })`. NextAuth builds its redirect from
// AUTH_URL, so on a host whose AUTH_URL is the public tunnel
// (https://crm-dev.korendigital.no) a login from http://localhost:3000 was
// redirected cross-origin. fetch() cannot follow a cross-origin redirect
// without CORS, so every attempt — right or wrong password — surfaced as
// "Network error. Please try again." (Vilhelm 2026-10-06).
//
// The page now sends `X-Auth-Return-Redirect: 1`, which makes NextAuth answer
// 200 + JSON `{ url }` instead of a 302 (the same contract next-auth/react's
// signIn() uses). We only ever read the error code from that URL and never
// navigate to its host, so the AUTH_URL origin no longer matters.

export type LoginResult =
  | { ok: true; target: string }
  | { ok: false; message: string };

/**
 * Only same-origin relative paths are allowed as post-login targets: must
 * start with "/" but not "//" (protocol-relative URL → open redirect).
 */
export function safeCallbackTarget(callbackParam: string | null | undefined): string {
  return callbackParam && callbackParam.startsWith('/') && !callbackParam.startsWith('//')
    ? callbackParam
    : '/';
}

/**
 * Map the `url` NextAuth returned (absolute or relative, any host) to a login
 * outcome. An `error` search param means the sign-in was rejected.
 */
export function interpretLoginRedirect(
  returnedUrl: string | null | undefined,
  callbackParam: string | null | undefined,
): LoginResult {
  if (!returnedUrl) {
    return { ok: false, message: 'Sign-in failed: Unknown' };
  }

  let parsed: URL;
  try {
    // Base only matters for relative URLs; the host is never used.
    parsed = new URL(returnedUrl, 'http://localhost');
  } catch {
    return { ok: false, message: 'Sign-in failed: Unknown' };
  }

  const code = parsed.searchParams.get('error');
  if (code) {
    // CallbackRouteError usually means the rate limiter blocked the request.
    const message = code === 'CallbackRouteError'
      ? 'Too many attempts. Please wait a few minutes and try again.'
      : code === 'CredentialsSignin'
        ? 'Wrong username or password.'
        : `Sign-in failed: ${code}`;
    return { ok: false, message };
  }

  return { ok: true, target: safeCallbackTarget(callbackParam) };
}
