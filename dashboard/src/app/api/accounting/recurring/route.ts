import { NextRequest } from 'next/server';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

function isFiniteAmount(n: unknown): n is number {
  return typeof n === 'number' && isFinite(n) && n >= 0 && n < 1e12;
}

function isValidDayOfMonth(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 28;
}

export async function GET() {
  const rows = db.prepare(`
    SELECT r.id, r.name, r.account_id, a.name as account_name, r.amount_nok,
      r.day_of_month, r.apply_on_last_day, r.active, r.last_applied_ym,
      r.created_at, r.updated_at
    FROM accounting_recurring r
    LEFT JOIN accounting_accounts a ON r.account_id = a.id
    ORDER BY r.active DESC, r.day_of_month
  `).all() as Array<{ apply_on_last_day: number; active: number }>;

  const recurring = rows.map(r => ({
    ...r,
    apply_on_last_day: !!r.apply_on_last_day,
    active: !!r.active,
  }));
  return Response.json({ recurring });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { name, account_id, amount_nok, day_of_month, apply_on_last_day, active } = body;

  if (!name || typeof name !== 'string') return Response.json({ error: 'name required' }, { status: 400 });
  if (!account_id || typeof account_id !== 'string') return Response.json({ error: 'account_id required' }, { status: 400 });
  if (!isFiniteAmount(amount_nok)) return Response.json({ error: 'amount_nok must be a finite non-negative number' }, { status: 400 });
  const onLast = apply_on_last_day === true;
  if (!onLast && !isValidDayOfMonth(day_of_month)) {
    return Response.json({ error: 'day_of_month must be an integer 1-28 (or set apply_on_last_day=true)' }, { status: 400 });
  }
  // When apply_on_last_day is true, day_of_month is ignored but we still need a valid
  // DB value to satisfy CHECK constraint. Store 1 as a placeholder.
  const dayToStore = onLast ? 1 : day_of_month;

  // Verify the account exists (FK is enforced but better error message here)
  const acct = db.prepare('SELECT id FROM accounting_accounts WHERE id = ?').get(account_id);
  if (!acct) return Response.json({ error: 'account_id does not match any account' }, { status: 400 });

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO accounting_recurring (id, name, account_id, amount_nok, day_of_month, apply_on_last_day, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, account_id, amount_nok, dayToStore, onLast ? 1 : 0, active === false ? 0 : 1, now, now);

  return Response.json({ id }, { status: 201 });
}

export async function PATCH(request: NextRequest) {
  const body = await request.json();
  const { id, name, account_id, amount_nok, day_of_month, apply_on_last_day, active } = body;
  if (!id) return Response.json({ error: 'id required' }, { status: 400 });

  const sets: string[] = [];
  const values: unknown[] = [];

  if (name !== undefined) {
    if (typeof name !== 'string' || !name) return Response.json({ error: 'name must be non-empty string' }, { status: 400 });
    sets.push('name = ?'); values.push(name);
  }
  if (account_id !== undefined) {
    if (typeof account_id !== 'string' || !account_id) return Response.json({ error: 'account_id must be string' }, { status: 400 });
    const acct = db.prepare('SELECT id FROM accounting_accounts WHERE id = ?').get(account_id);
    if (!acct) return Response.json({ error: 'account_id does not match any account' }, { status: 400 });
    sets.push('account_id = ?'); values.push(account_id);
  }
  if (amount_nok !== undefined) {
    if (!isFiniteAmount(amount_nok)) return Response.json({ error: 'amount_nok must be a finite non-negative number' }, { status: 400 });
    sets.push('amount_nok = ?'); values.push(amount_nok);
  }
  if (day_of_month !== undefined) {
    if (!isValidDayOfMonth(day_of_month)) return Response.json({ error: 'day_of_month must be 1-28' }, { status: 400 });
    sets.push('day_of_month = ?'); values.push(day_of_month);
  }
  if (apply_on_last_day !== undefined) {
    sets.push('apply_on_last_day = ?'); values.push(apply_on_last_day ? 1 : 0);
  }
  if (active !== undefined) {
    sets.push('active = ?'); values.push(active ? 1 : 0);
  }
  if (sets.length === 0) return Response.json({ error: 'No fields to update' }, { status: 400 });

  sets.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);

  db.prepare(`UPDATE accounting_recurring SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return Response.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const id = searchParams.get('id');
  if (!id) return Response.json({ error: 'id required' }, { status: 400 });
  // Posted expense rows keep recurring_id NULL via ON DELETE SET NULL — no data loss.
  db.prepare('DELETE FROM accounting_recurring WHERE id = ?').run(id);
  return Response.json({ ok: true });
}
