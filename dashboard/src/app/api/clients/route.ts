import { NextRequest } from 'next/server';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  const clients = db.prepare(`
    SELECT c.*, co.name as company_name,
      (SELECT COALESCE(SUM(hours), 0) FROM crm_time_entries WHERE client_id = c.id) as total_hours,
      (SELECT COUNT(*) FROM crm_time_entries WHERE client_id = c.id) as entry_count,
      (SELECT date FROM crm_time_entries WHERE client_id = c.id ORDER BY date DESC LIMIT 1) as last_activity
    FROM crm_clients c
    LEFT JOIN crm_companies co ON c.company_id = co.id
    WHERE c.deleted_at IS NULL
    ORDER BY c.status = 'active' DESC, c.updated_at DESC
  `).all();
  return Response.json(clients);
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { company_name, contact_name, contact_email, deal_type, rate_nok, rate_description, hours_commitment, notes } = body;

  if (!company_name) {
    return Response.json({ error: 'Company name is required' }, { status: 400 });
  }

  const now = new Date().toISOString();
  let companyId: string | null = null;

  const existing = db.prepare('SELECT id FROM crm_companies WHERE name = ?').get(company_name) as { id: string } | undefined;
  if (existing) {
    companyId = existing.id;
  } else {
    companyId = crypto.randomUUID();
    db.prepare('INSERT INTO crm_companies (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(companyId, company_name, now, now);
  }

  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO crm_clients (id, company_id, contact_name, contact_email, deal_type, rate_nok, rate_description, hours_commitment, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, companyId, contact_name ?? null, contact_email ?? null, deal_type ?? null, rate_nok ?? null, rate_description ?? null, hours_commitment ?? null, notes ?? null, now, now);

  return Response.json({ id }, { status: 201 });
}
