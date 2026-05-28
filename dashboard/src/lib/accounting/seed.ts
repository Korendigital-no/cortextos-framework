import { db } from '@/lib/db';

/**
 * Seed company accounts. Two passes:
 *  1. Fresh DB (count==0): insert all 4 starter accounts.
 *  2. Existing DB missing a 'personal' account: upsert just that one. Cheap on
 *     subsequent boots — a single SELECT.
 *
 * Revenue/cost tracking starts from zero. Privat is a tag-only bucket: expenses
 * tagged to it count in revenue/cost totals but never affect any balance.
 */
export function seedAccountsIfEmpty(): { seeded: boolean; addedPersonal: boolean } {
  const count = (db.prepare('SELECT COUNT(*) as c FROM accounting_accounts').get() as { c: number }).c;
  const now = new Date().toISOString();
  const insAcct = db.prepare(`
    INSERT INTO accounting_accounts (id, name, type, starting_balance_nok, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  if (count === 0) {
    const tx = db.transaction(() => {
      insAcct.run(crypto.randomUUID(), 'Bedriftskonto', 'operating', 6588, now, now);
      insAcct.run(crypto.randomUUID(), 'Skattekonto', 'tax', 2060, now, now);
      insAcct.run(crypto.randomUUID(), 'MVA-konto', 'vat', 3591, now, now);
      insAcct.run(crypto.randomUUID(), 'Privat', 'personal', 0, now, now);
    });
    tx();
    return { seeded: true, addedPersonal: true };
  }

  // Existing DB — only upsert the personal account if it's missing.
  const hasPersonal = (db.prepare(
    "SELECT 1 FROM accounting_accounts WHERE type = 'personal' LIMIT 1",
  ).get() as unknown) !== undefined;
  if (!hasPersonal) {
    insAcct.run(crypto.randomUUID(), 'Privat', 'personal', 0, now, now);
    return { seeded: false, addedPersonal: true };
  }

  return { seeded: false, addedPersonal: false };
}
