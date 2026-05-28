import { db } from '@/lib/db';

/**
 * One-time seed of the 3 company accounts. Idempotent: only seeds when the
 * accounts table is empty. Revenue/cost tracking starts from zero — Vilhelm
 * logs entries manually.
 */
export function seedAccountsIfEmpty(): { seeded: boolean } {
  const count = (db.prepare('SELECT COUNT(*) as c FROM accounting_accounts').get() as { c: number }).c;
  if (count > 0) return { seeded: false };

  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    const insAcct = db.prepare(`
      INSERT INTO accounting_accounts (id, name, type, starting_balance_nok, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    insAcct.run(crypto.randomUUID(), 'Bedriftskonto', 'operating', 6588, now, now);
    insAcct.run(crypto.randomUUID(), 'Skattekonto', 'tax', 2060, now, now);
    insAcct.run(crypto.randomUUID(), 'MVA-konto', 'vat', 3591, now, now);
  });
  tx();

  return { seeded: true };
}
