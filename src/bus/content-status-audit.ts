// content-status-audit (framework / CLI side).
//
// Read-only scanner that detects publish "drift": a blog post whose
// frontmatter declares `status: published` but which would NOT render
// publicly on the website (korendigital.no/blog). Causes:
//   - published-but-fails-parse / missing-required-field: the website blog
//     loader requires `title`, `date`, and `excerpt`. A published post missing
//     any of these is skipped by the loader and silently never appears.
//   - published-but-duplicate-slug: two published files resolve to the same
//     slug; the loader dedupes and one is dropped.
//
// This is the CLI twin of dashboard/src/lib/content-status-audit.ts. The
// dashboard cannot be imported here (separate tsconfig rootDir + path alias +
// node_modules; no gray-matter/zod framework-side), so this implementation is
// self-contained and mirrors the website loader's exclusion rules. It is
// intended to be wired as `cortextos bus content-status-audit` and run by a
// cron/CI to catch drift before it reaches the public site.
//
// Blog dir resolution matches dashboard/src/lib/content.ts exactly so both
// surfaces look at the same files:
//   WEBSITE_REPO_PATH env  ||  ~/Desktop/Korendigital/Korendigital/code/korendigital-website
// then  <repo>/content/blog .

import fs from 'fs';
import path from 'path';
import os from 'os';

const DEFAULT_WEBSITE_REPO = path.join(
  os.homedir(),
  'Desktop',
  'Korendigital',
  'Korendigital',
  'code',
  'korendigital-website',
);

export function getWebsiteRepoPath(): string {
  return process.env.WEBSITE_REPO_PATH ?? DEFAULT_WEBSITE_REPO;
}

export function getBlogDir(): string {
  return path.join(getWebsiteRepoPath(), 'content', 'blog');
}

// Keep identical to the website + dashboard loader so the same slug works in
// all three places.
const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const POST_FILE_RE = /\.(mdx?|md)$/;

export type DriftReason =
  | 'published-but-fails-parse'
  | 'published-but-duplicate-slug'
  | 'published-but-missing-required-field'
  | 'published-but-invalid-slug';

export interface DriftItem {
  filename: string;
  slug?: string;
  reason: DriftReason;
  detail?: string;
}

export interface ContentStatusAuditReport {
  published: string[];
  drift: DriftItem[];
  ok: boolean;
}

interface ParsedFrontmatter {
  raw: Record<string, string>;
  ok: boolean; // false if there was no parseable `---` fenced block
}

/**
 * Minimal, dependency-free frontmatter reader. We only need a handful of
 * scalar fields (status, slug, title, excerpt, date) to decide drift, and we
 * intentionally do NOT attempt full YAML — we extract the fenced `---` block
 * and read top-level `key: value` lines, supporting:
 *   - plain scalars:        status: published
 *   - quoted scalars:       date: '2026-05-29'
 *   - block scalars:        excerpt: >-   (folded, continuation lines indented)
 * Nested structures (lists like tags) are skipped — we don't need them.
 *
 * LIMITATION (accepted): this is not a full YAML parser (the framework forbids
 * adding runtime deps like gray-matter/js-yaml — see cortextos/CLAUDE.md). It
 * can therefore accept a small class of subtly-malformed YAML that the
 * website's gray-matter + Zod loader would reject. The dashboard-side twin
 * (dashboard/src/lib/content-status-audit.ts) uses the real loader and catches
 * those. The high-value drift classes — missing required fields, null
 * sentinels, trailing comments, quoted values, invalid/duplicate slugs — are
 * all covered here; an unterminated-quote value is normalized to empty so it
 * trips the required-field check rather than passing as healthy.
 *
 * `present` of a key means the key appeared with a non-empty effective value.
 */
function parseFrontmatter(content: string): ParsedFrontmatter {
  const raw: Record<string, string> = {};
  // Frontmatter must be the first thing in the file, fenced by --- lines.
  const fenceMatch = content.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\s*(\r?\n|$)/);
  if (!fenceMatch) return { raw, ok: false };
  const block = fenceMatch[1];
  const lines = block.split(/\r?\n/);

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Top-level key (no leading whitespace) of form `key:` or `key: value`.
    const m = line.match(/^([A-Za-z0-9_]+):\s?(.*)$/);
    if (!m) {
      i++;
      continue;
    }
    const key = m[1];
    let value = m[2];

    // Block scalar indicators (>, >-, |, |-) → gather indented continuation.
    if (/^[>|][+-]?\s*$/.test(value)) {
      const parts: string[] = [];
      i++;
      while (i < lines.length && (/^\s+/.test(lines[i]) || lines[i] === '')) {
        parts.push(lines[i].trim());
        i++;
      }
      raw[key] = parts.join(' ').trim();
      continue;
    }

    // List indicator (`key:` then indented `- item`) → skip the list body; we
    // don't need list values for drift detection.
    if (value === '') {
      // Peek: if next lines are indented list/map items, consume them.
      let j = i + 1;
      let consumed = false;
      while (j < lines.length && /^\s+/.test(lines[j])) {
        consumed = true;
        j++;
      }
      raw[key] = '';
      i = consumed ? j : i + 1;
      continue;
    }

    value = value.trim();
    // Strip a trailing YAML comment + surrounding quotes, handling both forms:
    //   status: published # note      → published
    //   status: "published" # note    → published
    // For a quoted value, take the quoted span and drop anything after the
    // closing quote (the comment). For an unquoted value, ` #` starts a
    // comment. Without this, a published post could be invisible to the
    // scanner (codex MED + follow-up: quoted-value-plus-comment case).
    const quoted = value.match(/^(["'])(.*?)\1\s*(#.*)?$/);
    if (quoted) {
      value = quoted[2];
    } else if (/^["']/.test(value)) {
      // Opens a quote but never closes it on this line → malformed YAML the
      // real loader would reject. Normalize to empty so required-field checks
      // catch it rather than treating the broken string as a valid value.
      value = '';
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    // YAML null/empty sentinels → empty string, so required-field checks treat
    // `title: null` / `title: ~` the same as a missing title (codex HIGH:
    // gray-matter+Zod would reject these; we must too).
    if (value === 'null' || value === '~' || value === 'Null' || value === 'NULL') {
      value = '';
    }
    raw[key] = value;
    i++;
  }

  return { raw, ok: true };
}

function listPostFiles(blogDir: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(blogDir);
  } catch {
    return [];
  }
  return entries.filter((e) => {
    if (e.startsWith('.')) return false;
    const lower = e.toLowerCase();
    if (lower === 'readme.md' || lower === 'readme.mdx') return false;
    return POST_FILE_RE.test(e);
  });
}

function effectiveSlug(filename: string, fm: Record<string, string>): string {
  const fmSlug = fm.slug && fm.slug.length > 0 ? fm.slug : undefined;
  return fmSlug ?? filename.replace(POST_FILE_RE, '');
}

/**
 * Scan the website blog dir and report status drift. Read-only — never writes.
 */
export function auditContentStatus(): ContentStatusAuditReport {
  const blogDir = getBlogDir();
  const files = listPostFiles(blogDir);

  interface Intended {
    filename: string;
    slug: string;
    fm: Record<string, string>;
    parseOk: boolean;
  }

  const intended: Intended[] = [];
  for (const filename of files) {
    let content: string;
    try {
      content = fs.readFileSync(path.join(blogDir, filename), 'utf-8');
    } catch {
      continue; // unreadable; can't establish intent
    }
    const { raw, ok } = parseFrontmatter(content);
    if (!ok) continue; // no frontmatter at all → not a publish-intent post
    if ((raw.status ?? '').trim() !== 'published') continue;
    intended.push({
      filename,
      slug: effectiveSlug(filename, raw),
      fm: raw,
      parseOk: ok,
    });
  }

  const drift: DriftItem[] = [];
  const healthy: string[] = [];

  // Duplicate-slug detection across intended-published files.
  const slugCounts = new Map<string, string[]>();
  for (const item of intended) {
    const arr = slugCounts.get(item.slug) ?? [];
    arr.push(item.filename);
    slugCounts.set(item.slug, arr);
  }

  for (const item of intended) {
    const partners = (slugCounts.get(item.slug) ?? []).filter((f) => f !== item.filename);
    if (partners.length > 0) {
      drift.push({
        filename: item.filename,
        slug: item.slug,
        reason: 'published-but-duplicate-slug',
        detail: `slug "${item.slug}" shared with: ${partners.join(', ')}`,
      });
      continue;
    }

    // Invalid slug → website loader's slug regex rejects it.
    if (!SLUG_REGEX.test(item.slug) || item.slug.length > 80) {
      drift.push({
        filename: item.filename,
        slug: item.slug,
        reason: 'published-but-invalid-slug',
        detail: `slug "${item.slug}" does not match required pattern`,
      });
      continue;
    }

    // Required-field check (mirror website loader schema: title/date/excerpt).
    const missing: string[] = [];
    if (!item.fm.title || item.fm.title.trim() === '') missing.push('title');
    if (!item.fm.date || item.fm.date.trim() === '') missing.push('date');
    if (!item.fm.excerpt || item.fm.excerpt.trim() === '') missing.push('excerpt');
    if (missing.length > 0) {
      drift.push({
        filename: item.filename,
        slug: item.slug,
        reason: 'published-but-missing-required-field',
        detail: `missing required field(s): ${missing.join(', ')}`,
      });
      continue;
    }

    healthy.push(item.slug);
  }

  return {
    published: healthy.sort(),
    drift,
    ok: drift.length === 0,
  };
}

/**
 * Format an audit report as a concise, human-readable string. NEVER emits raw
 * JSON or markup — org rule against surfacing raw JSON/markup. Returns the
 * full text block ready to print.
 */
export function formatAuditReport(report: ContentStatusAuditReport): string {
  const lines: string[] = [];
  lines.push('Content status audit — published-post drift scan');
  lines.push(`Blog dir: ${getBlogDir()}`);
  lines.push('');
  lines.push(`Published & healthy: ${report.published.length}`);
  if (report.published.length > 0) {
    for (const slug of report.published) lines.push(`  - ${slug}`);
  }
  lines.push('');
  if (report.drift.length === 0) {
    lines.push('Drift: none. All published posts will render publicly.');
  } else {
    lines.push(`Drift detected: ${report.drift.length} post(s) declared published but would NOT render:`);
    for (const d of report.drift) {
      const id = d.slug ? `${d.slug} (${d.filename})` : d.filename;
      const detail = d.detail ? ` — ${d.detail}` : '';
      lines.push(`  ✗ ${id}: ${d.reason}${detail}`);
    }
  }
  return lines.join('\n');
}
