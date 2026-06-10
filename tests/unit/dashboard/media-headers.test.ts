/**
 * Media-route header policy (builder2 WS1 security finding #2 — stored XSS).
 *
 * The /api/media route served .html/.htm/.svg with `Content-Disposition: inline`
 * and their active MIME type (text/html, image/svg+xml), so an agent-authored or
 * planted file under an allowed root executed script in the dashboard origin when
 * navigated to directly. This pins the fix: active content is download-only,
 * sandboxed (null-origin CSP), and nosniff is always set.
 */

import { describe, it, expect } from 'vitest';
import {
  mediaResponseHeaders,
  ACTIVE_CONTENT_EXTENSIONS,
} from '../../../dashboard/src/lib/media-headers';

const MIME = {
  '.svg': 'image/svg+xml',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
} as const;

describe('mediaResponseHeaders', () => {
  it('active content (.html/.htm/.svg) is download-only, sandboxed, never inline', () => {
    for (const ext of ['.svg', '.html', '.htm'] as const) {
      const h = mediaResponseHeaders(ext, MIME[ext], 100, `x${ext}`);
      expect(h['Content-Disposition'], `${ext} must be attachment`).toBe(`attachment; filename="x${ext}"`);
      expect(h['Content-Disposition']).not.toContain('inline');
      expect(h['Content-Security-Policy'], `${ext} must be sandboxed`).toBe(
        "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      );
    }
  });

  it('the active-content set is exactly the browser-executable document types', () => {
    expect([...ACTIVE_CONTENT_EXTENSIONS].sort()).toEqual(['.htm', '.html', '.svg']);
  });

  it('nosniff is set on every response (no MIME-sniffing a text file into html)', () => {
    for (const ext of Object.keys(MIME) as (keyof typeof MIME)[]) {
      const h = mediaResponseHeaders(ext, MIME[ext], 100, `x${ext}`);
      expect(h['X-Content-Type-Options'], `${ext} missing nosniff`).toBe('nosniff');
    }
  });

  it('benign images still render inline and carry no sandbox CSP', () => {
    const h = mediaResponseHeaders('.png', MIME['.png'], 100, 'x.png');
    expect(h['Content-Disposition']).toBe('inline; filename="x.png"');
    expect(h['Content-Security-Policy']).toBeUndefined();
  });

  it('inline text types (.md/.txt) stay inline (no regression to download)', () => {
    for (const ext of ['.md', '.txt'] as const) {
      const h = mediaResponseHeaders(ext, MIME[ext], 100, `x${ext}`);
      expect(h['Content-Disposition']).toBe(`inline; filename="x${ext}"`);
    }
  });

  it('unknown types default to attachment, no CSP', () => {
    const h = mediaResponseHeaders('.pdf', MIME['.pdf'], 100, 'x.pdf');
    expect(h['Content-Disposition']).toBe('attachment; filename="x.pdf"');
    expect(h['Content-Security-Policy']).toBeUndefined();
  });
});
