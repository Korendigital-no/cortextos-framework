import { describe, it, expect } from 'vitest';
import { validateNewClient, validateClientEdit } from '../client-form';

describe('validateNewClient', () => {
  it('requires a company name', () => {
    expect(validateNewClient({ company_name: '' })).toEqual({ ok: false, error: 'Company name is required.' });
    expect(validateNewClient({ company_name: '   ' }).ok).toBe(false);
  });

  it('accepts a minimal client (company name only) with rate_nok null', () => {
    const r = validateNewClient({ company_name: '  Acme AS ' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload).toEqual({
        company_name: 'Acme AS',
        contact_name: undefined,
        contact_email: undefined,
        deal_type: undefined,
        rate_nok: null,
        hours_commitment: undefined,
        notes: undefined,
      });
    }
  });

  it('rejects a malformed email but accepts a blank one', () => {
    expect(validateNewClient({ company_name: 'A', contact_email: 'nope' }).ok).toBe(false);
    expect(validateNewClient({ company_name: 'A', contact_email: '' }).ok).toBe(true);
    const r = validateNewClient({ company_name: 'A', contact_email: ' a@b.no ' });
    expect(r.ok && r.payload.contact_email).toBe('a@b.no');
  });

  it('coerces a valid rate, rejects negative/non-numeric, treats blank as null', () => {
    const ok = validateNewClient({ company_name: 'A', rate_nok: '1500' });
    expect(ok.ok && ok.payload.rate_nok).toBe(1500);
    expect(validateNewClient({ company_name: 'A', rate_nok: '-5' }).ok).toBe(false);
    expect(validateNewClient({ company_name: 'A', rate_nok: 'abc' }).ok).toBe(false);
    const blank = validateNewClient({ company_name: 'A', rate_nok: '' });
    expect(blank.ok && blank.payload.rate_nok).toBe(null);
  });

  it('trims optional fields and drops empty ones to undefined', () => {
    const r = validateNewClient({
      company_name: 'A',
      contact_name: '  Bob ',
      deal_type: '   ',
      hours_commitment: '10/mnd',
      notes: '  ',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.contact_name).toBe('Bob');
      expect(r.payload.deal_type).toBeUndefined();
      expect(r.payload.hours_commitment).toBe('10/mnd');
      expect(r.payload.notes).toBeUndefined();
    }
  });
});

describe('validateClientEdit', () => {
  it('inherits the add rules (company required, email, non-negative rate)', () => {
    expect(validateClientEdit({ company_name: '' }).ok).toBe(false);
    expect(validateClientEdit({ company_name: 'A', contact_email: 'nope' }).ok).toBe(false);
    expect(validateClientEdit({ company_name: 'A', rate_nok: '-5' }).ok).toBe(false);
  });

  it('clears emptied text fields to null (not undefined) so the column blanks', () => {
    const r = validateClientEdit({
      company_name: 'Acme AS',
      contact_name: '',
      deal_type: '   ',
      rate_description: '',
      hours_commitment: '',
      notes: '',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      // null = "clear this column" (undefined would skip it in the PATCH)
      expect(r.payload.contact_name).toBeNull();
      expect(r.payload.deal_type).toBeNull();
      expect(r.payload.rate_description).toBeNull();
      expect(r.payload.hours_commitment).toBeNull();
      expect(r.payload.notes).toBeNull();
    }
  });

  it('carries edit-only fields (rate_description, status) through', () => {
    const r = validateClientEdit({
      company_name: 'Acme AS',
      contact_name: 'Bob',
      rate_nok: '1500',
      rate_description: 'eks MVA',
      status: 'paused',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.contact_name).toBe('Bob');
      expect(r.payload.rate_nok).toBe(1500);
      expect(r.payload.rate_description).toBe('eks MVA');
      expect(r.payload.status).toBe('paused');
    }
  });

  it('omits status when not provided (no accidental status change on edit)', () => {
    const r = validateClientEdit({ company_name: 'Acme AS' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.status).toBeUndefined();
  });
});
