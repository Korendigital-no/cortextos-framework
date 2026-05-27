'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { IconArrowLeft, IconClock, IconPlus } from '@tabler/icons-react';

interface Client {
  id: string;
  company_name: string;
  contact_name: string | null;
  contact_email: string | null;
  deal_type: string | null;
  rate_nok: number | null;
  rate_description: string | null;
  hours_commitment: string | null;
  status: string;
  notes: string | null;
  created_at: string;
}

interface TimeEntry {
  id: string;
  description: string;
  hours: number;
  date: string;
  agent: string | null;
  created_at: string;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('nb-NO', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatNOK(value: number): string {
  return new Intl.NumberFormat('nb-NO', { maximumFractionDigits: 0 }).format(value);
}

export default function ClientDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [client, setClient] = useState<Client | null>(null);
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [totals, setTotals] = useState({ total_hours: 0, entry_count: 0 });
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [desc, setDesc] = useState('');
  const [hours, setHours] = useState('');
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`/api/clients/${id}`);
      if (res.ok) {
        const data = await res.json();
        setClient(data.client);
        setEntries(data.timeEntries);
        setTotals(data.totals);
      }
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { fetchData(); }, [fetchData]);

  async function handleAddEntry() {
    if (!desc.trim() || !hours) return;
    await fetch(`/api/clients/${id}/time-entries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: desc.trim(), hours: parseFloat(hours), date }),
    });
    setDesc('');
    setHours('');
    setDate(new Date().toISOString().split('T')[0]);
    setShowAdd(false);
    fetchData();
  }

  if (loading) {
    return <div className="space-y-4"><div className="h-8 w-48 rounded bg-muted/30 animate-pulse" /><div className="h-64 rounded-lg bg-muted/30 animate-pulse" /></div>;
  }

  if (!client) {
    return <div className="space-y-4"><Link href="/clients"><Button variant="ghost" size="sm"><IconArrowLeft className="size-4 mr-1" />Back</Button></Link><p className="text-sm text-muted-foreground">Client not found.</p></div>;
  }

  const revenue = client.rate_nok ? totals.total_hours * client.rate_nok : null;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <Link href="/clients"><Button variant="ghost" size="icon-sm"><IconArrowLeft className="size-4" /></Button></Link>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold">{client.company_name}</h1>
              <Badge variant="secondary" className={client.status === 'active' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' : ''}>
                {client.status}
              </Badge>
            </div>
            <div className="flex items-center gap-4 mt-1 text-sm text-muted-foreground">
              {client.contact_name && <span>{client.contact_name}</span>}
              {client.deal_type && <span>{client.deal_type}</span>}
              {client.rate_nok && <span>{formatNOK(client.rate_nok)} kr/t ex MVA</span>}
              {client.hours_commitment && <span>{client.hours_commitment}</span>}
            </div>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => setShowAdd(!showAdd)}>
          <IconPlus className="size-4 mr-1" />Log time
        </Button>
      </div>

      {showAdd && (
        <div className="rounded-lg border bg-card p-4 space-y-3">
          <div className="flex gap-2">
            <input type="text" placeholder="What did you do?" value={desc} onChange={e => setDesc(e.target.value)}
              className="flex-1 rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" autoFocus />
            <input type="number" placeholder="Hours" value={hours} onChange={e => setHours(e.target.value)} step="0.25" min="0.25" max="24"
              className="w-24 rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
            <input type="date" value={date} onChange={e => setDate(e.target.value)}
              className="rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" size="sm" onClick={() => setShowAdd(false)}>Cancel</Button>
            <Button size="sm" onClick={handleAddEntry} disabled={!desc.trim() || !hours}>Log</Button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-lg border bg-card p-4">
          <p className="text-xs text-muted-foreground">Total hours</p>
          <p className="text-2xl font-semibold">{totals.total_hours.toFixed(1)}</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <p className="text-xs text-muted-foreground">Entries</p>
          <p className="text-2xl font-semibold">{totals.entry_count}</p>
        </div>
        {revenue != null && (
          <div className="rounded-lg border bg-card p-4">
            <p className="text-xs text-muted-foreground">Revenue (ex MVA)</p>
            <p className="text-2xl font-semibold text-emerald-600 dark:text-emerald-400">{formatNOK(revenue)} kr</p>
          </div>
        )}
      </div>

      <div>
        <h2 className="text-lg font-medium mb-3">Work Log</h2>
        {entries.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No time entries yet. Click "Log time" to add work.</p>
        ) : (
          <div className="rounded-lg border divide-y">
            {entries.map(entry => (
              <div key={entry.id} className="flex items-center justify-between px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{entry.description}</p>
                  <p className="text-xs text-muted-foreground">{formatDate(entry.date)}{entry.agent ? ` by ${entry.agent}` : ''}</p>
                </div>
                <div className="flex items-center gap-1 text-sm font-medium shrink-0">
                  <IconClock className="size-3.5 text-muted-foreground" />
                  {entry.hours.toFixed(1)}h
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {client.notes && (
        <div>
          <h3 className="text-sm font-medium mb-2">Notes</h3>
          <p className="text-sm text-muted-foreground rounded-lg border p-3">{client.notes}</p>
        </div>
      )}
    </div>
  );
}
