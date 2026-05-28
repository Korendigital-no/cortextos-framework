'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { Textarea } from '@/components/ui/textarea';
import { updateBottleneck } from '@/lib/actions/goals';
import { TimeAgo } from '@/components/shared/time-ago';
import type { Goal } from '@/lib/types';

interface BottleneckSectionProps {
  bottleneck: string;
  blocks: string[];
  goals: Goal[];
  org: string;
  history: Array<{ timestamp: string; change: string }>;
  onChange?: () => void;
}

export function BottleneckSection({
  bottleneck: initialBottleneck,
  blocks: initialBlocks,
  goals,
  org,
  history,
  onChange,
}: BottleneckSectionProps) {
  const [value, setValue] = useState(initialBottleneck);
  const [blocks, setBlocks] = useState<string[]>(initialBlocks);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedTextRef = useRef(initialBottleneck);
  const lastSavedBlocksRef = useRef<string[]>(initialBlocks);
  // Request versioning: only the most recently issued save is allowed to commit
  // 'saved'/refs/refresh. Prevents a slower earlier save from overwriting state
  // a later save has already produced.
  const saveSeqRef = useRef(0);

  // Sync with parent if bottleneck/blocks change externally
  useEffect(() => {
    setValue(initialBottleneck);
    lastSavedTextRef.current = initialBottleneck;
  }, [initialBottleneck]);

  useEffect(() => {
    setBlocks(initialBlocks);
    lastSavedBlocksRef.current = initialBlocks;
  }, [initialBlocks]);

  const persist = useCallback(async (nextValue: string, nextBlocks: string[]) => {
    const trimmed = nextValue.trim();
    const textChanged = trimmed !== lastSavedTextRef.current;
    const blocksChanged =
      nextBlocks.length !== lastSavedBlocksRef.current.length ||
      nextBlocks.some((id, i) => id !== lastSavedBlocksRef.current[i]);
    if (!textChanged && !blocksChanged) return;

    const mySeq = ++saveSeqRef.current;
    setSaveStatus('saving');
    const result = await updateBottleneck(org, trimmed, nextBlocks);
    if (mySeq !== saveSeqRef.current) {
      // A newer save was issued before this one resolved — drop the response.
      return;
    }
    if (result.success) {
      lastSavedTextRef.current = trimmed;
      lastSavedBlocksRef.current = [...nextBlocks];
      setSaveStatus('saved');
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setSaveStatus('idle'), 2000);
      // Notify the parent so dependent components (GoalsList border etc.) refresh.
      onChange?.();
    } else {
      setSaveStatus('error');
    }
  }, [org, onChange]);

  const handleTextBlur = useCallback(() => {
    persist(value, blocks);
  }, [persist, value, blocks]);

  const toggleBlock = useCallback((goalId: string) => {
    const next = blocks.includes(goalId)
      ? blocks.filter(id => id !== goalId)
      : [...blocks, goalId];
    setBlocks(next);
    persist(value, next);
  }, [blocks, value, persist]);

  const charCount = value.length;
  const charLimit = 500;

  return (
    <div className="space-y-4">
      <div className="rounded-xl border-2 border-amber-500/40 bg-amber-500/5 p-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-amber-700 dark:text-amber-200">
            Current Bottleneck
          </h2>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-muted-foreground tabular-nums">
              {charCount}/{charLimit}
            </span>
            {saveStatus === 'saving' && (
              <span className="text-amber-400 animate-pulse">Saving...</span>
            )}
            {saveStatus === 'saved' && (
              <span className="text-green-600 dark:text-green-400">Saved</span>
            )}
            {saveStatus === 'error' && (
              <span className="text-red-400">Error saving</span>
            )}
          </div>
        </div>
        <Textarea
          value={value}
          onChange={(e) => setValue(e.target.value.slice(0, charLimit))}
          onBlur={handleTextBlur}
          placeholder="What is the current bottleneck for your team?"
          className="min-h-24 text-lg border-amber-500/20 bg-transparent focus-visible:border-amber-500/50 focus-visible:ring-amber-500/20 resize-none"
        />

        {goals.length > 0 && (
          <div className="mt-4 pt-4 border-t border-amber-500/20">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
              This bottleneck is blocking
            </p>
            <div className="flex flex-wrap gap-1.5">
              {goals.map(g => {
                const active = blocks.includes(g.id);
                return (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => toggleBlock(g.id)}
                    className={
                      active
                        ? 'inline-flex items-center rounded-full border border-red-500/40 bg-red-500/10 px-2.5 py-1 text-xs font-medium text-red-700 dark:text-red-300 transition-colors'
                        : 'inline-flex items-center rounded-full border border-muted-foreground/20 bg-transparent px-2.5 py-1 text-xs text-muted-foreground hover:border-amber-500/40 hover:text-foreground transition-colors'
                    }
                    aria-pressed={active}
                  >
                    {g.title}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Recent bottleneck changes */}
      {history.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-muted-foreground">
            Recent Changes
          </h3>
          <div className="space-y-1">
            {history.slice(0, 5).map((entry, i) => (
              <div
                key={`${entry.timestamp}-${i}`}
                className="flex items-start gap-2 text-sm text-muted-foreground"
              >
                <span className="shrink-0 mt-0.5 h-1.5 w-1.5 rounded-full bg-amber-500/50" />
                <span className="flex-1 line-clamp-1">{entry.change}</span>
                <TimeAgo
                  date={entry.timestamp}
                  className="shrink-0 text-xs"
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
