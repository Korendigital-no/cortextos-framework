'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { IconPlus } from '@tabler/icons-react';

interface CreateDealDialogProps {
  onCreated: () => void;
}

export function CreateDealDialog({ onCreated }: CreateDealDialogProps) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [value, setValue] = useState('');
  const [stage, setStage] = useState('lead');
  const [loading, setLoading] = useState(false);

  async function handleCreate() {
    if (!title.trim()) return;
    setLoading(true);
    try {
      const res = await fetch('/api/crm/deals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          value_nok: value ? parseFloat(value) : null,
          stage,
        }),
      });
      if (res.ok) {
        setTitle('');
        setValue('');
        setStage('lead');
        setOpen(false);
        onCreated();
      }
    } finally {
      setLoading(false);
    }
  }

  if (!open) {
    return (
      <Button size="sm" onClick={() => setOpen(true)}>
        <IconPlus className="size-4 mr-1" />
        Add Deal
      </Button>
    );
  }

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      <input
        type="text"
        placeholder="Deal title"
        value={title}
        onChange={e => setTitle(e.target.value)}
        className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        autoFocus
      />
      <div className="flex gap-2">
        <input
          type="number"
          placeholder="Value (NOK)"
          value={value}
          onChange={e => setValue(e.target.value)}
          className="flex-1 rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <select
          value={stage}
          onChange={e => setStage(e.target.value)}
          className="rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="lead">Lead</option>
          <option value="qualified">Qualified</option>
          <option value="proposal">Proposal</option>
          <option value="negotiation">Negotiation</option>
        </select>
      </div>
      <div className="flex gap-2 justify-end">
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
        <Button size="sm" onClick={handleCreate} disabled={loading || !title.trim()}>
          {loading ? 'Creating...' : 'Create'}
        </Button>
      </div>
    </div>
  );
}
