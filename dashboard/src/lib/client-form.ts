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

export interface EditClientInput extends NewClientInput {
  rate_description?: string;
  status?: string;
}

/**
 * Edit payload. Unlike add, every editable text field is `string | null` — the
 * PATCH route applies every provided key, so a cleared field must send `null`
 * to blank the column (an `undefined` would skip it and leave the old value).
 */
export interface EditClientPayload {
  company_name: string;
  contact_name: string | null;
  contact_email: string | null;
  deal_type: string | null;
  rate_nok: number | null;
  rate_description: string | null;
  hours_commitment: string | null;
  notes: string | null;
  status?: string;
}

export type EditClientValidation =
  | { ok: true; payload: EditClientPayload }
  | { ok: false; error: string };

/**
 * Validate the edit-client form. Same rules as add (company name required,
 * optional valid email, non-negative rate) plus the edit-only fields
 * (rate_description, status). Cleared text fields become `null` so the server
 * blanks them. The status string is validated server-side against the canonical
 * set; the form only offers valid options.
 */
export function validateClientEdit(input: EditClientInput): EditClientValidation {
  const base = validateNewClient(input);
  if (!base.ok) return base;

  const orNull = (v?: string) => {
    const t = (v ?? '').trim();
    return t ? t : null;
  };

  const payload: EditClientPayload = {
    company_name: base.payload.company_name,
    contact_name: orNull(input.contact_name),
    contact_email: orNull(input.contact_email),
    deal_type: orNull(input.deal_type),
    rate_nok: base.payload.rate_nok,
    rate_description: orNull(input.rate_description),
    hours_commitment: orNull(input.hours_commitment),
    notes: orNull(input.notes),
  };
  if (input.status !== undefined) payload.status = input.status;
  return { ok: true, payload };
}
