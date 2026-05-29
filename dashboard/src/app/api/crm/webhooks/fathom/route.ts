import { NextRequest } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

function verifySvixSignature(body: string, headers: Headers, secret: string): boolean {
  const msgId = headers.get('webhook-id');
  const timestamp = headers.get('webhook-timestamp');
  const signatures = headers.get('webhook-signature');

  if (!msgId || !timestamp || !signatures) return false;

  const signedContent = `${msgId}.${timestamp}.${body}`;
  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', secretBytes).update(signedContent).digest('base64');

  return signatures.split(' ').some(sig => {
    const sigValue = sig.split(',')[1];
    if (!sigValue) return false;
    try {
      return timingSafeEqual(Buffer.from(expected), Buffer.from(sigValue));
    } catch {
      return false;
    }
  });
}

export async function POST(request: NextRequest) {
  const secret = process.env.FATHOM_WEBHOOK_SECRET;
  if (!secret) {
    return Response.json({ error: 'FATHOM_WEBHOOK_SECRET not configured' }, { status: 503 });
  }

  const rawBody = await request.text();
  if (!verifySvixSignature(rawBody, request.headers, secret)) {
    return Response.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const recordingId = payload.recording_id as string | undefined;

  if (recordingId) {
    const existing = db.prepare('SELECT id FROM crm_webhook_log WHERE source = ? AND payload LIKE ?').get('fathom', `%"recording_id":"${recordingId}"%`);
    if (existing) {
      return Response.json({ ok: true, deduplicated: true }, { status: 200 });
    }
  }

  db.prepare(`
    INSERT INTO crm_webhook_log (source, event_type, payload, status, received_at)
    VALUES ('fathom', 'meeting_content_ready', ?, 'pending', datetime('now'))
  `).run(rawBody);

  return Response.json({ ok: true, queued: true }, { status: 202 });
}
