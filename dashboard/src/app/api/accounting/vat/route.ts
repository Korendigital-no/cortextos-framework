import { listInvoices, listPurchases } from '@/lib/fiken/client';
import { oreToNok, currentVatPeriod } from '@/lib/fiken/transforms';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const period = currentVatPeriod();

    const [invRes, purRes] = await Promise.all([
      listInvoices({ fromDate: period.startDate, toDate: period.endDate }),
      listPurchases({ fromDate: period.startDate, toDate: period.endDate }),
    ]);

    const vatCollectedOre = invRes.invoices.reduce((s, i) => s + i.vat, 0);
    const vatPaidOre = purRes.purchases.reduce((s, p) => s + p.lines.reduce((ls, l) => ls + l.vat, 0), 0);
    const balanceOre = vatCollectedOre - vatPaidOre;

    return Response.json({
      period: period.label,
      period_number: period.number,
      start_date: period.startDate,
      end_date: period.endDate,
      vat_collected_nok: oreToNok(vatCollectedOre),
      vat_paid_nok: oreToNok(vatPaidOre),
      balance_nok: oreToNok(balanceOre),
      direction: balanceOre > 0 ? 'owed' : balanceOre < 0 ? 'refundable' : 'zero',
      source: invRes.source,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
