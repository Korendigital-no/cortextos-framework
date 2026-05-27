import { NextRequest } from 'next/server';
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { execFile } from 'child_process';
import { join } from 'path';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

function verifyCalcomSignature(body: string, signature: string | null, secret: string): boolean {
  if (!signature) return false;
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

function now(): string {
  return new Date().toISOString();
}

export async function POST(request: NextRequest) {
  const secret = process.env.CALCOM_WEBHOOK_SECRET;
  if (!secret) {
    return Response.json({ error: 'CALCOM_WEBHOOK_SECRET not configured' }, { status: 503 });
  }

  const rawBody = await request.text();
  const signature = request.headers.get('x-cal-signature-256');
  if (!verifyCalcomSignature(rawBody, signature, secret)) {
    return Response.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const triggerEvent = payload.triggerEvent as string | undefined;

  const webhookId = db.prepare(`
    INSERT INTO crm_webhook_log (source, event_type, payload, received_at)
    VALUES ('calcom', ?, ?, ?)
  `).run(triggerEvent ?? 'unknown', rawBody, now()).lastInsertRowid;

  if (triggerEvent !== 'BOOKING_CREATED') {
    db.prepare('UPDATE crm_webhook_log SET processed = 1 WHERE id = ?').run(webhookId);
    return Response.json({ ok: true, skipped: true, event: triggerEvent });
  }

  try {
    const inner = payload.payload as Record<string, unknown> | undefined;
    if (!inner) throw new Error('Missing payload.payload');

    const attendees = inner.attendees as Array<{ name?: string; email?: string }> | undefined;
    const responses = inner.responses as Record<string, { value?: string }> | undefined;
    const bookingId = String(inner.bookingId ?? inner.uid ?? '');
    const title = String(inner.title ?? 'Cal.com Booking');

    const attendee = attendees?.[0];
    if (!attendee?.email) throw new Error('No attendee email in payload');

    const contactName = attendee.name ?? attendee.email.split('@')[0];
    const contactEmail = attendee.email;

    let companyId: string | null = null;
    const companyName = responses?.company?.value ?? responses?.['Company']?.value;
    if (companyName) {
      const existing = db.prepare('SELECT id FROM crm_companies WHERE name = ?').get(companyName) as { id: string } | undefined;
      if (existing) {
        companyId = existing.id;
      } else {
        companyId = randomUUID();
        db.prepare(`
          INSERT INTO crm_companies (id, name, created_at, updated_at)
          VALUES (?, ?, ?, ?)
        `).run(companyId, companyName, now(), now());
      }
    }

    const contactResult = db.prepare(`
      INSERT INTO crm_contacts (id, name, email, company_id, source, source_ref, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'cal_booking', ?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET
        name = excluded.name,
        company_id = COALESCE(excluded.company_id, crm_contacts.company_id),
        source = COALESCE(excluded.source, crm_contacts.source),
        source_ref = COALESCE(excluded.source_ref, crm_contacts.source_ref),
        updated_at = excluded.updated_at
      RETURNING id
    `).get(randomUUID(), contactName, contactEmail, companyId, bookingId, now(), now()) as { id: string };

    const contactId = contactResult.id;

    const activityId = randomUUID();
    db.prepare(`
      INSERT INTO crm_activities (id, type, subject, body, contact_id, agent, created_at)
      VALUES (?, 'booking', ?, ?, ?, 'calcom-webhook', ?)
    `).run(activityId, title, `Booking created via Cal.com. ID: ${bookingId}`, contactId, now());

    const existingDeal = db.prepare(
      "SELECT id FROM crm_deals WHERE contact_id = ? AND stage NOT IN ('closed_won', 'closed_lost') LIMIT 1"
    ).get(contactId) as { id: string } | undefined;

    let dealId: string | null = null;
    if (!existingDeal) {
      dealId = randomUUID();
      db.prepare(`
        INSERT INTO crm_deals (id, title, stage, contact_id, company_id, created_at, updated_at)
        VALUES (?, ?, 'lead', ?, ?, ?, ?)
      `).run(dealId, `Lead: ${contactName}`, contactId, companyId, now(), now());
    } else {
      dealId = existingDeal.id;
    }

    db.prepare('UPDATE crm_webhook_log SET processed = 1 WHERE id = ?').run(webhookId);

    const frameworkRoot = process.env.CTX_FRAMEWORK_ROOT;
    if (frameworkRoot) {
      const cliPath = join(frameworkRoot, 'dist', 'cli.js');
      const msg = `New Cal.com booking from ${contactName} (${contactEmail}).${companyName ? ` Company: ${companyName}.` : ''} ${!existingDeal ? 'New lead created.' : 'Existing deal updated.'}`;
      execFile(process.execPath, [cliPath, 'bus', 'send-message', 'sales', 'normal', msg], {
        env: { ...process.env, CTX_AGENT_NAME: 'crm-webhook' },
        timeout: 5000,
      }, () => {});
    }

    return Response.json({
      ok: true,
      contact_id: contactId,
      deal_id: dealId,
      activity_id: activityId,
      new_deal: !existingDeal,
    }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.prepare('UPDATE crm_webhook_log SET error = ? WHERE id = ?').run(message, webhookId);
    return Response.json({ error: 'Webhook processing failed', detail: message }, { status: 500 });
  }
}
