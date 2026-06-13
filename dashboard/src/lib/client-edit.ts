// cortextOS Dashboard - server-side helpers for editing/deleting a CRM client.
// Kept db-only (no React/Next import) so the edit + soft/hard-delete logic is
// unit-testable against an in-memory better-sqlite3.

import type Database from 'better-sqlite3';

/** Columns of crm_clients an operator may edit directly (allowlist — never
 *  interpolate raw body keys into SQL). company_name is handled separately
 *  because it resolves to a crm_companies row, not a column on crm_clients. */
export const CLIENT_EDITABLE_FIELDS = [
  'contact_name',
  'contact_email',
  'deal_type',
  'rate_nok',
  'rate_description',
  'hours_commitment',
  'notes',
  'status',
] as const;

const VALID_STATUSES = new Set(['active', 'inactive', 'archived', 'prospect', 'paused', 'churned']);

export function isValidClientStatus(s: unknown): s is string {
  return typeof s === 'string' && VALID_STATUSES.has(s);
}

/**
 * Reuse a company row by exact name, or create one. Returns its id. Mirrors the
 * POST /api/clients company logic so add and edit agree on company identity.
 * (A company can back several clients, so we reassign — never rename the shared
 * company row.)
 */
export function resolveCompanyId(
  database: Database.Database,
  companyName: string,
  now: string,
): string {
  const existing = database
    .prepare('SELECT id FROM crm_companies WHERE name = ?')
    .get(companyName) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  database
    .prepare('INSERT INTO crm_companies (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(id, companyName, now, now);
  return id;
}

/**
 * True if the client has ANY time-entry history — live OR soft-deleted. Such a
 * client carries billable/financial records (logged hours, basis for invoices),
 * which accounting integrity says must be ARCHIVED, never hard-deleted. Only a
 * client that has never had a single time entry is safe to truly delete.
 */
export function clientHasTimeHistory(database: Database.Database, clientId: string): boolean {
  const live = database
    .prepare('SELECT 1 FROM crm_time_entries WHERE client_id = ? LIMIT 1')
    .get(clientId);
  if (live) return true;
  // The trash table is dashboard-only; guard so a missing table never throws.
  try {
    const trashed = database
      .prepare('SELECT 1 FROM crm_time_entries_deleted WHERE client_id = ? LIMIT 1')
      .get(clientId);
    return !!trashed;
  } catch {
    return false;
  }
}

/**
 * Hard cascade-delete a client and its child rows, child-first (FK is ON). Only
 * call this for a client with NO time-entry history — it does not touch
 * crm_time_entries, because a client that ever logged time must be soft-archived
 * instead. Runs in a single transaction.
 */
export function hardDeleteClient(database: Database.Database, clientId: string): void {
  const txn = database.transaction(() => {
    database
      .prepare(
        'DELETE FROM crm_client_checklist_items WHERE checklist_id IN (SELECT id FROM crm_client_checklists WHERE client_id = ?)',
      )
      .run(clientId);
    database.prepare('DELETE FROM crm_client_checklists WHERE client_id = ?').run(clientId);
    database.prepare('DELETE FROM crm_client_notes WHERE client_id = ?').run(clientId);
    database.prepare('DELETE FROM crm_client_tasks WHERE client_id = ?').run(clientId);
    database.prepare('DELETE FROM crm_documents WHERE client_id = ?').run(clientId);
    database.prepare('DELETE FROM crm_client_projects WHERE client_id = ?').run(clientId);
    database.prepare('DELETE FROM crm_clients WHERE id = ?').run(clientId);
  });
  txn();
}
