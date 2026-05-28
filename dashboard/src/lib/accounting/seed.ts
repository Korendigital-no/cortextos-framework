import { db } from '@/lib/db';

/**
 * One-time seed of company accounts + YTD opening balances.
 * Idempotent: only seeds when accounts table is empty.
 */
export function seedAccountsIfEmpty(): { seeded: boolean } {
  const count = (db.prepare('SELECT COUNT(*) as c FROM accounting_accounts').get() as { c: number }).c;
  if (count > 0) return { seeded: false };

  const now = new Date().toISOString();
  const ops = crypto.randomUUID();
  const tax = crypto.randomUUID();
  const vat = crypto.randomUUID();

  const tx = db.transaction(() => {
    const insAcct = db.prepare(`
      INSERT INTO accounting_accounts (id, name, type, starting_balance_nok, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    insAcct.run(ops, 'Bedriftskonto', 'operating', 6588, now, now);
    insAcct.run(tax, 'Skattekonto', 'tax', 2060, now, now);
    insAcct.run(vat, 'MVA-konto', 'vat', 3591, now, now);

    // YTD opening balances — bookkeeping rows so revenue/cost/profit reflect prior activity.
    // 2026-01-01 keeps them in YTD without colliding with the user's first real entries.
    const openingInv = db.prepare(`
      INSERT INTO accounting_invoices (id, invoice_number, customer_name, issue_date, net_nok, vat_nok, settled, notes, account_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    openingInv.run(crypto.randomUUID(), 'OPENING-2026-YTD', 'Diverse (opening balance)', '2026-01-01', 7850, 0, 1, 'YTD opening balance — pre-app revenue', ops, now, now);

    const openingExp = db.prepare(`
      INSERT INTO accounting_expenses (id, supplier_name, description, date, net_nok, vat_nok, paid, account_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    openingExp.run(crypto.randomUUID(), 'Diverse (opening balance)', 'YTD opening balance — pre-app expenses', '2026-01-01', 16422, 0, 1, ops, now, now);
  });
  tx();

  return { seeded: true };
}
