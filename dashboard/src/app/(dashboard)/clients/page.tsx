'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { IconBriefcase, IconPlus, IconClock } from '@tabler/icons-react';

interface Client {
  id: string;
  company_name: string;
  contact_name: string | null;
  deal_type: string | null;
  rate_nok: number | null;
  rate_description: string | null;
  hours_commitment: string | null;
  status: string;
  total_hours: number;
  entry_count: number;
  last_activity: string | null;
}

function formatNOK(value: number): string {
  return new Intl.NumberFormat('nb-NO', { maximumFractionDigits: 0 }).format(value);
}

export default function ClientsPage() {
  const router = useRouter();
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchClients = useCallback(async () => {
    try {
      const res = await fetch('/api/clients');
      if (res.ok) setClients(await res.json());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchClients(); }, [fetchClients]);

  if (loading) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Clients</h1>
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-24 rounded-xl bg-muted/30 animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Clients</h1>
      </div>

      {clients.length === 0 ? (
        <div className="flex flex-col items-center py-16">
          <IconBriefcase size={48} className="text-muted-foreground/30 mb-4" />
          <h3 className="text-lg font-medium mb-1">No clients yet</h3>
          <p className="text-sm text-muted-foreground">Clients will appear here when added.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {clients.map(client => (
            <div
              key={client.id}
              onClick={() => router.push(`/clients/${client.id}`)}
              className="rounded-xl border bg-card p-5 hover:bg-accent/50 transition-colors cursor-pointer"
            >
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-lg font-semibold">{client.company_name}</h3>
                    <Badge variant="secondary" className={client.status === 'active' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' : 'bg-muted text-muted-foreground'}>
                      {client.status}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-4 mt-1 text-sm text-muted-foreground">
                    {client.contact_name && <span>{client.contact_name}</span>}
                    {client.deal_type && <span>{client.deal_type}</span>}
                  </div>
                </div>
                <div className="text-right">
                  {client.rate_nok && (
                    <p className="text-sm font-semibold text-emerald-600 dark:text-emerald-400">
                      {formatNOK(client.rate_nok)} kr/t
                    </p>
                  )}
                  {client.hours_commitment && (
                    <p className="text-xs text-muted-foreground">{client.hours_commitment}</p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-4 mt-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-1"><IconClock className="size-3.5" />{client.total_hours.toFixed(1)} timer logget</span>
                <span>{client.entry_count} innlegg</span>
                {client.last_activity && <span>Sist aktiv: {client.last_activity}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
