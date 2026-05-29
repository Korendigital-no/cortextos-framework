'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  IconArrowLeft, IconBuilding, IconUser, IconWorldWww, IconTrash, IconEdit,
} from '@tabler/icons-react';

interface Company {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  org_number: string | null;
  size: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface Contact {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  match_confidence: number | null;
  needs_review: number;
  created_at: string;
}

interface Deal {
  id: string;
  title: string;
  value_nok: number | null;
  stage: string;
  contact_id: string | null;
  contact_name: string | null;
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

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('nb-NO', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatNOK(value: number): string {
  return new Intl.NumberFormat('nb-NO', { style: 'currency', currency: 'NOK', maximumFractionDigits: 0 }).format(value);
}

export default function CompanyDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [company, setCompany] = useState<Company | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editFields, setEditFields] = useState({ name: '', domain: '', industry: '', notes: '' });

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`/api/crm/companies/${id}`);
      if (res.ok) {
        const data = await res.json();
        setCompany(data.company);
        setContacts(data.contacts);
        setDeals(data.deals);
      }
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { fetchData(); }, [fetchData]);

  function startEditing() {
    if (!company) return;
    setEditFields({
      name: company.name,
      domain: company.domain ?? '',
      industry: company.industry ?? '',
      notes: company.notes ?? '',
    });
    setEditing(true);
  }

  async function handleSaveEdit() {
    if (!editFields.name.trim()) return;
    await fetch(`/api/crm/companies/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: editFields.name.trim(),
        domain: editFields.domain.trim() || null,
        industry: editFields.industry.trim() || null,
        notes: editFields.notes.trim() || null,
      }),
    });
    setEditing(false);
    fetchData();
  }

  async function handleDelete() {
    if (!confirm(`Delete company "${company?.name}"? Contacts and deals stay but lose the company link.`)) return;
    await fetch(`/api/crm/companies/${id}`, { method: 'DELETE' });
    router.push('/crm/companies');
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-48 rounded bg-muted/30 animate-pulse" />
        <div className="h-32 rounded-lg bg-muted/30 animate-pulse" />
      </div>
    );
  }

  if (!company) {
    return (
      <div className="space-y-4">
        <Link href="/crm/companies"><Button variant="ghost" size="sm"><IconArrowLeft className="size-4 mr-1" />Back</Button></Link>
        <p className="text-sm text-muted-foreground">Company not found.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <Link href="/crm/companies"><Button variant="ghost" size="icon-sm"><IconArrowLeft className="size-4" /></Button></Link>
          <div>
            <div className="flex items-center gap-2">
              <IconBuilding className="size-5 text-muted-foreground" />
              <h1 className="text-2xl font-semibold">{company.name}</h1>
            </div>
            <div className="flex items-center gap-3 mt-1 text-sm text-muted-foreground">
              {company.domain && (
                <a href={`https://${company.domain.replace(/^https?:\/\//, '')}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-blue-500 hover:underline">
                  <IconWorldWww className="size-3.5" />{company.domain}
                </a>
              )}
              {company.industry && <span>{company.industry}</span>}
              {company.org_number && <span>Org.nr {company.org_number}</span>}
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={startEditing}>
            <IconEdit className="size-4 mr-1" />Edit
          </Button>
          <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={handleDelete}>
            <IconTrash className="size-4 mr-1" />Delete
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div>
          <h2 className="text-lg font-medium mb-2">Contacts</h2>
          {contacts.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">No contacts.</p>
          ) : (
            <div className="rounded-lg border divide-y">
              {contacts.map(c => (
                <Link key={c.id} href={`/crm/contacts/${c.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-accent/50 transition-colors">
                  <IconUser className="size-4 text-muted-foreground shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{c.name}</p>
                    {(c.email || c.phone) && (
                      <p className="text-xs text-muted-foreground truncate">{c.email ?? c.phone}</p>
                    )}
                  </div>
                  {c.needs_review === 1 && <Badge variant="destructive" className="text-[10px]">Review</Badge>}
                </Link>
              ))}
            </div>
          )}
        </div>

        <div>
          <h2 className="text-lg font-medium mb-2">Deals</h2>
          {deals.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">No deals.</p>
          ) : (
            <div className="rounded-lg border divide-y">
              {deals.map(d => (
                <Link key={d.id} href={`/crm/deals/${d.id}`} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-accent/50 transition-colors">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{d.title}</p>
                    {d.contact_name && <p className="text-xs text-muted-foreground truncate">{d.contact_name}</p>}
                    {d.value_nok != null && (
                      <p className="text-xs text-emerald-600 dark:text-emerald-400 mt-0.5">{formatNOK(d.value_nok)}</p>
                    )}
                  </div>
                  <Badge variant="secondary" className={`${STAGE_COLORS[d.stage] ?? ''} shrink-0`}>{d.stage}</Badge>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>

      <div>
        <h3 className="text-sm font-medium mb-2">Details</h3>
        {editing ? (
          <div className="rounded-lg border p-4 space-y-3 max-w-2xl">
            <input type="text" placeholder="Name" value={editFields.name} onChange={e => setEditFields(f => ({ ...f, name: e.target.value }))}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
            <input type="text" placeholder="Domain (e.g. example.no)" value={editFields.domain} onChange={e => setEditFields(f => ({ ...f, domain: e.target.value }))}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
            <input type="text" placeholder="Industry" value={editFields.industry} onChange={e => setEditFields(f => ({ ...f, industry: e.target.value }))}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
            <textarea placeholder="Notes" value={editFields.notes} onChange={e => setEditFields(f => ({ ...f, notes: e.target.value }))}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring min-h-[80px]" />
            <div className="flex gap-2 justify-end">
              <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>Cancel</Button>
              <Button size="sm" onClick={handleSaveEdit} disabled={!editFields.name.trim()}>Save</Button>
            </div>
          </div>
        ) : (
          <div className="rounded-lg border p-4 space-y-1 text-sm text-muted-foreground max-w-2xl">
            {company.size && <p>Size: {company.size}</p>}
            <p>Added: {formatDate(company.created_at)}</p>
            {company.notes && <p className="text-foreground mt-2">{company.notes}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
