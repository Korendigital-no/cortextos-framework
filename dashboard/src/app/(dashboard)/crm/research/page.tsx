'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { IconArrowLeft, IconFileText, IconCalendar } from '@tabler/icons-react';
import { marked } from 'marked';
import DOMPurify from 'isomorphic-dompurify';

interface ResearchDoc {
  agent: string;
  filename: string;
  title: string;
  content: string;
}

function formatFilename(filename: string): string {
  return filename.replace('.md', '').replace(/-/g, ' ').replace(/v\d+$/, '').trim();
}

function estimateReadTime(content: string): string {
  const words = content.split(/\s+/).length;
  const minutes = Math.max(1, Math.round(words / 200));
  return `${minutes} min read`;
}

export default function ResearchPage() {
  const [docs, setDocs] = useState<ResearchDoc[]>([]);
  const [selected, setSelected] = useState<ResearchDoc | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchDocs = useCallback(async () => {
    try {
      const res = await fetch('/api/crm/research');
      if (res.ok) setDocs(await res.json());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDocs();
  }, [fetchDocs]);

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
          <div className="flex-1">
            <h1 className="text-2xl font-semibold">{selected.title}</h1>
            <div className="flex items-center gap-3 mt-1">
              <Badge variant="secondary">{selected.agent}</Badge>
              <span className="text-xs text-muted-foreground">{estimateReadTime(selected.content)}</span>
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

  const grouped = docs.reduce<Record<string, ResearchDoc[]>>((acc, doc) => {
    (acc[doc.agent] ??= []).push(doc);
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/crm">
          <Button variant="ghost" size="icon-sm">
            <IconArrowLeft className="size-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-semibold">Research</h1>
          <p className="text-sm text-muted-foreground">{docs.length} documents from {Object.keys(grouped).length} agent{Object.keys(grouped).length !== 1 ? 's' : ''}</p>
        </div>
      </div>

      {Object.entries(grouped).map(([agent, agentDocs]) => (
        <div key={agent} className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">{agent}</h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {agentDocs.map(doc => (
              <button
                key={`${doc.agent}-${doc.filename}`}
                onClick={() => setSelected(doc)}
                className="flex items-start gap-4 rounded-xl border bg-card p-4 hover:bg-accent/50 transition-colors text-left shadow-sm"
              >
                <div className="shrink-0 mt-1 rounded-lg bg-muted p-2">
                  <IconFileText className="size-5 text-muted-foreground" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{doc.title}</p>
                  <p className="text-xs text-muted-foreground mt-1">{formatFilename(doc.filename)}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{estimateReadTime(doc.content)}</p>
                </div>
              </button>
            ))}
          </div>
        </div>
      ))}

      {docs.length === 0 && (
        <div className="flex flex-col items-center py-16">
          <IconFileText size={48} className="text-muted-foreground/30 mb-4" />
          <p className="text-sm text-muted-foreground">No research documents found.</p>
        </div>
      )}
    </div>
  );
}
