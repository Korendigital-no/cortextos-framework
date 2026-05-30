import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { classifyCalcomWebhook } from './classify';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const secret = process.env.CALCOM_WEBHOOK_SECRET;
  if (!secret) {
    return Response.json({ error: 'CALCOM_WEBHOOK_SECRET not configured' }, { status: 503 });
  }
  const testSecret = process.env.CALCOM_TEST_WEBHOOK_SECRET;

  const rawBody = await request.text();
  const signature = request.headers.get('x-cal-signature-256');
  const { valid, isTest } = classifyCalcomWebhook(rawBody, signature, secret, testSecret);
  if (!valid) {
    return Response.json({ error: 'Invalid signature' }, { status: 401 });
  }
  const isTestFlag = isTest ? 1 : 0;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const triggerEvent = payload.triggerEvent as string | undefined;

  if (triggerEvent !== 'BOOKING_CREATED') {
    db.prepare(`
      INSERT INTO crm_webhook_log (source, event_type, payload, status, is_test, processed_at, received_at)
      VALUES ('calcom', ?, ?, 'completed', ?, datetime('now'), datetime('now'))
    `).run(triggerEvent ?? 'unknown', rawBody, isTestFlag);
    return Response.json({ ok: true, skipped: true, event: triggerEvent });
  }

  const inner = payload.payload as Record<string, unknown> | undefined;
  const bookingId = String(inner?.bookingId ?? inner?.uid ?? '');

  if (bookingId) {
    // Scope dedupe by is_test (#5, codex P1): a test fixture replaying bookingId
    // X must never suppress a real prod webhook for the same X (and vice-versa).
    const existing = db.prepare('SELECT id FROM crm_webhook_log WHERE source = ? AND payload LIKE ? AND status != ? AND is_test = ?').get('calcom', `%"bookingId":"${bookingId}"%`, 'failed', isTestFlag);
    if (existing) {
      return Response.json({ ok: true, deduplicated: true }, { status: 200 });
    }
  }

  db.prepare(`
    INSERT INTO crm_webhook_log (source, event_type, payload, status, is_test, received_at)
    VALUES ('calcom', 'BOOKING_CREATED', ?, 'pending', ?, datetime('now'))
  `).run(rawBody, isTestFlag);

  return Response.json({ ok: true, queued: true, isTest: Boolean(isTest) }, { status: 202 });
}
