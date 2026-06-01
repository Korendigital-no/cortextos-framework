'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { IconUsers, IconBuilding, IconBriefcase, IconCalendar } from '@tabler/icons-react';
import { PipelineBoard } from '@/components/crm/pipeline-board';
import { CreateDealDialog } from '@/components/crm/create-deal-dialog';

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

interface PipelineSummary {
  pipeline: { stage: string; count: number; total_value: number }[];
  totalActive: { count: number; total_value: number };
}

function formatNOK(value: number): string {
  return new Intl.NumberFormat('nb-NO', { style: 'currency', currency: 'NOK', maximumFractionDigits: 0 }).format(value);
}

export default function CrmPage() {
  const [deals, setDeals] = useState<Deal[]>([]);
  const [summary, setSummary] = useState<PipelineSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  function handleDealClick(deal: { id: string }) {
    router.push(`/crm/deals/${deal.id}`);
  }

  const fetchData = useCallback(async () => {
    try {
      const [dealsRes, pipelineRes] = await Promise.all([
        fetch('/api/crm/deals'),
        fetch('/api/crm/pipeline'),
      ]);
      if (dealsRes.ok) setDeals(await dealsRes.json());
      if (pipelineRes.ok) setSummary(await pipelineRes.json());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const activeDeals = deals.filter(d => !['closed_won', 'closed_lost'].includes(d.stage));

  async function handleDealDelete(dealId: string) {
    await fetch(`/api/crm/deals/${dealId}`, { method: 'DELETE' });
    fetchData();
  }

  async function handleStageChange(dealId: string, newStage: string) {
    const res = await fetch('/api/crm/deals', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: dealId, stage: newStage }),
    });
    if (res.ok) fetchData();
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">CRM</h1>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-64 rounded-xl bg-muted/30 animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">CRM</h1>
          {summary?.totalActive && (
            <p className="text-sm text-muted-foreground">
              {summary.totalActive.count} active deals &middot; {formatNOK(summary.totalActive.total_value)} pipeline
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Link href="/crm/contacts">
            <Button variant="ghost" size="sm">
              <IconUsers className="size-4 mr-1" />
              Contacts
            </Button>
          </Link>
          <Link href="/crm/companies">
            <Button variant="ghost" size="sm">
              <IconBuilding className="size-4 mr-1" />
              Companies
            </Button>
          </Link>
          <Link href="/crm/calendar">
            <Button variant="ghost" size="sm">
              <IconCalendar className="size-4 mr-1" />
              Calendar
            </Button>
          </Link>
          <CreateDealDialog onCreated={fetchData} />
        </div>
      </div>

      {activeDeals.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <IconBriefcase size={48} className="text-muted-foreground/30 mb-4" />
          <h3 className="text-lg font-medium mb-1">No deals yet</h3>
          <p className="text-sm text-muted-foreground mb-4 max-w-sm">
            Add your first deal to start tracking your pipeline.
          </p>
          <CreateDealDialog onCreated={fetchData} />
        </div>
      ) : (
        <PipelineBoard deals={activeDeals} onDealClick={handleDealClick} onStageChange={handleStageChange} onDealDelete={handleDealDelete} />
      )}
    </div>
  );
}
