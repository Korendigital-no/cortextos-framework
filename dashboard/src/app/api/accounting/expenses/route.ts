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

function isValidMoney(n: unknown): n is number {
  return typeof n === 'number' && isFinite(n) && n >= 0 && n < 1e12;
}

export async function GET() {
  const rows = db.prepare(`
    SELECT e.id, e.supplier_name, e.description, e.date, e.net_nok, e.vat_nok,
      (e.net_nok + e.vat_nok) as gross_nok, e.paid, e.account,
      e.account_id, a.name as account_name, e.recurring_id
    FROM accounting_expenses e
    LEFT JOIN accounting_accounts a ON e.account_id = a.id
    ORDER BY e.date DESC
    LIMIT 100
  `).all();
  const expenses = (rows as Array<{ paid: number }>).map(r => ({ ...r, paid: !!r.paid }));
  return Response.json({ expenses, source: 'manual' });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { supplier_name, description, date, net_nok, vat_nok, paid, account, account_id } = body;

  if (!supplier_name) {
    return Response.json({ error: 'supplier_name required' }, { status: 400 });
  }
  if (!isValidDate(date)) {
    return Response.json({ error: 'date must be YYYY-MM-DD' }, { status: 400 });
  }
  if (!isValidMoney(net_nok)) {
    return Response.json({ error: 'net_nok must be a finite non-negative number' }, { status: 400 });
  }
  if (vat_nok != null && !isValidMoney(vat_nok)) {
    return Response.json({ error: 'vat_nok must be a finite non-negative number' }, { status: 400 });
  }
  if (account_id != null && typeof account_id !== 'string') {
    return Response.json({ error: 'account_id must be a string' }, { status: 400 });
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO accounting_expenses (id, supplier_name, description, date, net_nok, vat_nok, paid, account, account_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, String(supplier_name), description ?? null, date, net_nok, vat_nok ?? 0, paid === false ? 0 : 1, account ?? null, account_id ?? null, now, now);

  return Response.json({ id }, { status: 201 });
}

export async function PATCH(request: NextRequest) {
  const body = await request.json();
  const { id, paid, ...rest } = body;
  if (!id) return Response.json({ error: 'id required' }, { status: 400 });

  const allowed = ['supplier_name', 'description', 'date', 'net_nok', 'vat_nok', 'account', 'account_id'];
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const key of allowed) {
    if (rest[key] === undefined) continue;
    const val = rest[key];
    if (key === 'date' && !isValidDate(val)) {
      return Response.json({ error: 'date must be YYYY-MM-DD' }, { status: 400 });
    }
    if ((key === 'net_nok' || key === 'vat_nok') && !isValidMoney(val)) {
      return Response.json({ error: `${key} must be a finite non-negative number` }, { status: 400 });
    }
    sets.push(`${key} = ?`);
    values.push(val);
  }
  if (paid !== undefined) { sets.push('paid = ?'); values.push(paid ? 1 : 0); }
  if (sets.length === 0) return Response.json({ error: 'No fields to update' }, { status: 400 });
  sets.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);

  db.prepare(`UPDATE accounting_expenses SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return Response.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const id = searchParams.get('id');
  if (!id) return Response.json({ error: 'id required' }, { status: 400 });
  db.prepare('DELETE FROM accounting_expenses WHERE id = ?').run(id);
  return Response.json({ ok: true });
}
