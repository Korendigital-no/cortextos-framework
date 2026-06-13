'use client';

/**
 * AddClientDialog — self-serve "add client" form (shadcn Dialog).
 *
 * Validation/normalization lives in lib/client-form (unit-tested); this is the
 * presentation + submit wiring to the existing POST /api/clients. Only the
 * company name is required. Errors surface inline (no toast dependency, so the
 * clients list page needs no ToastProvider).
 */

import { useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { IconPlus } from '@tabler/icons-react';
import { validateNewClient } from '@/lib/client-form';

export interface AddClientDialogProps {
  open: boolean;
  /** Called after a successful create so the parent can refetch the list. */
  onCreated: () => void;
  onCancel: () => void;
}

export default function AddClientDialog({ open, onCreated, onCancel }: AddClientDialogProps) {
  const [companyName, setCompanyName] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [dealType, setDealType] = useState('');
  const [rateNok, setRateNok] = useState('');
  const [hoursCommitment, setHoursCommitment] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Synchronous double-submit guard (disabled state lands only after re-render).
  const inFlight = useRef(false);

  const reset = () => {
    setCompanyName('');
    setContactName('');
    setContactEmail('');
    setDealType('');
    setRateNok('');
    setHoursCommitment('');
    setNotes('');
    setError(null);
  };

  const close = () => {
    reset();
    onCancel();
  };

  const handleSubmit = async () => {
    const result = validateNewClient({
      company_name: companyName,
      contact_name: contactName,
      contact_email: contactEmail,
      deal_type: dealType,
      rate_nok: rateNok,
      hours_commitment: hoursCommitment,
      notes,
    });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(result.payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error || 'Could not add client.');
        return;
      }
      reset();
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add client.');
    } finally {
      setSaving(false);
      inFlight.current = false;
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={o => {
        if (!o && !saving) close();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <IconPlus size={18} />
            Add client
          </DialogTitle>
          <DialogDescription>
            Only the company name is required — the rest can be filled in later.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="company_name">Company name *</Label>
            <Input id="company_name" value={companyName} onChange={e => setCompanyName(e.target.value)} placeholder="Acme AS" autoFocus />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="contact_name">Contact</Label>
              <Input id="contact_name" value={contactName} onChange={e => setContactName(e.target.value)} placeholder="Name" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="contact_email">Email</Label>
              <Input id="contact_email" type="email" value={contactEmail} onChange={e => setContactEmail(e.target.value)} placeholder="name@acme.no" />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="deal_type">Deal type</Label>
              <Input id="deal_type" value={dealType} onChange={e => setDealType(e.target.value)} placeholder="Retainer" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rate_nok">Rate (kr/t)</Label>
              <Input id="rate_nok" type="number" min="0" value={rateNok} onChange={e => setRateNok(e.target.value)} placeholder="1500" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="hours_commitment">Hours</Label>
              <Input id="hours_commitment" value={hoursCommitment} onChange={e => setHoursCommitment(e.target.value)} placeholder="10/mnd" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="notes">Notes</Label>
            <Textarea id="notes" value={notes} onChange={e => setNotes(e.target.value)} rows={2} placeholder="Optional" />
          </div>
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={saving || !companyName.trim()}>
            {saving ? 'Adding…' : 'Add client'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
