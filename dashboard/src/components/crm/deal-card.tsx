'use client';

import { cn } from '@/lib/utils';

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

interface DealCardProps {
  deal: Deal;
  onClick?: (deal: Deal) => void;
}

function formatNOK(value: number): string {
  return new Intl.NumberFormat('nb-NO', { style: 'currency', currency: 'NOK', maximumFractionDigits: 0 }).format(value);
}

export function DealCard({ deal, onClick }: DealCardProps) {
  return (
    <button
      onClick={() => onClick?.(deal)}
      className={cn(
        'w-full rounded-lg border bg-card p-3 text-left transition-colors hover:bg-accent/50',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <h4 className="text-sm font-medium leading-tight">{deal.title}</h4>
      </div>
      {deal.value_nok != null && (
        <p className="mt-1 text-sm font-semibold text-emerald-600 dark:text-emerald-400">
          {formatNOK(deal.value_nok)}
        </p>
      )}
      <div className="mt-2 flex flex-col gap-0.5">
        {deal.contact_name && (
          <p className="text-xs text-muted-foreground">{deal.contact_name}</p>
        )}
        {deal.company_name && (
          <p className="text-xs text-muted-foreground">{deal.company_name}</p>
        )}
      </div>
    </button>
  );
}
