import { listPurchases } from '@/lib/fiken/client';
import { oreToNok } from '@/lib/fiken/transforms';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const { purchases, source } = await listPurchases();
    const out = purchases
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 20)
      .map(p => {
        const net = p.lines.reduce((s, l) => s + l.net, 0);
        const vat = p.lines.reduce((s, l) => s + l.vat, 0);
        const gross = p.lines.reduce((s, l) => s + l.gross, 0);
        const description = p.lines.map(l => l.description).filter(Boolean).join(', ');
        return {
          transactionId: p.transactionId,
          date: p.date,
          kind: p.kind,
          paid: p.paid,
          supplier_name: p.supplier?.name ?? null,
          description: description || null,
          net_nok: oreToNok(net),
          vat_nok: oreToNok(vat),
          gross_nok: oreToNok(gross),
        };
      });
    return Response.json({ expenses: out, source });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
