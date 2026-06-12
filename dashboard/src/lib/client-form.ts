/**
 * Pure validation + normalization for the self-serve "add client" form.
 *
 * Extracted from AddClientDialog so the rules (required company name, optional
 * email format, optional non-negative rate) are unit-testable without a React
 * harness. The dashboard has no component-test setup; this keeps the form's
 * logic under test. Mirrors the POST /api/clients contract (company_name
 * required; everything else optional → omitted/null).
 */

export interface NewClientInput {
  company_name: string;
  contact_name?: string;
  contact_email?: string;
  deal_type?: string;
  /** Raw form string; validated + coerced to number|null. */
  rate_nok?: string;
  hours_commitment?: string;
  notes?: string;
}

export interface NewClientPayload {
  company_name: string;
  contact_name?: string;
  contact_email?: string;
  deal_type?: string;
  rate_nok: number | null;
  hours_commitment?: string;
  notes?: string;
}

export type NewClientValidation =
  | { ok: true; payload: NewClientPayload }
  | { ok: false; error: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateNewClient(input: NewClientInput): NewClientValidation {
  const company_name = (input.company_name ?? '').trim();
  if (!company_name) return { ok: false, error: 'Company name is required.' };

  const email = (input.contact_email ?? '').trim();
  if (email && !EMAIL_RE.test(email)) {
    return { ok: false, error: 'Enter a valid email, or leave it blank.' };
  }

  let rate_nok: number | null = null;
  const rateRaw = (input.rate_nok ?? '').trim();
  if (rateRaw) {
    const n = Number(rateRaw);
    if (!Number.isFinite(n) || n < 0) {
      return { ok: false, error: 'Rate must be a positive number, or leave it blank.' };
    }
    rate_nok = n;
  }

  const opt = (v?: string) => {
    const t = (v ?? '').trim();
    return t || undefined;
  };

  return {
    ok: true,
    payload: {
      company_name,
      contact_name: opt(input.contact_name),
      contact_email: email || undefined,
      deal_type: opt(input.deal_type),
      rate_nok,
      hours_commitment: opt(input.hours_commitment),
      notes: opt(input.notes),
    },
  };
}
