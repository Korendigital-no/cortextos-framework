'use client';

import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { DealCard } from './deal-card';

interface Deal {
  id: string;
  title: string;
  value_nok: number | null;
  stage: string;
  contact_name?: string;
  company_name?: string;
  created_at: string;
  updated_at: string;
}

interface PipelineColumn {
  stage: string;
  label: string;
  deals: Deal[];
  totalValue: number;
}

const STAGE_CONFIG: Record<string, { label: string; color: string }> = {
  lead: { label: 'Lead', color: 'bg-blue-500/10 text-blue-700 dark:text-blue-400' },
  qualified: { label: 'Qualified', color: 'bg-purple-500/10 text-purple-700 dark:text-purple-400' },
  proposal: { label: 'Proposal', color: 'bg-amber-500/10 text-amber-700 dark:text-amber-400' },
  negotiation: { label: 'Negotiation', color: 'bg-orange-500/10 text-orange-700 dark:text-orange-400' },
};

function formatNOK(value: number): string {
  if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(0)}k`;
  return String(value);
}

interface PipelineBoardProps {
  deals: Deal[];
  onDealClick?: (deal: Deal) => void;
}

export function PipelineBoard({ deals, onDealClick }: PipelineBoardProps) {
  const stages = ['lead', 'qualified', 'proposal', 'negotiation'];

  const columns: PipelineColumn[] = stages.map(stage => {
    const stageDeals = deals.filter(d => d.stage === stage);
    return {
      stage,
      label: STAGE_CONFIG[stage]?.label ?? stage,
      deals: stageDeals,
      totalValue: stageDeals.reduce((sum, d) => sum + (d.value_nok ?? 0), 0),
    };
  });

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
      {columns.map(col => (
        <div key={col.stage} className="flex flex-col gap-2">
          <div className="flex items-center justify-between px-1">
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className={STAGE_CONFIG[col.stage]?.color}>
                {col.label}
              </Badge>
              <span className="text-xs text-muted-foreground">{col.deals.length}</span>
            </div>
            {col.totalValue > 0 && (
              <span className="text-xs font-medium text-muted-foreground">
                {formatNOK(col.totalValue)} NOK
              </span>
            )}
          </div>
          <ScrollArea className="h-[calc(100vh-280px)] min-h-[300px]">
            <div className="flex flex-col gap-2 px-0.5 pt-0.5 pb-1">
              {col.deals.length === 0 ? (
                <p className="px-2 py-8 text-center text-xs text-muted-foreground">
                  No deals
                </p>
              ) : (
                col.deals.map(deal => (
                  <DealCard key={deal.id} deal={deal} onClick={onDealClick} />
                ))
              )}
            </div>
          </ScrollArea>
        </div>
      ))}
    </div>
  );
}
