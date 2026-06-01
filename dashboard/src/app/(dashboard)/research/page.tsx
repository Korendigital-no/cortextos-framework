'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { IconArrowLeft, IconFileText, IconSearch, IconArrowsSort, IconCalendar } from '@tabler/icons-react';
import { marked } from 'marked';
import DOMPurify from 'isomorphic-dompurify';

interface ResearchDoc {
  agent: string;
  filename: string;
  relPath: string;
  title: string;
  content: string;
  mtime: string;
  sizeBytes: number;
}

type SortMode = 'newest' | 'name';

function estimateReadTime(content: string): string {
  const words = content.split(/\s+/).length;
  const minutes = Math.max(1, Math.round(words / 200));
  return `${minutes} min read`;
}

function formatRelTime(iso: string): string {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const day = 86400000;
  const days = Math.floor(diffMs / day);
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return d.toLocaleDateString('nb-NO', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Build a breadcrumb path like 'sales / research' from relPath 'research/foo.md'. */
function breadcrumb(agent: string, relPath: string): string {
  const dir = relPath.split('/').slice(0, -1).join(' / ');
  return dir ? `${agent} / ${dir}` : agent;
}

/** Find the first matching snippet around `query` in `content`. */
function findSnippet(content: string, query: string, contextChars = 60): string | null {
  if (!query) return null;
  const lower = content.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx < 0) return null;
  const start = Math.max(0, idx - contextChars);
  const end = Math.min(content.length, idx + query.length + contextChars);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < content.length ? '…' : '';
  // Collapse whitespace + strip newlines for compact rendering
  const snippet = content.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${prefix}${snippet}${suffix}`;
}

export default function ResearchPage() {
  const [docs, setDocs] = useState<ResearchDoc[]>([]);
  const [selected, setSelected] = useState<ResearchDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('newest');

  const fetchDocs = useCallback(async () => {
    try {
      const res = await fetch('/api/crm/research');
      if (res.ok) setDocs(await res.json());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchDocs(); }, [fetchDocs]);

  // Pre-lowercase the searchable corpus once per doc set so search is O(N) per keystroke
  // instead of O(N * docLength) — meaningful when content fields are large.
  const searchIndex = useMemo(() => {
    return docs.map(d => ({
      doc: d,
      haystack: `${d.title} ${d.filename} ${d.relPath} ${d.agent} ${d.content}`.toLowerCase(),
    }));
  }, [docs]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = docs;
    if (q) {
      list = searchIndex.filter(s => s.haystack.includes(q)).map(s => s.doc);
    }
    const sorted = [...list];
    if (sortMode === 'newest') {
      sorted.sort((a, b) => b.mtime.localeCompare(a.mtime));
    } else {
      sorted.sort((a, b) => a.title.localeCompare(b.title, 'nb-NO'));
    }
    return sorted;
  }, [docs, query, sortMode, searchIndex]);

  const grouped = useMemo(() => {
    return filtered.reduce<Record<string, ResearchDoc[]>>((acc, doc) => {
      (acc[doc.agent] ??= []).push(doc);
      return acc;
    }, {});
  }, [filtered]);

  function renderHtml(md: string): string {
    const raw = marked.parse(md) as string;
    return DOMPurify.sanitize(raw, {
      FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form'],
    });
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Research</h1>
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-20 rounded-lg bg-muted/30 animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (selected) {
    return (
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon-sm" onClick={() => setSelected(null)}>
            <IconArrowLeft className="size-4" />
          </Button>
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-semibold truncate">{selected.title}</h1>
            <div className="flex items-center gap-3 mt-1 flex-wrap">
              <Badge variant="secondary">{breadcrumb(selected.agent, selected.relPath)}</Badge>
              <span className="text-xs text-muted-foreground">{estimateReadTime(selected.content)}</span>
              <span className="text-xs text-muted-foreground inline-flex items-center gap-1"><IconCalendar className="size-3" />{formatRelTime(selected.mtime)}</span>
            </div>
          </div>
        </div>
        <article
          className="prose prose-neutral dark:prose-invert prose-headings:font-semibold prose-h1:text-2xl prose-h2:text-xl prose-h3:text-lg prose-p:leading-relaxed prose-li:leading-relaxed prose-table:text-sm max-w-none rounded-xl border bg-card p-8 shadow-sm"
          dangerouslySetInnerHTML={{ __html: renderHtml(selected.content) }}
        />
      </div>
    );
  }

  const totalAgents = Object.keys(grouped).length;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <h1 className="text-2xl font-semibold">Research</h1>
          <p className="text-sm text-muted-foreground">
            {query ? `${filtered.length} of ${docs.length}` : docs.length} document{docs.length !== 1 ? 's' : ''}
            {totalAgents > 0 ? ` from ${totalAgents} agent${totalAgents !== 1 ? 's' : ''}` : ''}
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <IconSearch className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search title or content…"
            className="w-full rounded-lg border bg-background pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            aria-label="Search research documents"
          />
        </div>
        <button
          onClick={() => setSortMode(s => s === 'newest' ? 'name' : 'newest')}
          className="flex items-center gap-1.5 rounded-lg border bg-background px-3 py-2 text-sm hover:bg-accent transition-colors shrink-0"
          aria-label={`Sort by ${sortMode === 'newest' ? 'newest' : 'name'}`}
        >
          <IconArrowsSort className="size-4" />
          <span>{sortMode === 'newest' ? 'Newest' : 'Name'}</span>
        </button>
      </div>

      {Object.entries(grouped).map(([agent, agentDocs]) => (
        <div key={agent} className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">{agent}</h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {agentDocs.map(doc => {
              const snippet = query ? findSnippet(doc.content, query) : null;
              return (
                <button
                  key={`${doc.agent}-${doc.relPath}`}
                  onClick={() => setSelected(doc)}
                  className="flex items-start gap-4 rounded-xl border bg-card p-4 hover:bg-accent/50 transition-colors text-left shadow-sm"
                >
                  <div className="shrink-0 mt-1 rounded-lg bg-muted p-2">
                    <IconFileText className="size-5 text-muted-foreground" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{doc.title}</p>
                    <p className="text-xs text-muted-foreground mt-1 truncate">{breadcrumb(doc.agent, doc.relPath)}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {formatRelTime(doc.mtime)} · {estimateReadTime(doc.content)}
                    </p>
                    {snippet && (
                      <p className="text-xs text-muted-foreground mt-2 italic line-clamp-2">{snippet}</p>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      ))}

      {filtered.length === 0 && (
        <div className="flex flex-col items-center py-16">
          <IconFileText size={48} className="text-muted-foreground/30 mb-4" />
          <p className="text-sm text-muted-foreground">
            {query ? `No documents match "${query}".` : 'No research documents found.'}
          </p>
        </div>
      )}
    </div>
  );
}
