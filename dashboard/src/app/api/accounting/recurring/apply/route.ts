import { NextRequest } from 'next/server';
import { applyDueRecurring } from '@/lib/accounting/recurring';

export const dynamic = 'force-dynamic';

/**
 * Manually trigger the recurring-deduction engine. Default: process all eligible.
 * Same idempotency rules as the automatic apply (one expense per recurring per month).
 */
export async function POST(_request: NextRequest) {
  const inserted = applyDueRecurring();
  return Response.json({ ok: true, inserted });
}
