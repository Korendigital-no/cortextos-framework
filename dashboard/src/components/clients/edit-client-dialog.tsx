'use client';

/**
 * EditClientDialog — edit every client field (shadcn Dialog), pre-filled from
 * the current client. Validation/normalization lives in lib/client-form
 * (validateClientEdit, unit-tested); this is presentation + the PATCH wiring to
 * /api/clients/[id]. Cleared text fields blank the column (validateClientEdit
 * sends null). Only the company name is required.
 */

import { useEffect, useRef, useState } from 'react';
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
import { IconPencil } from '@tabler/icons-react';
import { validateClientEdit } from '@/lib/client-form';

export interface EditClientValues {
  id: string;
  company_name: string;
  contact_name: string | null;
  contact_email: string | null;
  deal_type: string | null;
  rate_nok: number | null;
  rate_description?: string | null;
  hours_commitment: string | null;
  status: string;
  notes: string | null;
}

export interface EditClientDialogProps {
  open: boolean;
  client: EditClientValues;
  /** Called after a successful update so the parent can refetch. */
  onSaved: () => void;
  onCancel: () => void;
}

const STATUS_OPTIONS = ['active', 'paused', 'inactive', 'prospect', 'churned'];

export interface EditClientFormState {
  companyName: string;
  contactName: string;
  contactEmail: string;
  dealType: string;
  rateNok: string;
  rateDescription: string;
  hoursCommitment: string;
  status: string;
  notes: string;
}

export function formStateFromClient(client: EditClientValues): EditClientFormState {
  return {
    companyName: client.company_name,
    contactName: client.contact_name ?? '',
    contactEmail: client.contact_email ?? '',
    dealType: client.deal_type ?? '',
    rateNok: client.rate_nok != null ? String(client.rate_nok) : '',
    rateDescription: client.rate_description ?? '',
    hoursCommitment: client.hours_commitment ?? '',
    status: client.status || 'active',
    notes: client.notes ?? '',
  };
}

export default function EditClientDialog({ open, client, onSaved, onCancel }: EditClientDialogProps) {
  const initialForm = formStateFromClient(client);
  const [companyName, setCompanyName] = useState(initialForm.companyName);
  const [contactName, setContactName] = useState(initialForm.contactName);
  const [contactEmail, setContactEmail] = useState(initialForm.contactEmail);
  const [dealType, setDealType] = useState(initialForm.dealType);
  const [rateNok, setRateNok] = useState(initialForm.rateNok);
  const [rateDescription, setRateDescription] = useState(initialForm.rateDescription);
  const [hoursCommitment, setHoursCommitment] = useState(initialForm.hoursCommitment);
  const [status, setStatus] = useState(initialForm.status);
  const [notes, setNotes] = useState(initialForm.notes);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    if (!open) return;
    const next = formStateFromClient(client);
    setCompanyName(next.companyName);
    setContactName(next.contactName);
    setContactEmail(next.contactEmail);
    setDealType(next.dealType);
    setRateNok(next.rateNok);
    setRateDescription(next.rateDescription);
    setHoursCommitment(next.hoursCommitment);
    setStatus(next.status);
    setNotes(next.notes);
    setError(null);
    // Intentionally depend on the primitive client fields instead of the client
    // object so kept-mounted dialogs reset on fresh payloads without relying on
    // parent object identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    open,
    client.id,
    client.company_name,
    client.contact_name,
    client.contact_email,
    client.deal_type,
    client.rate_nok,
    client.rate_description,
    client.hours_commitment,
    client.status,
    client.notes,
  ]);

  const handleSubmit = async () => {
    const result = validateClientEdit({
      company_name: companyName,
      contact_name: contactName,
      contact_email: contactEmail,
      deal_type: dealType,
      rate_nok: rateNok,
      rate_description: rateDescription,
      hours_commitment: hoursCommitment,
      notes,
      status,
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
      const res = await fetch(`/api/clients/${client.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(result.payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error || 'Could not save changes.');
        return;
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save changes.');
    } finally {
      setSaving(false);
      inFlight.current = false;
    }
  };

  return (
    <Dialog open={open} onOpenChange={o => { if (!o && !saving) onCancel(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <IconPencil size={18} />
            Edit client
          </DialogTitle>
          <DialogDescription>Update any field. Only the company name is required.</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="e_company_name">Company name *</Label>
            <Input id="e_company_name" value={companyName} onChange={e => setCompanyName(e.target.value)} autoFocus />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="e_contact_name">Contact</Label>
              <Input id="e_contact_name" value={contactName} onChange={e => setContactName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="e_contact_email">Email</Label>
              <Input id="e_contact_email" type="email" value={contactEmail} onChange={e => setContactEmail(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="e_deal_type">Deal type</Label>
              <Input id="e_deal_type" value={dealType} onChange={e => setDealType(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="e_rate_nok">Rate (kr/t)</Label>
              <Input id="e_rate_nok" type="number" min="0" value={rateNok} onChange={e => setRateNok(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="e_status">Status</Label>
              <select
                id="e_status"
                value={status}
                onChange={e => setStatus(e.target.value)}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="e_hours_commitment">Hours</Label>
              <Input id="e_hours_commitment" value={hoursCommitment} onChange={e => setHoursCommitment(e.target.value)} placeholder="10/mnd" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="e_rate_description">Rate note</Label>
              <Input id="e_rate_description" value={rateDescription} onChange={e => setRateDescription(e.target.value)} placeholder="eks MVA" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="e_notes">Notes</Label>
            <Textarea id="e_notes" value={notes} onChange={e => setNotes(e.target.value)} rows={2} />
          </div>
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={saving}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={saving || !companyName.trim()}>
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
