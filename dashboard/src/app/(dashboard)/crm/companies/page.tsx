'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { IconArrowLeft, IconSearch, IconBuildingPlus } from '@tabler/icons-react';

interface Company {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  org_number: string | null;
  contact_count: number;
  active_deals: number;
  created_at: string;
}

export default function CompaniesPage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDomain, setNewDomain] = useState('');

  const fetchCompanies = useCallback(async () => {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    try {
      const res = await fetch(`/api/crm/companies?${params}`);
      if (res.ok) setCompanies(await res.json());
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    setLoading(true);
    const timer = setTimeout(fetchCompanies, 300);
    return () => clearTimeout(timer);
  }, [fetchCompanies]);

  async function handleCreate() {
    if (!newName.trim()) return;
    const res = await fetch('/api/crm/companies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName.trim(), domain: newDomain.trim() || null }),
    });
    if (res.ok) {
      setNewName('');
      setNewDomain('');
      setShowAdd(false);
      fetchCompanies();
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link href="/crm">
          <Button variant="ghost" size="icon-sm">
            <IconArrowLeft className="size-4" />
          </Button>
        </Link>
        <h1 className="text-2xl font-semibold">Companies</h1>
      </div>

      <div className="flex gap-2">
        <div className="relative flex-1">
          <IconSearch className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search companies..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full rounded-md border bg-background pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <Button size="sm" onClick={() => setShowAdd(!showAdd)}>
          <IconBuildingPlus className="size-4 mr-1" />
          Add
        </Button>
      </div>

      {showAdd && (
        <div className="rounded-lg border bg-card p-4 space-y-3">
          <div className="flex gap-2">
            <input type="text" placeholder="Company name" value={newName} onChange={e => setNewName(e.target.value)}
              className="flex-1 rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" autoFocus />
            <input type="text" placeholder="Domain (e.g. acme.no)" value={newDomain} onChange={e => setNewDomain(e.target.value)}
              className="flex-1 rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" size="sm" onClick={() => setShowAdd(false)}>Cancel</Button>
            <Button size="sm" onClick={handleCreate} disabled={!newName.trim()}>Create</Button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-14 rounded-lg bg-muted/30 animate-pulse" />
          ))}
        </div>
      ) : companies.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          {search ? 'No companies match your search.' : 'No companies yet.'}
        </p>
      ) : (
        <div className="rounded-lg border divide-y">
          {companies.map(company => (
            <div key={company.id} className="flex items-center justify-between px-4 py-3 hover:bg-accent/50 transition-colors">
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{company.name}</p>
                <p className="text-xs text-muted-foreground truncate">
                  {[company.domain, company.industry].filter(Boolean).join(' · ')}
                </p>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                {company.contact_count > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {company.contact_count} contact{company.contact_count !== 1 ? 's' : ''}
                  </span>
                )}
                {company.active_deals > 0 && (
                  <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                    {company.active_deals} deal{company.active_deals !== 1 ? 's' : ''}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
