import { NextRequest } from 'next/server';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const search = searchParams.get('search') || undefined;

  if (search) {
    const term = `%${search}%`;
    const companies = db.prepare(`
      SELECT c.*,
        (SELECT COUNT(*) FROM crm_contacts WHERE company_id = c.id) as contact_count,
        (SELECT COUNT(*) FROM crm_deals WHERE company_id = c.id AND stage NOT IN ('closed_won','closed_lost')) as active_deals
      FROM crm_companies c
      WHERE c.name LIKE ? OR c.domain LIKE ?
      ORDER BY c.created_at DESC
    `).all(term, term);
    return Response.json(companies);
  }

  const companies = db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM crm_contacts WHERE company_id = c.id) as contact_count,
      (SELECT COUNT(*) FROM crm_deals WHERE company_id = c.id AND stage NOT IN ('closed_won','closed_lost')) as active_deals
    FROM crm_companies c
    ORDER BY c.created_at DESC
  `).all();

  return Response.json(companies);
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { name, domain, industry, org_number, size, notes } = body;

  if (!name) {
    return Response.json({ error: 'Name is required' }, { status: 400 });
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO crm_companies (id, name, domain, industry, org_number, size, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, domain || null, industry || null, org_number || null, size || null, notes || null, now, now);

  const company = db.prepare('SELECT * FROM crm_companies WHERE id = ?').get(id);
  return Response.json(company, { status: 201 });
}
