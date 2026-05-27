'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { IconArrowLeft, IconFileText } from '@tabler/icons-react';
import { marked } from 'marked';
import DOMPurify from 'isomorphic-dompurify';

interface ResearchDoc {
  agent: string;
  filename: string;
  title: string;
  content: string;
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
    // Content is from trusted agent-generated research files on disk,
    // sanitized with DOMPurify as defense-in-depth matching the existing
    // pattern in dashboard/src/app/api/media/[...filepath]/route.ts
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
            <div key={i} className="h-14 rounded-lg bg-muted/30 animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (selected) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon-sm" onClick={() => setSelected(null)}>
            <IconArrowLeft className="size-4" />
          </Button>
          <div>
            <h1 className="text-2xl font-semibold">{selected.title}</h1>
            <p className="text-xs text-muted-foreground">{selected.agent} / {selected.filename}</p>
          </div>
        </div>
        <div
          className="prose prose-sm dark:prose-invert max-w-none rounded-lg border bg-card p-6"
          dangerouslySetInnerHTML={{ __html: renderHtml(selected.content) }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link href="/crm">
          <Button variant="ghost" size="icon-sm">
            <IconArrowLeft className="size-4" />
          </Button>
        </Link>
        <h1 className="text-2xl font-semibold">Research</h1>
      </div>

      {docs.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">No research docs found.</p>
      ) : (
        <div className="rounded-lg border divide-y">
          {docs.map(doc => (
            <button
              key={`${doc.agent}-${doc.filename}`}
              onClick={() => setSelected(doc)}
              className="w-full flex items-center justify-between px-4 py-3 hover:bg-accent/50 transition-colors text-left"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{doc.title}</p>
                <p className="text-xs text-muted-foreground">{doc.agent} / {doc.filename}</p>
              </div>
              <IconFileText className="size-4 text-muted-foreground shrink-0" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
