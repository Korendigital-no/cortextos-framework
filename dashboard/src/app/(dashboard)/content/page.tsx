'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { IconArrowLeft, IconFileText, IconSearch, IconCheck, IconRocket, IconAlertCircle, IconEdit, IconCalendar } from '@tabler/icons-react';
import { marked } from 'marked';
import DOMPurify from 'isomorphic-dompurify';

type ContentStatus = 'draft' | 'approved' | 'published';

interface PostSummary {
  slug: string;
  filename: string;
  title: string;
  date: string;
  tags: string[];
  author: string;
  excerpt: string;
  ogImage?: string;
  status: ContentStatus;
  wordCount: number;
}

interface PostDetail extends PostSummary {
  body: string;
}

const STATUS_BADGE: Record<ContentStatus, { label: string; className: string }> = {
  draft: { label: 'Draft', className: 'bg-amber-500/10 text-amber-700 dark:text-amber-400' },
  approved: { label: 'Approved', className: 'bg-blue-500/10 text-blue-700 dark:text-blue-400' },
  published: { label: 'Published', className: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' },
};

function formatDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]))
    .toLocaleDateString('nb-NO', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function ContentPage() {
  const [posts, setPosts] = useState<PostSummary[]>([]);
  const [selected, setSelected] = useState<PostDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<ContentStatus | 'all'>('all');
  const [tagFilter, setTagFilter] = useState<string | null>(null);

  // Editing state (used in detail view)
  const [editingBody, setEditingBody] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [actionMessage, setActionMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const fetchPosts = useCallback(async () => {
    try {
      const res = await fetch('/api/content/posts');
      if (res.ok) setPosts((await res.json()).posts);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchPosts(); }, [fetchPosts]);

  const allTags = useMemo(() => {
    const tags = new Set<string>();
    posts.forEach((p) => p.tags.forEach((t) => tags.add(t)));
    return Array.from(tags).sort();
  }, [posts]);

  const searchIndex = useMemo(
    () => posts.map((p) => ({
      doc: p,
      haystack: `${p.title} ${p.excerpt} ${p.tags.join(' ')} ${p.author} ${p.slug}`.toLowerCase(),
    })),
    [posts],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = posts;
    if (q) list = searchIndex.filter((s) => s.haystack.includes(q)).map((s) => s.doc);
    if (statusFilter !== 'all') list = list.filter((p) => p.status === statusFilter);
    if (tagFilter) list = list.filter((p) => p.tags.includes(tagFilter));
    return list;
  }, [posts, searchIndex, query, statusFilter, tagFilter]);

  const counts = useMemo(() => {
    return {
      draft: posts.filter((p) => p.status === 'draft').length,
      approved: posts.filter((p) => p.status === 'approved').length,
      published: posts.filter((p) => p.status === 'published').length,
    };
  }, [posts]);

  const loadDetail = useCallback(async (slug: string) => {
    setActionMessage(null);
    const res = await fetch(`/api/content/posts/${slug}`);
    if (res.ok) {
      const { post } = await res.json();
      setSelected(post);
      setEditingBody(null);
    }
  }, []);

  function renderHtml(md: string): string {
    const raw = marked.parse(md) as string;
    return DOMPurify.sanitize(raw, {
      FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form'],
    });
  }

  async function handleSaveEdit() {
    if (!selected || editingBody === null) return;
    setSaving(true);
    setActionMessage(null);
    try {
      const res = await fetch(`/api/content/posts/${selected.slug}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: editingBody }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Save failed');
      setSelected(data.post);
      setEditingBody(null);
      setActionMessage({ kind: 'ok', text: 'Saved.' });
      fetchPosts();
    } catch (err) {
      setActionMessage({ kind: 'err', text: String(err instanceof Error ? err.message : err) });
    } finally {
      setSaving(false);
    }
  }

  async function handleApprove(slug: string) {
    setSaving(true);
    setActionMessage(null);
    try {
      const res = await fetch(`/api/content/posts/${slug}/approve`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Approve failed');
      if (selected?.slug === slug) setSelected({ ...selected, status: data.post.status });
      setActionMessage({ kind: 'ok', text: 'Approved.' });
      fetchPosts();
    } catch (err) {
      setActionMessage({ kind: 'err', text: String(err instanceof Error ? err.message : err) });
    } finally {
      setSaving(false);
    }
  }

  async function handlePublishAll() {
    if (!confirm(`Publish ${counts.approved} approved post(s)? This opens a PR — you merge it on GitHub to trigger the Vercel deploy.`)) return;
    setPublishing(true);
    setActionMessage(null);
    try {
      const res = await fetch('/api/content/publish', { method: 'POST' });
      const data = await res.json();
      const text = data.prUrl
        ? `${data.message} → ${data.prUrl}`
        : data.message;
      setActionMessage({ kind: data.ok ? 'ok' : 'err', text });
      fetchPosts();
    } catch (err) {
      setActionMessage({ kind: 'err', text: String(err instanceof Error ? err.message : err) });
    } finally {
      setPublishing(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Content</h1>
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-20 rounded-lg bg-muted/30 animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  // ----------- detail view -----------
  if (selected) {
    const sb = STATUS_BADGE[selected.status];
    const isEditing = editingBody !== null;
    return (
      <div className="max-w-4xl mx-auto space-y-5">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon-sm" onClick={() => { setSelected(null); setEditingBody(null); setActionMessage(null); }}>
            <IconArrowLeft className="size-4" />
          </Button>
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-semibold truncate">{selected.title}</h1>
            <div className="flex flex-wrap items-center gap-3 mt-1 text-xs text-muted-foreground">
              <Badge variant="secondary" className={sb.className}>{sb.label}</Badge>
              <span className="inline-flex items-center gap-1"><IconCalendar className="size-3" />{formatDate(selected.date)}</span>
              <span>{selected.wordCount} words</span>
              <span className="font-mono">{selected.filename}</span>
            </div>
          </div>
        </div>

        {actionMessage && (
          <div className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${actionMessage.kind === 'ok' ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400' : 'border-red-500/30 bg-red-500/5 text-red-700 dark:text-red-400'}`}>
            <IconAlertCircle className="size-4 mt-0.5 shrink-0" />
            <span>{actionMessage.text}</span>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {selected.status === 'draft' && (
            <Button size="sm" onClick={() => handleApprove(selected.slug)} disabled={saving}>
              <IconCheck className="size-4 mr-1" />Approve
            </Button>
          )}
          {!isEditing ? (
            <Button size="sm" variant="outline" onClick={() => setEditingBody(selected.body)}>
              <IconEdit className="size-4 mr-1" />Edit body
            </Button>
          ) : (
            <>
              <Button size="sm" onClick={handleSaveEdit} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
              <Button size="sm" variant="ghost" onClick={() => { setEditingBody(null); setActionMessage(null); }}>Cancel</Button>
            </>
          )}
        </div>

        <div className="rounded-lg border bg-card p-4 text-xs">
          <p className="font-medium text-muted-foreground mb-2 uppercase tracking-wider">Frontmatter</p>
          <dl className="grid grid-cols-[120px_1fr] gap-y-1">
            <dt className="text-muted-foreground">Slug</dt><dd className="font-mono">{selected.slug}</dd>
            <dt className="text-muted-foreground">Author</dt><dd>{selected.author}</dd>
            <dt className="text-muted-foreground">Excerpt</dt><dd>{selected.excerpt}</dd>
            <dt className="text-muted-foreground">Tags</dt><dd>{selected.tags.length > 0 ? selected.tags.join(', ') : <span className="text-muted-foreground italic">(none)</span>}</dd>
            {selected.ogImage && (<>
              <dt className="text-muted-foreground">OG image</dt><dd className="font-mono truncate">{selected.ogImage}</dd>
            </>)}
          </dl>
        </div>

        {isEditing ? (
          <textarea
            value={editingBody}
            onChange={(e) => setEditingBody(e.target.value)}
            className="w-full min-h-[500px] rounded-xl border bg-card p-4 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            autoFocus
          />
        ) : (
          <article
            className="prose prose-neutral dark:prose-invert prose-headings:font-semibold max-w-none rounded-xl border bg-card p-8 shadow-sm"
            dangerouslySetInnerHTML={{ __html: renderHtml(selected.body) }}
          />
        )}
      </div>
    );
  }

  // ----------- list view -----------
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Content</h1>
          <p className="text-sm text-muted-foreground">
            {posts.length} posts · {counts.draft} draft · {counts.approved} approved · {counts.published} published
          </p>
        </div>
        <Button
          onClick={handlePublishAll}
          disabled={counts.approved === 0 || publishing}
          className="bg-emerald-600 hover:bg-emerald-700 text-white"
        >
          <IconRocket className="size-4 mr-1" />
          {publishing ? 'Publishing…' : `Publish ${counts.approved} approved`}
        </Button>
      </div>

      {actionMessage && (
        <div className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${actionMessage.kind === 'ok' ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400' : 'border-red-500/30 bg-red-500/5 text-red-700 dark:text-red-400'}`}>
          <IconAlertCircle className="size-4 mt-0.5 shrink-0" />
          <span>{actionMessage.text}</span>
        </div>
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <IconSearch className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search title, excerpt, tags…"
            className="w-full rounded-lg border bg-background pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <div className="flex gap-1 shrink-0">
          {(['all', 'draft', 'approved', 'published'] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(s)}
              className={statusFilter === s ? 'rounded-md bg-foreground text-background px-3 py-2 text-xs font-medium' : 'rounded-md border bg-background px-3 py-2 text-xs hover:bg-accent'}
            >
              {s === 'all' ? 'All' : STATUS_BADGE[s].label}
            </button>
          ))}
        </div>
      </div>

      {allTags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">Tag:</span>
          <button onClick={() => setTagFilter(null)} className={tagFilter === null ? 'rounded-full bg-foreground text-background px-2 py-0.5' : 'rounded-full border px-2 py-0.5 hover:bg-accent'}>any</button>
          {allTags.map((t) => (
            <button key={t} onClick={() => setTagFilter(tagFilter === t ? null : t)} className={tagFilter === t ? 'rounded-full bg-foreground text-background px-2 py-0.5' : 'rounded-full border px-2 py-0.5 hover:bg-accent'}>{t}</button>
          ))}
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="flex flex-col items-center py-16">
          <IconFileText size={48} className="text-muted-foreground/30 mb-4" />
          <p className="text-sm text-muted-foreground">No posts match.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {filtered.map((post) => {
            const sb = STATUS_BADGE[post.status];
            return (
              <button
                key={post.slug}
                onClick={() => loadDetail(post.slug)}
                className="flex flex-col items-start gap-2 rounded-xl border bg-card p-4 hover:bg-accent/50 transition-colors text-left shadow-sm"
              >
                <div className="flex items-center gap-2 w-full">
                  <Badge variant="secondary" className={sb.className}>{sb.label}</Badge>
                  <span className="text-xs text-muted-foreground">{formatDate(post.date)}</span>
                  <span className="text-xs text-muted-foreground ml-auto">{post.wordCount}w</span>
                </div>
                <p className="text-sm font-medium leading-tight">{post.title}</p>
                <p className="text-xs text-muted-foreground line-clamp-2">{post.excerpt}</p>
                {post.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1">
                    {post.tags.map((t) => (
                      <span key={t} className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">{t}</span>
                    ))}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Reads from{' '}
        <Link href="https://www.korendigital.no/blog" className="underline" target="_blank" rel="noopener">
          korendigital-website/content/blog/
        </Link>
        . Publish opens a PR on a branch{' '}
        <code className="rounded bg-muted px-1 py-0.5 font-mono">blog/publish-YYYYMMDD-…</code>
        . Merge on GitHub to deploy.
      </p>
    </div>
  );
}
