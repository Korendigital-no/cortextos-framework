import { db } from '@/lib/db';
import { monthBounds, ytdBounds } from '@/lib/fiken/transforms';

export const dynamic = 'force-dynamic';

function computePeriod(startDate: string, endDate: string) {
  const inv = db.prepare(`
    SELECT COALESCE(SUM(net_nok), 0) as net, COALESCE(SUM(vat_nok), 0) as vat, COUNT(*) as c
    FROM accounting_invoices WHERE issue_date >= ? AND issue_date <= ?
  `).get(startDate, endDate) as { net: number; vat: number; c: number };

  const exp = db.prepare(`
    SELECT COALESCE(SUM(net_nok), 0) as net, COALESCE(SUM(vat_nok), 0) as vat, COUNT(*) as c
    FROM accounting_expenses WHERE date >= ? AND date <= ?
  `).get(startDate, endDate) as { net: number; vat: number; c: number };

  return {
    revenue_nok: inv.net,
    costs_nok: exp.net,
    profit_nok: inv.net - exp.net,
    vat_balance_nok: inv.vat - exp.vat,
    invoices_count: inv.c,
    expenses_count: exp.c,
    source: 'manual' as const,
  };
}

export async function GET() {
  const month = monthBounds();
  const ytd = ytdBounds();

  return Response.json({
    current_month: { period: 'current_month' as const, ...computePeriod(month.startDate, month.endDate) },
    ytd: { period: 'ytd' as const, ...computePeriod(ytd.startDate, ytd.endDate) },
  });
}
