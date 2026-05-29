import { db } from '@/lib/db';

/** Format Date as YYYY-MM-DD using local time (no UTC drift). */
function fmtLocalDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** YYYY-MM (local) for the given date. */
function fmtLocalYm(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Last calendar day of the given year+month0. */
function lastDayOfMonth(year: number, month0: number): number {
  return new Date(year, month0 + 1, 0).getDate();
}

interface RecurringRow {
  id: string;
  name: string;
  account_id: string;
  amount_nok: number;
  day_of_month: number;
  apply_on_last_day: number;
  last_applied_ym: string | null;
}

/**
 * Post a recurring expense entry for the current month if it's due and hasn't
 * been applied yet. Idempotent at the (recurring, YYYY-MM) granularity.
 *
 * Returns the number of new expense rows inserted.
 */
export function applyDueRecurring(now: Date = new Date()): number {
  const currentYm = fmtLocalYm(now);
  const todayDay = now.getDate();
  const lastDayThisMonth = lastDayOfMonth(now.getFullYear(), now.getMonth());

  const due = db.prepare(`
    SELECT id, name, account_id, amount_nok, day_of_month, apply_on_last_day, last_applied_ym
    FROM accounting_recurring
    WHERE active = 1 AND (last_applied_ym IS NULL OR last_applied_ym <> ?)
  `).all(currentYm) as RecurringRow[];

  if (due.length === 0) return 0;

  const insertExpense = db.prepare(`
    INSERT INTO accounting_expenses (id, supplier_name, description, date, net_nok, vat_nok, paid, account_id, recurring_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const markApplied = db.prepare(`UPDATE accounting_recurring SET last_applied_ym = ?, updated_at = ? WHERE id = ?`);

  let inserted = 0;
  const tx = db.transaction(() => {
    for (const r of due) {
      const targetDay = r.apply_on_last_day ? lastDayThisMonth : r.day_of_month;
      if (todayDay < targetDay) continue; // not due yet this month

      const postingDate = fmtLocalDate(new Date(now.getFullYear(), now.getMonth(), targetDay));
      const nowIso = new Date().toISOString();
      try {
        insertExpense.run(
          crypto.randomUUID(),
          r.name,
          '[Recurring]',
          postingDate,
          r.amount_nok,
          0,
          1,
          r.account_id,
          r.id,
          nowIso,
          nowIso,
        );
        inserted++;
      } catch (err) {
        // Hard guard against double-post under concurrent calls. The unique index on
        // (recurring_id, YYYY-MM) ensures only one posts; the loser swallows and
        // proceeds to mark applied (idempotent).
        if (!(err instanceof Error && /UNIQUE constraint failed.*recurring_id/i.test(err.message))) {
          throw err;
        }
      }
      markApplied.run(currentYm, nowIso, r.id);
    }
  });
  tx();

  return inserted;
}
