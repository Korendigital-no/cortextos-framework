import { NextRequest } from 'next/server';
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
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

function now(): string {
  return new Date().toISOString();
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

  const webhookId = db.prepare(`
    INSERT INTO crm_webhook_log (source, event_type, payload, received_at)
    VALUES ('fathom', 'meeting_content_ready', ?, ?)
  `).run(rawBody, now()).lastInsertRowid;

  try {
    const recordingId = payload.recording_id as string | undefined;
    const meetingTitle = (payload.meeting_title ?? payload.title ?? 'Meeting') as string;
    const summary = payload.default_summary as string | undefined;
    const transcript = payload.transcript ? JSON.stringify(payload.transcript) : null;
    const actionItems = payload.action_items ? JSON.stringify(payload.action_items) : null;
    const attendeesRaw = payload.calendar_invitees as Array<{ email?: string; name?: string }> | undefined;
    const attendees = attendeesRaw ? JSON.stringify(attendeesRaw) : null;
    const recordingUrl = payload.url as string | undefined;
    const shareUrl = payload.share_url as string | undefined;
    const meetingStart = payload.recording_start_time as string | undefined;
    const meetingEnd = payload.recording_end_time as string | undefined;

    const meetingId = randomUUID();
    db.prepare(`
      INSERT INTO crm_meetings (id, fathom_recording_id, title, summary, transcript, action_items, attendees, recording_url, share_url, meeting_start, meeting_end, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(meetingId, recordingId ?? null, meetingTitle, summary ?? null, transcript, actionItems, attendees, recordingUrl ?? null, shareUrl ?? null, meetingStart ?? null, meetingEnd ?? null, now());

    const matchedContacts: string[] = [];
    if (attendeesRaw) {
      for (const invitee of attendeesRaw) {
        if (!invitee.email) continue;
        const contact = db.prepare('SELECT id FROM crm_contacts WHERE email = ?').get(invitee.email) as { id: string } | undefined;
        if (contact) {
          matchedContacts.push(contact.id);
          db.prepare(`
            INSERT INTO crm_activities (id, type, subject, contact_id, meeting_id, agent, created_at)
            VALUES (?, 'meeting', ?, ?, ?, 'fathom-webhook', ?)
          `).run(randomUUID(), meetingTitle, contact.id, meetingId, now());
        }
      }
    }

    const actionItemsList = payload.action_items as Array<{ text?: string; description?: string }> | undefined;
    const createdTasks: string[] = [];
    if (actionItemsList) {
      const primaryContact = matchedContacts[0] ?? null;
      for (const item of actionItemsList) {
        const text = item.text ?? item.description;
        if (!text) continue;
        const taskId = randomUUID();
        const dueDate = new Date(Date.now() + 3 * 86400000).toISOString().split('T')[0];
        db.prepare(`
          INSERT INTO crm_activities (id, type, subject, body, contact_id, meeting_id, agent, due_at, created_at)
          VALUES (?, 'task', ?, ?, ?, ?, 'fathom-webhook', ?, ?)
        `).run(taskId, `Follow up: ${text.slice(0, 100)}`, text, primaryContact, meetingId, dueDate, now());
        createdTasks.push(taskId);
      }
    }

    db.prepare('UPDATE crm_webhook_log SET processed = 1 WHERE id = ?').run(webhookId);

    return Response.json({
      ok: true,
      meeting_id: meetingId,
      matched_contacts: matchedContacts.length,
      tasks_created: createdTasks.length,
    }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.prepare('UPDATE crm_webhook_log SET error = ? WHERE id = ?').run(message, webhookId);
    return Response.json({ error: 'Webhook processing failed', detail: message }, { status: 500 });
  }
}
