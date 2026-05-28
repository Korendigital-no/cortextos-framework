import { listInvoices } from '@/lib/fiken/client';
import { oreToNok } from '@/lib/fiken/transforms';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const { invoices, source } = await listInvoices();
    const out = invoices
      .sort((a, b) => b.issueDate.localeCompare(a.issueDate))
      .slice(0, 20)
      .map(i => ({
        invoiceId: i.invoiceId,
        invoiceNumber: i.invoiceNumber,
        issueDate: i.issueDate,
        dueDate: i.dueDate,
        net_nok: oreToNok(i.net),
        vat_nok: oreToNok(i.vat),
        gross_nok: oreToNok(i.gross),
        settled: i.settled,
        currency: i.currency,
        customer_name: i.customer?.name ?? null,
      }));
    return Response.json({ invoices: out, source });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
