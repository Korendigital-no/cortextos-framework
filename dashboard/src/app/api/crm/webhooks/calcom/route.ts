import { NextRequest } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

function verifyCalcomSignature(body: string, signature: string | null, secret: string): boolean {
  if (!signature) return false;
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
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

  if (triggerEvent !== 'BOOKING_CREATED') {
    db.prepare(`
      INSERT INTO crm_webhook_log (source, event_type, payload, status, processed_at, received_at)
      VALUES ('calcom', ?, ?, 'completed', datetime('now'), datetime('now'))
    `).run(triggerEvent ?? 'unknown', rawBody);
    return Response.json({ ok: true, skipped: true, event: triggerEvent });
  }

  const inner = payload.payload as Record<string, unknown> | undefined;
  const bookingId = String(inner?.bookingId ?? inner?.uid ?? '');

  if (bookingId) {
    const existing = db.prepare('SELECT id FROM crm_webhook_log WHERE source = ? AND payload LIKE ? AND status != ?').get('calcom', `%"bookingId":"${bookingId}"%`, 'failed');
    if (existing) {
      return Response.json({ ok: true, deduplicated: true }, { status: 200 });
    }
  }

  db.prepare(`
    INSERT INTO crm_webhook_log (source, event_type, payload, status, received_at)
    VALUES ('calcom', 'BOOKING_CREATED', ?, 'pending', datetime('now'))
  `).run(rawBody);

  return Response.json({ ok: true, queued: true }, { status: 202 });
}
