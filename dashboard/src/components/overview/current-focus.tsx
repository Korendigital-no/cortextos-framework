import Link from 'next/link';
import { IconExternalLink, IconTarget } from '@tabler/icons-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { BottleneckEditor } from './bottleneck-editor';
import { GoalProgressList } from './goal-progress-list';
import type { Goal } from '@/lib/types';

interface CurrentFocusProps {
  org: string;
  bottleneck: string;
  bottleneckBlocks: string[];
  goals: Goal[];
  dailyFocus?: string;
  dailyFocusSetAt?: string;
}

export function CurrentFocus({
  org, bottleneck, bottleneckBlocks, goals, dailyFocus, dailyFocusSetAt,
}: CurrentFocusProps) {
  const blockedGoalIds = new Set(bottleneckBlocks);
  const blockedGoals = goals.filter(g => blockedGoalIds.has(g.id));

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Current Focus
        </CardTitle>
        <Link
          href="/strategy"
          className="flex items-center gap-1 text-xs text-primary hover:underline"
        >
          Manage in Strategy
          <IconExternalLink size={12} />
        </Link>
      </CardHeader>
      <CardContent className="space-y-6">
        {dailyFocus && (
          <div className="rounded-lg border border-primary/30 bg-primary/5 px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1 flex items-center gap-1.5">
                  <IconTarget size={12} />
                  Today&apos;s Focus
                </p>
                <p className="text-sm font-medium">{dailyFocus}</p>
              </div>
              {dailyFocusSetAt && (
                <p className="text-xs text-muted-foreground shrink-0 mt-1">
                  {new Date(dailyFocusSetAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </p>
              )}
            </div>
          </div>
        )}

        <div className="space-y-2">
          <BottleneckEditor org={org} initialValue={bottleneck} />
          {blockedGoals.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 pl-1">
              <span className="text-xs text-muted-foreground">Blocks:</span>
              {blockedGoals.map(g => (
                <Link
                  key={g.id}
                  href="/strategy"
                  className="inline-flex items-center rounded-full border border-red-500/30 bg-red-500/5 px-2 py-0.5 text-xs text-red-700 hover:bg-red-500/10 dark:text-red-400 transition-colors"
                  title={`Bottleneck is blocking: ${g.title}`}
                >
                  {g.title}
                </Link>
              ))}
            </div>
          )}
        </div>

        <GoalProgressList goals={goals} blockedGoalIds={bottleneckBlocks} bottleneck={bottleneck} />
      </CardContent>
    </Card>
  );
}
