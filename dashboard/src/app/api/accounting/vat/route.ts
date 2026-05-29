import { db } from '@/lib/db';
import { currentVatPeriod } from '@/lib/fiken/transforms';

export const dynamic = 'force-dynamic';

export async function GET() {
  const period = currentVatPeriod();

  const inv = db.prepare(`
    SELECT COALESCE(SUM(vat_nok), 0) as vat FROM accounting_invoices
    WHERE issue_date >= ? AND issue_date <= ?
  `).get(period.startDate, period.endDate) as { vat: number };

  const exp = db.prepare(`
    SELECT COALESCE(SUM(vat_nok), 0) as vat FROM accounting_expenses
    WHERE date >= ? AND date <= ?
  `).get(period.startDate, period.endDate) as { vat: number };

  const balance = inv.vat - exp.vat;

  return Response.json({
    period: period.label,
    period_number: period.number,
    start_date: period.startDate,
    end_date: period.endDate,
    vat_collected_nok: inv.vat,
    vat_paid_nok: exp.vat,
    balance_nok: balance,
    direction: balance > 0 ? 'owed' : balance < 0 ? 'refundable' : 'zero',
    source: 'manual' as const,
  });
}
