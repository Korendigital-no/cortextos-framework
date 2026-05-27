import { NextRequest } from 'next/server';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const search = searchParams.get('search') || undefined;
  const company = searchParams.get('company') || undefined;
  const source = searchParams.get('source') || undefined;

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (search) {
    conditions.push('(c.name LIKE ? OR c.email LIKE ?)');
    const term = `%${search}%`;
    params.push(term, term);
  }
  if (company) {
    conditions.push('c.company_id = ?');
    params.push(company);
  }
  if (source) {
    conditions.push('c.source = ?');
    params.push(source);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const contacts = db.prepare(`
    SELECT c.*, co.name as company_name
    FROM crm_contacts c
    LEFT JOIN crm_companies co ON c.company_id = co.id
    ${where}
    ORDER BY c.created_at DESC
  `).all(...params);

  return Response.json(contacts);
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { name, email, phone, company_id, source, notes } = body;

  if (!name) {
    return Response.json({ error: 'Name is required' }, { status: 400 });
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO crm_contacts (id, name, email, phone, company_id, source, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, email || null, phone || null, company_id || null, source || null, notes || null, now, now);

  const contact = db.prepare('SELECT * FROM crm_contacts WHERE id = ?').get(id);
  return Response.json(contact, { status: 201 });
}
