import { listInvoices, listPurchases } from '@/lib/fiken/client';
import { oreToNok, monthBounds, ytdBounds } from '@/lib/fiken/transforms';

export const dynamic = 'force-dynamic';

async function computePeriod(fromDate: string, toDate: string) {
  const [invRes, purRes] = await Promise.all([
    listInvoices({ fromDate, toDate }),
    listPurchases({ fromDate, toDate }),
  ]);

  const revenueOre = invRes.invoices.reduce((s, i) => s + i.net, 0);
  const vatCollectedOre = invRes.invoices.reduce((s, i) => s + i.vat, 0);
  const costsOre = purRes.purchases.reduce((s, p) => s + p.lines.reduce((ls, l) => ls + l.net, 0), 0);
  const vatPaidOre = purRes.purchases.reduce((s, p) => s + p.lines.reduce((ls, l) => ls + l.vat, 0), 0);

  return {
    revenue_nok: oreToNok(revenueOre),
    costs_nok: oreToNok(costsOre),
    profit_nok: oreToNok(revenueOre - costsOre),
    vat_balance_nok: oreToNok(vatCollectedOre - vatPaidOre),
    invoices_count: invRes.invoices.length,
    expenses_count: purRes.purchases.length,
    source: invRes.source,
  };
}

export async function GET() {
  try {
    const month = monthBounds();
    const ytd = ytdBounds();

    const [monthSummary, ytdSummary] = await Promise.all([
      computePeriod(month.startDate, month.endDate),
      computePeriod(ytd.startDate, ytd.endDate),
    ]);

    return Response.json({
      current_month: { period: 'current_month' as const, ...monthSummary },
      ytd: { period: 'ytd' as const, ...ytdSummary },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
