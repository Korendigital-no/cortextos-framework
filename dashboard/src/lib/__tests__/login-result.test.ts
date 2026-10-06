import { describe, it, expect } from 'vitest';
import { interpretLoginRedirect, safeCallbackTarget } from '../login-result';

describe('interpretLoginRedirect', () => {
  it('treats a cross-origin success URL as success and stays on this origin', () => {
    // AUTH_URL = tunnel, user logged in from localhost — the regression case.
    const r = interpretLoginRedirect('https://crm-dev.korendigital.no/', '/tasks');
    expect(r).toEqual({ ok: true, target: '/tasks' });
  });

  it('reports wrong credentials from a cross-origin error URL', () => {
    const r = interpretLoginRedirect(
      'https://crm-dev.korendigital.no/login?error=CredentialsSignin&code=credentials',
      null,
    );
    expect(r).toEqual({ ok: false, message: 'Wrong username or password.' });
  });

  it('maps CallbackRouteError to the rate-limit message', () => {
    const r = interpretLoginRedirect('http://localhost:3000/login?error=CallbackRouteError', null);
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ message: expect.stringContaining('Too many attempts') });
  });

  it('passes through unknown error codes', () => {
    expect(interpretLoginRedirect('/login?error=MissingCSRF', null))
      .toEqual({ ok: false, message: 'Sign-in failed: MissingCSRF' });
  });

  it('accepts a relative success URL', () => {
    expect(interpretLoginRedirect('/', null)).toEqual({ ok: true, target: '/' });
  });

  it('fails closed on a missing url', () => {
    expect(interpretLoginRedirect(undefined, '/').ok).toBe(false);
    expect(interpretLoginRedirect('', '/').ok).toBe(false);
  });
});

describe('safeCallbackTarget', () => {
  it('keeps same-origin relative paths', () => {
    expect(safeCallbackTarget('/agents?x=1')).toBe('/agents?x=1');
  });

  it('rejects protocol-relative and absolute URLs', () => {
    expect(safeCallbackTarget('//evil.example')).toBe('/');
    expect(safeCallbackTarget('https://evil.example/')).toBe('/');
  });

  it('defaults to / when absent', () => {
    expect(safeCallbackTarget(null)).toBe('/');
  });
});
