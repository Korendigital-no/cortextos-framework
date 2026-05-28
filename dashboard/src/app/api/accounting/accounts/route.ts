import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { seedAccountsIfEmpty } from '@/lib/accounting/seed';
import { applyDueRecurring } from '@/lib/accounting/recurring';

export const dynamic = 'force-dynamic';

const VALID_TYPES = new Set(['operating', 'tax', 'vat', 'other']);

function isFiniteAmount(n: unknown): n is number {
  return typeof n === 'number' && isFinite(n) && Math.abs(n) < 1e12;
}

export async function GET() {
  seedAccountsIfEmpty();
  applyDueRecurring();

  const accounts = db.prepare(`
    SELECT a.id, a.name, a.type, a.starting_balance_nok, a.created_at, a.updated_at,
      COALESCE((SELECT SUM(net_nok + vat_nok) FROM accounting_invoices WHERE account_id = a.id AND settled = 1), 0) AS settled_invoices_nok,
      COALESCE((SELECT SUM(net_nok + vat_nok) FROM accounting_expenses WHERE account_id = a.id AND paid = 1), 0) AS paid_expenses_nok
    FROM accounting_accounts a
    ORDER BY
      CASE a.type WHEN 'operating' THEN 1 WHEN 'tax' THEN 2 WHEN 'vat' THEN 3 WHEN 'personal' THEN 4 ELSE 5 END,
      a.name
  `).all() as Array<{
    id: string; name: string; type: string;
    starting_balance_nok: number; settled_invoices_nok: number; paid_expenses_nok: number;
    created_at: string; updated_at: string;
  }>;

  const withBalance = accounts.map(a => {
    // 'personal' is a tag-only bucket: expenses tagged here still count in
    // revenue/cost totals but must never affect a balance. Force the totals
    // visible on the card to zero so the UI can't mislead.
    if (a.type === 'personal') {
      return {
        ...a,
        starting_balance_nok: 0,
        settled_invoices_nok: 0,
        paid_expenses_nok: 0,
        balance_nok: 0,
      };
    }
    return {
      ...a,
      balance_nok: a.starting_balance_nok + a.settled_invoices_nok - a.paid_expenses_nok,
    };
  });

  return Response.json({ accounts: withBalance });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { name, type, starting_balance_nok } = body;

  if (!name || typeof name !== 'string') return Response.json({ error: 'name required' }, { status: 400 });
  if (!VALID_TYPES.has(type)) return Response.json({ error: 'type must be one of: operating, tax, vat, other' }, { status: 400 });
  const startBal = starting_balance_nok ?? 0;
  if (!isFiniteAmount(startBal)) return Response.json({ error: 'starting_balance_nok must be a finite number' }, { status: 400 });

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    db.prepare(`
      INSERT INTO accounting_accounts (id, name, type, starting_balance_nok, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, name, type, startBal, now, now);
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed.*type/i.test(err.message)) {
      return Response.json({ error: 'An account of that type already exists' }, { status: 409 });
    }
    throw err;
  }
  return Response.json({ id }, { status: 201 });
}

export async function PATCH(request: NextRequest) {
  const body = await request.json();
  const { id, name, starting_balance_nok } = body;
  if (!id) return Response.json({ error: 'id required' }, { status: 400 });

  const sets: string[] = [];
  const values: unknown[] = [];
  if (name !== undefined) {
    if (typeof name !== 'string' || !name) return Response.json({ error: 'name must be non-empty string' }, { status: 400 });
    sets.push('name = ?'); values.push(name);
  }
  if (starting_balance_nok !== undefined) {
    if (!isFiniteAmount(starting_balance_nok)) return Response.json({ error: 'starting_balance_nok must be a finite number' }, { status: 400 });
    sets.push('starting_balance_nok = ?'); values.push(starting_balance_nok);
  }
  if (sets.length === 0) return Response.json({ error: 'No fields to update' }, { status: 400 });
  sets.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);

  db.prepare(`UPDATE accounting_accounts SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return Response.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const id = searchParams.get('id');
  if (!id) return Response.json({ error: 'id required' }, { status: 400 });
  try {
    db.prepare('DELETE FROM accounting_accounts WHERE id = ?').run(id);
  } catch (err) {
    if (err instanceof Error && /FOREIGN KEY constraint failed/i.test(err.message)) {
      return Response.json({ error: 'Cannot delete account with active recurring deductions' }, { status: 409 });
    }
    throw err;
  }
  return Response.json({ ok: true });
}
