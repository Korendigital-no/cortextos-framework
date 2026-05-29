// Content management loader. Reads blog posts from the korendigital-website
// repo on disk (configurable path), parses frontmatter, normalises status.
//
// Status lives in the post's frontmatter — `status: draft | approved | published`.
// Missing status defaults to 'draft'. Writes are atomic (tmp + rename) and
// path-traversal-safe (slug must match a strict regex AND resolved path
// must stay inside the blog dir).

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import matter from "gray-matter";
import { z } from "zod";

const DEFAULT_WEBSITE_REPO = path.join(
  os.homedir(),
  "Desktop",
  "Korendigital",
  "Korendigital",
  "code",
  "korendigital-website",
);

export function getWebsiteRepoPath(): string {
  return process.env.WEBSITE_REPO_PATH ?? DEFAULT_WEBSITE_REPO;
}

export function getBlogDir(): string {
  return path.join(getWebsiteRepoPath(), "content", "blog");
}

const STATUS_VALUES = ["draft", "approved", "published"] as const;
export type ContentStatus = (typeof STATUS_VALUES)[number];

// Slugs are also the URL path on korendigital.no/blog/<slug>; keep the
// regex identical to the website's loader so the same value works in both
// places without rewrite.
export const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const FrontmatterSchema = z.object({
  title: z.string().min(1).max(200),
  date: z.union([z.string(), z.date()]),
  slug: z.string().optional(),
  tags: z.array(z.string()).default([]),
  author: z.string().default("vilhelm"),
  excerpt: z.string().min(1).max(500),
  ogImage: z.string().optional(),
  status: z.enum(STATUS_VALUES).default("draft"),
});

export type PostFrontmatter = z.infer<typeof FrontmatterSchema>;

export interface ContentPost {
  slug: string;
  filename: string;     // <slug>.md or <slug>.mdx (real filename on disk)
  title: string;
  date: string;          // ISO YYYY-MM-DD
  tags: string[];
  author: string;
  excerpt: string;
  ogImage?: string;
  status: ContentStatus;
  body: string;
  wordCount: number;
  /** Open PR URL if this post is "published" via the sidecar (PR awaiting merge). */
  pendingPrUrl?: string;
}

function toIsoDate(d: string | Date): string {
  if (typeof d === "string") return d;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function slugFromFile(filename: string): string {
  const base = filename.replace(/\.(mdx?|md)$/, "");
  if (!SLUG_REGEX.test(base) || base.length > 80) {
    throw new Error(`Invalid filename → slug: ${filename}`);
  }
  return base;
}

async function listPostFiles(): Promise<string[]> {
  try {
    const entries = await fs.readdir(getBlogDir());
    return entries.filter((e) => {
      if (e.startsWith(".")) return false;
      if (e.toLowerCase() === "readme.md" || e.toLowerCase() === "readme.mdx") return false;
      return e.endsWith(".mdx") || e.endsWith(".md");
    });
  } catch {
    return [];
  }
}

async function loadPostFromFile(filename: string): Promise<ContentPost> {
  const filepath = path.join(getBlogDir(), filename);
  const raw = await fs.readFile(filepath, "utf-8");
  const parsed = matter(raw);
  const fm = FrontmatterSchema.parse(parsed.data);
  return {
    slug: fm.slug ?? slugFromFile(filename),
    filename,
    title: fm.title,
    date: toIsoDate(fm.date),
    tags: fm.tags,
    author: fm.author,
    excerpt: fm.excerpt,
    ogImage: fm.ogImage,
    status: fm.status,
    body: parsed.content,
    wordCount: parsed.content.trim().split(/\s+/).filter(Boolean).length,
  };
}

export async function getAllPosts(): Promise<ContentPost[]> {
  const files = await listPostFiles();
  const posts: ContentPost[] = [];
  for (const f of files) {
    try {
      posts.push(await loadPostFromFile(f));
    } catch (err) {
      // Surface bad-frontmatter rows in the UI rather than crashing the whole list.
      console.error(`[content] Failed to parse ${f}:`, err);
    }
  }
  return applyPublishSidecar(posts.sort((a, b) => b.date.localeCompare(a.date)));
}

/**
 * Overlay the content-publish sidecar onto the raw frontmatter-sourced posts.
 * After publishApproved opens a PR, it writes the slug → {prUrl, branch, publishedAt}
 * to a sidecar JSON in the dashboard state dir. We can't store the published
 * state in the website repo's working tree because publishApproved's final
 * `git checkout startBranch` reverts the files back to status: approved
 * (the new commit only exists on the publish branch, awaiting PR merge).
 *
 * For each sidecar entry:
 *   - gh pr view → MERGED → frontmatter has caught up (or will once Vilhelm
 *     pulls main) → remove from sidecar
 *   - gh pr view → CLOSED (not merged) → publish cancelled → remove from
 *     sidecar so the post returns to its on-disk approved state
 *   - gh pr view → OPEN → override status to "published" + attach prUrl so
 *     the UI can show a "View PR" link
 *   - gh pr view → UNKNOWN (gh not installed, network blip, etc) → leave
 *     sidecar in place + override to published (fail-safe: we'd rather
 *     misclassify briefly than yank a post out of the UI)
 */
async function applyPublishSidecar(posts: ContentPost[]): Promise<ContentPost[]> {
  const [{ readPending, deletePending }, { fetchPrState }] = await Promise.all([
    import("./content-publish-pending"),
    import("./gh-pr-state"),
  ]);
  const pending = await readPending();
  const slugs = Object.keys(pending);
  if (slugs.length === 0) return posts;

  const toRemove: string[] = [];
  const overrides = new Map<string, { prUrl: string }>();
  await Promise.all(
    slugs.map(async (slug) => {
      const entry = pending[slug];
      const state = await fetchPrState(entry.prUrl);
      if (state === "MERGED" || state === "CLOSED") {
        toRemove.push(slug);
        return;
      }
      overrides.set(slug, { prUrl: entry.prUrl });
    }),
  );

  if (toRemove.length > 0) {
    try { await deletePending(toRemove); } catch (err) {
      console.error("[content] failed to clean up sidecar entries:", err);
    }
  }

  if (overrides.size === 0) return posts;
  return posts.map((p) => {
    const ov = overrides.get(p.slug);
    if (!ov) return p;
    return { ...p, status: "published" as const, pendingPrUrl: ov.prUrl };
  });
}

export async function getPostBySlug(slug: string): Promise<ContentPost | null> {
  if (!SLUG_REGEX.test(slug)) return null;
  const posts = await getAllPosts();
  return posts.find((p) => p.slug === slug) ?? null;
}

/**
 * Resolve the on-disk filepath for a given slug after path-traversal guard.
 * Returns null if the slug is invalid or no matching file exists.
 */
export async function resolvePostPath(slug: string): Promise<string | null> {
  if (!SLUG_REGEX.test(slug)) return null;
  const post = await getPostBySlug(slug);
  if (!post) return null;
  const blogDir = getBlogDir();
  const candidate = path.resolve(blogDir, post.filename);
  // Defence-in-depth: the resolved path MUST live inside blogDir even though
  // both slug and filename are already validated upstream. Symlink shenanigans
  // or future changes to the loader can't escape this guard.
  if (!candidate.startsWith(blogDir + path.sep) && candidate !== blogDir) {
    throw new Error(`Path traversal blocked: ${candidate}`);
  }
  return candidate;
}

interface UpdatePostFields {
  title?: string;
  excerpt?: string;
  tags?: string[];
  body?: string;
  status?: ContentStatus;
  author?: string;
  ogImage?: string;
}

/**
 * Atomic write: serialize updated frontmatter + body, write to a tmp file
 * in the same directory, then rename over the target. Same directory so the
 * rename is filesystem-atomic.
 */
export async function updatePost(slug: string, fields: UpdatePostFields): Promise<ContentPost> {
  const filepath = await resolvePostPath(slug);
  if (!filepath) throw new Error(`Post not found: ${slug}`);
  const current = await getPostBySlug(slug);
  if (!current) throw new Error(`Post not found: ${slug}`);

  const merged: Record<string, unknown> = {
    title: fields.title ?? current.title,
    date: current.date,
    slug: current.slug,
    tags: fields.tags ?? current.tags,
    author: fields.author ?? current.author,
    excerpt: fields.excerpt ?? current.excerpt,
    status: fields.status ?? current.status,
  };
  // Only include ogImage when it's set — js-yaml dumper rejects `undefined`
  // values with "unacceptable kind of an object to dump [object Undefined]"
  // and 500s the whole write.
  const og = fields.ogImage ?? current.ogImage;
  if (og !== undefined) merged.ogImage = og;

  // Re-validate against schema before writing — catches caller misuse.
  FrontmatterSchema.parse(merged);

  const body = fields.body ?? current.body;
  const serialized = matter.stringify(body, merged);

  const tmpPath = `${filepath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmpPath, serialized, "utf-8");
  await fs.rename(tmpPath, filepath);

  return (await getPostBySlug(slug))!;
}

export async function setStatus(slug: string, status: ContentStatus): Promise<ContentPost> {
  return updatePost(slug, { status });
}

export function postUrl(slug: string): string {
  return `https://www.korendigital.no/blog/${slug}`;
}
