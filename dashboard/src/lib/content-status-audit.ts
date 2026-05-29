// content-status-audit: read-only drift scanner.
//
// "Drift" = a post whose frontmatter declares `status: published` but which
// would NOT actually render publicly via the website blog loader. Causes:
//   - published-but-fails-parse: frontmatter is malformed or violates the
//     loader schema (e.g. missing required `excerpt`/`title`), so the loader
//     skips it and the post silently never appears on the live blog.
//   - published-but-duplicate-slug: two published files resolve to the same
//     slug; the loader dedupes and one is dropped.
//
// This is the detector for the "blog-filter-bug" class: a publish PR ships a
// post that looks published in frontmatter but doesn't reach the public site.
// It is purely read-only — it never writes, commits, or mutates anything.
//
// Detection strategy: the canonical `getAllPosts()` in content.ts SILENTLY
// skips files that fail to parse (it catches + logs, by design, so one bad
// row doesn't crash the whole list). That means a published-but-broken post
// would be invisible to a naive "list published posts" check. So we read the
// raw files ourselves to discover the *intent* (`status: published` in the
// raw frontmatter), then compare against what actually survives the loader's
// parse + dedup pipeline. Anything intended-published that doesn't survive is
// drift.

import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { getAllPosts, getBlogDir } from "@/lib/content";

export type DriftReason =
  | "published-but-fails-parse"
  | "published-but-duplicate-slug"
  | "published-but-missing-required-field";

export interface DriftItem {
  // (reason is a plain string for forward-compat, but values come from
  // DriftReason today.)
  /** Resolved slug, when the file parsed far enough to have one. */
  slug?: string;
  /** Real filename on disk; always present. */
  filename: string;
  /** Machine-readable category. */
  reason: string;
  /** Human-readable detail (parse error message, duplicate partner, etc). */
  detail?: string;
}

export interface ContentStatusAuditReport {
  /** Slugs that are published AND render correctly (the healthy set). */
  published: string[];
  /** Posts intended-published that would NOT render publicly. */
  drift: DriftItem[];
  /** true iff there is zero drift. */
  ok: boolean;
}

const POST_FILE_RE = /\.(mdx?|md)$/;

/** True if a file's RAW frontmatter declares it published, regardless of
 *  whether the rest of the frontmatter is valid. We match the raw `status`
 *  value loosely (string-or-quoted) so even a file that later fails schema
 *  validation still registers its publish intent. */
function rawStatusIsPublished(data: Record<string, unknown>): boolean {
  const s = data?.status;
  return typeof s === "string" && s.trim() === "published";
}

/**
 * Tolerant publish-intent detector for files whose frontmatter is too broken
 * for gray-matter to parse. Scans the fenced `---` block for a top-level
 * `status:` line equal to "published" (quotes / trailing comment tolerated).
 * Used only on the parse-failure path, where a real parse-and-validate is
 * impossible but we still want to surface "this LOOKS published but is broken".
 */
function rawTextDeclaresPublished(raw: string): boolean {
  const fence = raw.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\s*(\r?\n|$)/);
  if (!fence) return false;
  for (const line of fence[1].split(/\r?\n/)) {
    const m = line.match(/^status:\s*(.*)$/);
    if (!m) continue;
    let v = m[1].trim();
    if (!/^["']/.test(v)) v = v.replace(/\s+#.*$/, "").trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    return v === "published";
  }
  return false;
}

async function listRawPostFiles(blogDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(blogDir);
  } catch {
    return [];
  }
  return entries.filter((e) => {
    if (e.startsWith(".")) return false;
    const lower = e.toLowerCase();
    if (lower === "readme.md" || lower === "readme.mdx") return false;
    return POST_FILE_RE.test(e);
  });
}

/**
 * Scan the website blog dir and report status drift. Read-only.
 */
export async function auditContentStatus(): Promise<ContentStatusAuditReport> {
  const blogDir = getBlogDir();
  const files = await listRawPostFiles(blogDir);

  // 1. Discover publish INTENT from raw frontmatter (parse-tolerant).
  const intendedPublished: string[] = [];
  const drift: DriftItem[] = [];
  for (const filename of files) {
    let raw: string;
    try {
      raw = await fs.readFile(path.join(blogDir, filename), "utf-8");
    } catch (err) {
      // Unreadable file — only drift if we somehow can't tell; skip otherwise
      // since we can't establish publish intent.
      void err;
      continue;
    }
    let data: Record<string, unknown> = {};
    try {
      data = matter(raw).data as Record<string, unknown>;
    } catch {
      // gray-matter threw — the YAML is so broken even the frontmatter won't
      // parse. The website loader would ALSO throw and drop the post, so if
      // the raw text shows publish intent this is definitely drift. Detect
      // intent with a tolerant regex on the raw frontmatter block (we can't
      // use the parsed object — there isn't one).
      if (rawTextDeclaresPublished(raw)) {
        drift.push({
          filename,
          reason: "published-but-fails-parse",
          detail: "frontmatter is malformed YAML; the website loader would drop this post",
        });
      }
      continue;
    }
    if (rawStatusIsPublished(data)) {
      intendedPublished.push(filename);
    }
  }

  if (intendedPublished.length === 0) {
    return { published: [], drift: [], ok: true };
  }

  // 2. What actually survives the canonical loader (parse + schema + dedup +
  //    sidecar overlay). getAllPosts silently drops parse/schema failures.
  const loaded = await getAllPosts();
  const renderedPublishedBySlug = new Map<string, string>(); // slug -> filename
  for (const p of loaded) {
    if (p.status === "published") {
      renderedPublishedBySlug.set(p.slug, p.filename);
    }
  }
  // Filenames that survived the loader at all (any status), so we can tell a
  // parse-failure (absent entirely) from a dedup-loss (present under a slug we
  // matched to a different file).
  const survivingFilenames = new Set(loaded.map((p) => p.filename));
  const survivingPublishedFilenames = new Set(
    Array.from(renderedPublishedBySlug.values()),
  );

  // 3. Cross-check each intended-published file.
  // First, detect duplicate slugs among intended-published files by parsing
  // each one's effective slug (frontmatter slug || filename-derived).
  const slugToFiles = new Map<string, string[]>();
  for (const filename of intendedPublished) {
    let slug: string | undefined;
    try {
      const raw = await fs.readFile(path.join(blogDir, filename), "utf-8");
      const data = matter(raw).data as Record<string, unknown>;
      const fmSlug = typeof data.slug === "string" ? data.slug : undefined;
      slug = fmSlug ?? filename.replace(POST_FILE_RE, "");
    } catch {
      slug = undefined;
    }
    if (slug) {
      const arr = slugToFiles.get(slug) ?? [];
      arr.push(filename);
      slugToFiles.set(slug, arr);
    }
  }

  for (const filename of intendedPublished) {
    // Duplicate-slug drift: more than one intended-published file shares this
    // file's slug.
    let mySlug: string | undefined;
    try {
      const raw = await fs.readFile(path.join(blogDir, filename), "utf-8");
      const data = matter(raw).data as Record<string, unknown>;
      const fmSlug = typeof data.slug === "string" ? data.slug : undefined;
      mySlug = fmSlug ?? filename.replace(POST_FILE_RE, "");
    } catch {
      mySlug = undefined;
    }

    if (mySlug && (slugToFiles.get(mySlug)?.length ?? 0) > 1) {
      const partners = (slugToFiles.get(mySlug) ?? []).filter((f) => f !== filename);
      drift.push({
        slug: mySlug,
        filename,
        reason: "published-but-duplicate-slug",
        detail: `slug "${mySlug}" is shared with: ${partners.join(", ")}`,
      });
      continue;
    }

    // Parse/schema drift: intended-published but the loader didn't surface it
    // as a published post. If the file is entirely absent from `loaded`,
    // getAllPosts threw while parsing it (bad/missing required frontmatter).
    // If present but not published, something downgraded it. Either way it
    // won't render as a published post.
    if (!survivingPublishedFilenames.has(filename)) {
      const presentButNotPublished = survivingFilenames.has(filename);
      drift.push({
        slug: mySlug,
        filename,
        reason: presentButNotPublished
          ? "published-but-fails-parse"
          : "published-but-missing-required-field",
        detail: presentButNotPublished
          ? "parsed but not surfaced as published by the loader"
          : "failed loader parse/schema validation (e.g. missing required field)",
      });
    }
  }

  // 4. Healthy published set = intended-published minus drift, reported by slug.
  const driftFilenames = new Set(drift.map((d) => d.filename));
  const published = Array.from(renderedPublishedBySlug.entries())
    .filter(([, filename]) => !driftFilenames.has(filename))
    .map(([slug]) => slug)
    .sort();

  return {
    published,
    drift,
    ok: drift.length === 0,
  };
}
