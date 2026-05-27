'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  IconArrowLeft, IconUser, IconBuilding, IconTrash,
  IconNote, IconPhone, IconMail, IconVideo, IconChecklist, IconCalendarEvent,
} from '@tabler/icons-react';

interface Deal {
  id: string;
  title: string;
  value_nok: number | null;
  stage: string;
  contact_id: string | null;
  contact_name: string | null;
  contact_email: string | null;
  company_name: string | null;
  expected_close: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface Activity {
  id: string;
  type: string;
  subject: string | null;
  body: string | null;
  contact_name: string | null;
  due_at: string | null;
  completed_at: string | null;
  agent: string | null;
  created_at: string;
}

const STAGE_COLORS: Record<string, string> = {
  lead: 'bg-blue-500/10 text-blue-700 dark:text-blue-400',
  contacted: 'bg-cyan-500/10 text-cyan-700 dark:text-cyan-400',
  qualified: 'bg-purple-500/10 text-purple-700 dark:text-purple-400',
  proposal: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  negotiation: 'bg-orange-500/10 text-orange-700 dark:text-orange-400',
  closed_won: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  closed_lost: 'bg-red-500/10 text-red-700 dark:text-red-400',
};

const ACTIVITY_ICONS: Record<string, typeof IconNote> = {
  meeting: IconVideo, email: IconMail, email_draft: IconMail,
  call: IconPhone, note: IconNote, task: IconChecklist, booking: IconCalendarEvent,
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('nb-NO', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatNOK(value: number): string {
  return new Intl.NumberFormat('nb-NO', { style: 'currency', currency: 'NOK', maximumFractionDigits: 0 }).format(value);
}

export default function DealDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [deal, setDeal] = useState<Deal | null>(null);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingStage, setEditingStage] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`/api/crm/deals/${id}`);
      if (res.ok) {
        const data = await res.json();
        setDeal(data.deal);
        setActivities(data.activities);
      }
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { fetchData(); }, [fetchData]);

  async function handleStageChange(newStage: string) {
    await fetch('/api/crm/deals', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, stage: newStage }),
    });
    setEditingStage(false);
    fetchData();
  }

  async function handleDelete() {
    if (!confirm(`Delete "${deal?.title}"?`)) return;
    await fetch(`/api/crm/deals/${id}`, { method: 'DELETE' });
    router.push('/crm');
  }

  if (loading) {
    return <div className="space-y-4"><div className="h-8 w-48 rounded bg-muted/30 animate-pulse" /><div className="h-64 rounded-lg bg-muted/30 animate-pulse" /></div>;
  }

  if (!deal) {
    return <div className="space-y-4"><Link href="/crm"><Button variant="ghost" size="sm"><IconArrowLeft className="size-4 mr-1" />Back</Button></Link><p className="text-sm text-muted-foreground">Deal not found.</p></div>;
  }

  const stages = ['lead', 'contacted', 'qualified', 'proposal', 'negotiation', 'closed_won', 'closed_lost'];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <Link href="/crm"><Button variant="ghost" size="icon-sm"><IconArrowLeft className="size-4" /></Button></Link>
          <div>
            <h1 className="text-2xl font-semibold">{deal.title}</h1>
            <div className="flex items-center gap-3 mt-1">
              {editingStage ? (
                <select value={deal.stage} onChange={e => handleStageChange(e.target.value)}
                  onBlur={() => setEditingStage(false)} autoFocus
                  className="rounded-md border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-ring">
                  {stages.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              ) : (
                <Badge variant="secondary" className={`${STAGE_COLORS[deal.stage] ?? ''} cursor-pointer`} onClick={() => setEditingStage(true)}>
                  {deal.stage}
                </Badge>
              )}
              {deal.value_nok != null && <span className="text-sm font-semibold text-emerald-600 dark:text-emerald-400">{formatNOK(deal.value_nok)}</span>}
            </div>
          </div>
        </div>
        <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={handleDelete}>
          <IconTrash className="size-4 mr-1" />Delete
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-4">
          <h2 className="text-lg font-medium">Activity Timeline</h2>
          {activities.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No activity yet.</p>
          ) : (
            <div className="space-y-3">
              {activities.map(activity => {
                const Icon = ACTIVITY_ICONS[activity.type] ?? IconNote;
                const isOverdue = activity.type === 'task' && activity.due_at && !activity.completed_at && new Date(activity.due_at) < new Date();
                return (
                  <div key={activity.id} className="flex gap-3 rounded-lg border bg-card p-3">
                    <Icon className={`size-4 shrink-0 mt-0.5 ${isOverdue ? 'text-red-500' : 'text-muted-foreground'}`} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-medium truncate">{activity.subject ?? activity.type}</p>
                        <span className="text-xs text-muted-foreground shrink-0">{formatDate(activity.created_at)}</span>
                      </div>
                      {activity.body && <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{activity.body}</p>}
                      {activity.due_at && <p className={`text-xs mt-1 ${isOverdue ? 'text-red-500 font-medium' : 'text-muted-foreground'}`}>Due: {formatDate(activity.due_at)}{isOverdue ? ' (overdue)' : ''}</p>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="space-y-4">
          <h3 className="text-sm font-medium">Details</h3>
          <div className="rounded-lg border p-3 space-y-2 text-sm">
            {deal.contact_name && (
              <Link href={`/crm/contacts/${deal.contact_id}`} className="flex items-center gap-2 text-blue-500 hover:underline">
                <IconUser className="size-3.5" />{deal.contact_name}
              </Link>
            )}
            {deal.company_name && <p className="flex items-center gap-2 text-muted-foreground"><IconBuilding className="size-3.5" />{deal.company_name}</p>}
            {deal.expected_close && <p className="text-muted-foreground">Expected close: {formatDate(deal.expected_close)}</p>}
            <p className="text-xs text-muted-foreground">Created: {formatDate(deal.created_at)}</p>
            {deal.notes && <p className="text-xs text-muted-foreground mt-2">{deal.notes}</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
