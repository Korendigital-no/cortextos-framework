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
    SELECT id, invoice_number as invoiceNumber, customer_name, issue_date as issueDate, due_date as dueDate,
      net_nok, vat_nok, (net_nok + vat_nok) as gross_nok, settled, notes
    FROM accounting_invoices
    ORDER BY issue_date DESC
    LIMIT 100
  `).all();
  const invoices = (rows as Array<{ settled: number }>).map(r => ({ ...r, settled: !!r.settled }));
  return Response.json({ invoices, source: 'manual' });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { invoice_number, customer_name, issue_date, due_date, net_nok, vat_nok, settled, notes } = body;

  if (!invoice_number || !customer_name) {
    return Response.json({ error: 'invoice_number and customer_name required' }, { status: 400 });
  }
  if (!isValidDate(issue_date)) {
    return Response.json({ error: 'issue_date must be YYYY-MM-DD' }, { status: 400 });
  }
  if (due_date != null && !isValidDate(due_date)) {
    return Response.json({ error: 'due_date must be YYYY-MM-DD' }, { status: 400 });
  }
  if (!isValidMoney(net_nok)) {
    return Response.json({ error: 'net_nok must be a finite non-negative number' }, { status: 400 });
  }
  if (vat_nok != null && !isValidMoney(vat_nok)) {
    return Response.json({ error: 'vat_nok must be a finite non-negative number' }, { status: 400 });
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    db.prepare(`
      INSERT INTO accounting_invoices (id, invoice_number, customer_name, issue_date, due_date, net_nok, vat_nok, settled, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, String(invoice_number), String(customer_name), issue_date, due_date ?? null, net_nok, vat_nok ?? 0, settled ? 1 : 0, notes ?? null, now, now);
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed.*invoice_number/i.test(err.message)) {
      return Response.json({ error: 'Invoice number already exists' }, { status: 409 });
    }
    throw err;
  }

  return Response.json({ id }, { status: 201 });
}

export async function PATCH(request: NextRequest) {
  const body = await request.json();
  const { id, settled, ...rest } = body;
  if (!id) return Response.json({ error: 'id required' }, { status: 400 });

  const allowed = ['invoice_number', 'customer_name', 'issue_date', 'due_date', 'net_nok', 'vat_nok', 'notes'];
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const key of allowed) {
    if (rest[key] === undefined) continue;
    const val = rest[key];
    if ((key === 'issue_date' || key === 'due_date') && val !== null && !isValidDate(val)) {
      return Response.json({ error: `${key} must be YYYY-MM-DD` }, { status: 400 });
    }
    if ((key === 'net_nok' || key === 'vat_nok') && !isValidMoney(val)) {
      return Response.json({ error: `${key} must be a finite non-negative number` }, { status: 400 });
    }
    sets.push(`${key} = ?`);
    values.push(val);
  }
  if (settled !== undefined) { sets.push('settled = ?'); values.push(settled ? 1 : 0); }
  if (sets.length === 0) return Response.json({ error: 'No fields to update' }, { status: 400 });
  sets.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);

  try {
    db.prepare(`UPDATE accounting_invoices SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed.*invoice_number/i.test(err.message)) {
      return Response.json({ error: 'Invoice number already exists' }, { status: 409 });
    }
    throw err;
  }
  return Response.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const id = searchParams.get('id');
  if (!id) return Response.json({ error: 'id required' }, { status: 400 });
  db.prepare('DELETE FROM accounting_invoices WHERE id = ?').run(id);
  return Response.json({ ok: true });
}
