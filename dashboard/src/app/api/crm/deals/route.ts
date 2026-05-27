import { NextRequest } from 'next/server';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

const VALID_STAGES = ['lead', 'qualified', 'proposal', 'negotiation', 'closed_won', 'closed_lost'];

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const stage = searchParams.get('stage') || undefined;
  const contact = searchParams.get('contact') || undefined;
  const company = searchParams.get('company') || undefined;

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (stage) {
    conditions.push('d.stage = ?');
    params.push(stage);
  }
  if (contact) {
    conditions.push('d.contact_id = ?');
    params.push(contact);
  }
  if (company) {
    conditions.push('d.company_id = ?');
    params.push(company);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const deals = db.prepare(`
    SELECT d.*, c.name as contact_name, co.name as company_name
    FROM crm_deals d
    LEFT JOIN crm_contacts c ON d.contact_id = c.id
    LEFT JOIN crm_companies co ON d.company_id = co.id
    ${where}
    ORDER BY d.created_at DESC
  `).all(...params);

  return Response.json(deals);
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { title, value_nok, stage, contact_id, company_id, expected_close, notes } = body;

  if (!title) {
    return Response.json({ error: 'Title is required' }, { status: 400 });
  }

  const dealStage = stage || 'lead';
  if (!VALID_STAGES.includes(dealStage)) {
    return Response.json({ error: `Invalid stage. Must be one of: ${VALID_STAGES.join(', ')}` }, { status: 400 });
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO crm_deals (id, title, value_nok, stage, contact_id, company_id, expected_close, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, title, value_nok ?? null, dealStage, contact_id || null, company_id || null, expected_close || null, notes || null, now, now);

  const deal = db.prepare('SELECT * FROM crm_deals WHERE id = ?').get(id);
  return Response.json(deal, { status: 201 });
}

export async function PATCH(request: NextRequest) {
  const body = await request.json();
  const { id, stage, value_nok, title, notes } = body;

  if (!id) {
    return Response.json({ error: 'Deal ID is required' }, { status: 400 });
  }
  if (stage && !VALID_STAGES.includes(stage)) {
    return Response.json({ error: `Invalid stage` }, { status: 400 });
  }

  const sets: string[] = [];
  const params: unknown[] = [];

  if (stage) { sets.push('stage = ?'); params.push(stage); }
  if (value_nok !== undefined) { sets.push('value_nok = ?'); params.push(value_nok); }
  if (title) { sets.push('title = ?'); params.push(title); }
  if (notes !== undefined) { sets.push('notes = ?'); params.push(notes); }

  if (stage === 'closed_won' || stage === 'closed_lost') {
    sets.push('closed_at = ?');
    params.push(new Date().toISOString());
  }

  sets.push('updated_at = ?');
  params.push(new Date().toISOString());
  params.push(id);

  db.prepare(`UPDATE crm_deals SET ${sets.join(', ')} WHERE id = ?`).run(...params);

  const deal = db.prepare(`
    SELECT d.*, c.name as contact_name, co.name as company_name
    FROM crm_deals d
    LEFT JOIN crm_contacts c ON d.contact_id = c.id
    LEFT JOIN crm_companies co ON d.company_id = co.id
    WHERE d.id = ?
  `).get(id);

  return Response.json(deal);
}
