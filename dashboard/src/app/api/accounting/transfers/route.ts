import { NextRequest } from 'next/server';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(d: unknown): d is string {
  if (typeof d !== 'string' || !ISO_DATE.test(d)) return false;
  const [y, m, day] = d.split('-').map(Number);
  const dt = new Date(y, m - 1, day);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === day;
}

// A transfer amount must be STRICTLY positive — a zero/negative "movement" is
// meaningless, and the table CHECK rejects it. Validate here for a clean 400.
function isPositiveAmount(n: unknown): n is number {
  return typeof n === 'number' && isFinite(n) && n > 0 && n < 1e12;
}

export async function GET() {
  const rows = db.prepare(`
    SELECT t.id, t.from_account_id, t.to_account_id, t.amount_nok, t.date, t.kind,
      t.description, t.created_at,
      f.name AS from_account_name, dst.name AS to_account_name
    FROM accounting_transfers t
    LEFT JOIN accounting_accounts f ON t.from_account_id = f.id
    LEFT JOIN accounting_accounts dst ON t.to_account_id = dst.id
    ORDER BY t.date DESC, t.created_at DESC
    LIMIT 100
  `).all();
  return Response.json({ transfers: rows });
}

export async function POST(request: NextRequest) {
  // Auth: /api/accounting/* is gated by proxy.ts (401 on unauth, accepting BOTH a
  // cookie session and the mobile Bearer token) — consistent with the other
  // accounting write routes (invoices/expenses/recurring). We deliberately do NOT
  // add a route-local cookie-only guard: it would 401 valid Bearer/API clients the
  // proxy accepts. (Real defense-in-depth for financial writes is worth doing, but
  // as ONE shared bearer-aware guard across ALL accounting write routes — a
  // follow-up, see PR notes — not a transfers-only cookie check.)
  const body = await request.json();
  const { from_account_id, amount_nok, date, description } = body;
  const kind = body.kind === 'owner_draw' ? 'owner_draw' : 'transfer';

  if (!from_account_id || typeof from_account_id !== 'string') {
    return Response.json({ error: 'from_account_id required' }, { status: 400 });
  }
  if (!isPositiveAmount(amount_nok)) {
    return Response.json({ error: 'amount_nok must be a positive finite number' }, { status: 400 });
  }
  if (!isValidDate(date)) {
    return Response.json({ error: 'date must be YYYY-MM-DD' }, { status: 400 });
  }

  // Resolve the destination. An owner's draw (privatuttak) is modeled as a
  // transfer TO the tag-only 'personal' account — so the UI never picks a
  // destination, we look it up; its balance is force-zeroed elsewhere, so the net
  // effect is exactly "money out of the source account". A plain transfer takes
  // an explicit to_account_id.
  let to_account_id: string;
  if (kind === 'owner_draw') {
    const personal = db.prepare(
      "SELECT id FROM accounting_accounts WHERE type = 'personal' LIMIT 1",
    ).get() as { id: string } | undefined;
    if (!personal) {
      return Response.json({ error: 'No personal account configured for owner draws' }, { status: 400 });
    }
    to_account_id = personal.id;
  } else {
    if (!body.to_account_id || typeof body.to_account_id !== 'string') {
      return Response.json({ error: 'to_account_id required' }, { status: 400 });
    }
    to_account_id = body.to_account_id;
  }

  if (from_account_id === to_account_id) {
    return Response.json({ error: 'from and to accounts must differ' }, { status: 400 });
  }

  // Clean-error existence pre-check + type lookup. The FK is the real atomic guard
  // on insert (see catch below); this yields friendly 400s and lets us enforce the
  // 'personal' rule below.
  const lookup = db.prepare('SELECT type FROM accounting_accounts WHERE id = ?');
  const fromType = (lookup.get(from_account_id) as { type: string } | undefined)?.type;
  const toType = (lookup.get(to_account_id) as { type: string } | undefined)?.type;
  if (!fromType) {
    return Response.json({ error: 'from_account_id does not reference an existing account' }, { status: 400 });
  }
  if (!toType) {
    return Response.json({ error: 'to_account_id does not reference an existing account' }, { status: 400 });
  }

  // The 'personal' account is a tag-only bucket whose balance is force-zeroed in
  // the accounts view, so a PLAIN transfer touching it would silently break the
  // net-zero invariant (source debited, but the force-zeroed personal side is
  // never credited). Money may only flow OUT of the business into 'personal' via
  // an owner's draw. Therefore:
  //   - no transfer of either kind may originate FROM 'personal', and
  //   - a regular transfer may not target 'personal' (that is an owner_draw).
  if (fromType === 'personal') {
    return Response.json({ error: 'Kan ikke overføre fra privatkontoen — velg en vanlig konto som kilde' }, { status: 400 });
  }
  if (kind === 'transfer' && toType === 'personal') {
    return Response.json({ error: 'Bruk Privatuttak for å føre penger til privatkontoen (ikke en vanlig overføring)' }, { status: 400 });
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  // The single row IS the whole movement: the per-account balance query reads it
  // once as +in (to) and once as -out (from), so the cross-account total is always
  // net-zero — no second row can drift. Wrap the insert in a transaction so the
  // FK/CHECK-enforced write is one consistent unit (and stays atomic if extended).
  const insert = db.transaction(() => {
    db.prepare(`
      INSERT INTO accounting_transfers
        (id, from_account_id, to_account_id, amount_nok, date, kind, description, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, from_account_id, to_account_id, amount_nok, date, kind, description ?? null, now, now);
  });

  try {
    insert();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Race (account deleted between pre-check and insert) or any constraint
    // violation → a clean 400 rather than a 500.
    if (/FOREIGN KEY constraint failed|CHECK constraint failed/i.test(msg)) {
      return Response.json({ error: 'invalid transfer: referenced account missing or amount/accounts invalid' }, { status: 400 });
    }
    throw err;
  }

  return Response.json({ id, kind }, { status: 201 });
}

export async function DELETE(request: NextRequest) {
  // Auth: proxy-gated like the other accounting routes (see POST).
  const { searchParams } = request.nextUrl;
  const id = searchParams.get('id');
  if (!id) return Response.json({ error: 'id required' }, { status: 400 });
  db.prepare('DELETE FROM accounting_transfers WHERE id = ?').run(id);
  return Response.json({ ok: true });
}
