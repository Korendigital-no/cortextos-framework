// Response-header policy for GET /api/media/[...filepath].
//
// SECURITY (stored-XSS, builder2 WS1 finding #2): the media route serves
// agent-authored and operator-planted files from under allowed roots. Files
// that the browser executes as a document when navigated to directly —
// .html/.htm (text/html) and .svg (image/svg+xml, which can carry inline
// <script>/onload) — are a same-origin stored-XSS vector: they run in the
// dashboard origin and can read session context + hit every API.
//
// Defense is layered and does NOT rely on sanitizing the bytes (we serve them
// verbatim): force download instead of inline, sandbox + null-origin CSP so a
// directly-opened file can neither run script nor reach the network, and
// nosniff so a text/* file can never be MIME-sniffed into an executable type.
// `<img src>`/subresource embedding of images is unaffected (Content-Disposition
// is ignored for subresource loads, and SVG-in-<img> is already script-disabled
// by browsers) — only top-level navigation to active content is neutralized.

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg']);
const INLINE_EXTENSIONS = new Set(['.md', '.html', '.htm', '.txt', '.ts', '.tsx', '.js', '.css', '.sh', '.json', '.csv']);

/** Extensions the browser will execute as a document on direct navigation. */
export const ACTIVE_CONTENT_EXTENSIONS = new Set(['.html', '.htm', '.svg']);

export { IMAGE_EXTENSIONS, INLINE_EXTENSIONS };

/**
 * Build the response headers for a served media file.
 * @param ext lowercased file extension including the dot (e.g. ".svg")
 */
export function mediaResponseHeaders(
  ext: string,
  mimeType: string,
  contentLength: number,
  basename: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': mimeType,
    'Content-Length': String(contentLength),
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
  };

  if (ACTIVE_CONTENT_EXTENSIONS.has(ext)) {
    // Active content: download-only + sandboxed, never inline.
    headers['Content-Disposition'] = `attachment; filename="${basename}"`;
    headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
  } else if (IMAGE_EXTENSIONS.has(ext) || INLINE_EXTENSIONS.has(ext)) {
    headers['Content-Disposition'] = `inline; filename="${basename}"`;
  } else {
    headers['Content-Disposition'] = `attachment; filename="${basename}"`;
  }

  return headers;
}
