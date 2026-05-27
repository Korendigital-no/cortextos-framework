import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import {
  createContact, getContact, upsertContactByEmail, updateContact,
  createCompany, createDeal, createActivity, createMeeting, listContacts,
  logWebhook,
} from './crm.js';

function now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const MAX_ATTEMPTS = 3;

interface WebhookJob {
  id: number;
  source: string;
  event_type: string;
  payload: string;
  status: string;
  attempt_count: number;
}

export function processCalcomWebhook(db: Database.Database, job: WebhookJob): { contact_id: string; deal_id: string; new_deal: boolean } {
  const payload = JSON.parse(job.payload);
  const inner = payload.payload as Record<string, unknown>;
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
      const company = createCompany(db, { name: companyName });
      companyId = company.id;
    }
  }

  const contact = upsertContactByEmail(db, {
    name: contactName,
    email: contactEmail,
    company_id: companyId ?? undefined,
    source: 'cal_booking',
    source_ref: bookingId,
  });

  createActivity(db, {
    type: 'booking',
    subject: title,
    body: `Booking created via Cal.com. ID: ${bookingId}`,
    contact_id: contact.id,
    agent: 'calcom-webhook',
  });

  const existingDeal = db.prepare(
    "SELECT id FROM crm_deals WHERE contact_id = ? AND stage NOT IN ('closed_won', 'closed_lost') LIMIT 1"
  ).get(contact.id) as { id: string } | undefined;

  let dealId: string;
  let newDeal = false;
  if (!existingDeal) {
    const deal = createDeal(db, {
      title: `Lead: ${contactName}`,
      contact_id: contact.id,
      company_id: companyId ?? undefined,
    });
    dealId = deal.id;
    newDeal = true;
  } else {
    dealId = existingDeal.id;
  }

  return { contact_id: contact.id, deal_id: dealId, new_deal: newDeal };
}

interface FathomAiOutput {
  meeting_category: string;
  deal_signals: { interest_level: string; budget_mentioned: boolean; timeline: string; needs: string[] };
  action_items: Array<{ text: string; owner: string; due_days: number }>;
  follow_up_email_draft: string;
}

export async function callClaudeForMeetingAnalysis(
  summary: string,
  actionItems: string,
  attendees: string,
): Promise<FathomAiOutput> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: `You are a CRM assistant that analyzes sales meeting data. Extract structured information from meeting summaries and action items. Be precise and concise. If information is not available, use reasonable defaults. For due_days, estimate based on urgency (1-3 for urgent, 5-7 for normal, 14 for low priority). For owner, use "sales" if unclear.`,
    messages: [{
      role: 'user',
      content: `Analyze this meeting data and return a JSON object:

SUMMARY:
${summary}

ACTION ITEMS:
${actionItems}

ATTENDEES:
${attendees}

Return JSON with this exact structure:
{
  "meeting_category": "discovery" | "demo" | "proposal" | "negotiation" | "check-in" | "other",
  "deal_signals": {
    "interest_level": "high" | "medium" | "low" | "unknown",
    "budget_mentioned": true/false,
    "timeline": "description or unknown",
    "needs": ["list of identified needs"]
  },
  "action_items": [
    { "text": "action item description", "owner": "sales" or "customer", "due_days": number }
  ],
  "follow_up_email_draft": "short professional follow-up email text"
}`
    }],
  });

  const text = response.content.find(c => c.type === 'text')?.text ?? '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in Claude response');

  const parsed = JSON.parse(jsonMatch[0]) as FathomAiOutput;

  if (!parsed.action_items) parsed.action_items = [];
  if (!parsed.follow_up_email_draft) parsed.follow_up_email_draft = '';
  if (!parsed.meeting_category) parsed.meeting_category = 'other';
  if (!parsed.deal_signals) parsed.deal_signals = { interest_level: 'unknown', budget_mentioned: false, timeline: 'unknown', needs: [] };

  for (const item of parsed.action_items) {
    if (typeof item.due_days !== 'number' || item.due_days < 1 || item.due_days > 90) {
      item.due_days = 7;
    }
    if (!item.owner || !['sales', 'customer'].includes(item.owner)) {
      item.owner = 'sales';
    }
  }

  return parsed;
}

export function processFathomWebhook(
  db: Database.Database,
  job: WebhookJob,
  aiOutput: FathomAiOutput | null,
): { meeting_id: string; matched_contacts: number; tasks_created: number } {
  const payload = JSON.parse(job.payload);

  const recordingId = payload.recording_id as string | undefined;
  const meetingTitle = (payload.meeting_title ?? payload.title ?? 'Meeting') as string;
  const summary = payload.default_summary as string | undefined;
  const transcript = payload.transcript ? JSON.stringify(payload.transcript) : null;
  const actionItemsRaw = payload.action_items ? JSON.stringify(payload.action_items) : null;
  const attendeesRaw = payload.calendar_invitees as Array<{ email?: string; name?: string }> | undefined;
  const attendeesJson = attendeesRaw ? JSON.stringify(attendeesRaw) : null;
  const recordingUrl = payload.url as string | undefined;
  const shareUrl = payload.share_url as string | undefined;
  const meetingStart = payload.recording_start_time as string | undefined;
  const meetingEnd = payload.recording_end_time as string | undefined;

  const meetingId = randomUUID();
  const insertResult = db.prepare(`
    INSERT INTO crm_meetings (id, fathom_recording_id, title, summary, transcript, action_items, attendees, recording_url, share_url, meeting_start, meeting_end, ai_parsed, email_draft, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(fathom_recording_id) DO UPDATE SET
      summary = excluded.summary,
      transcript = excluded.transcript,
      action_items = excluded.action_items,
      ai_parsed = excluded.ai_parsed,
      email_draft = excluded.email_draft
    RETURNING id
  `).get(
    meetingId, recordingId ?? null, meetingTitle, summary ?? null, transcript,
    actionItemsRaw, attendeesJson, recordingUrl ?? null, shareUrl ?? null,
    meetingStart ?? null, meetingEnd ?? null,
    aiOutput ? JSON.stringify(aiOutput) : null,
    aiOutput?.follow_up_email_draft ?? null,
  ) as { id: string };

  const finalMeetingId = insertResult.id;

  const matchedContacts: string[] = [];
  if (attendeesRaw) {
    for (const invitee of attendeesRaw) {
      if (!invitee.email) continue;
      const contact = db.prepare('SELECT id FROM crm_contacts WHERE email = ?').get(invitee.email) as { id: string } | undefined;
      if (contact) {
        matchedContacts.push(contact.id);
        createActivity(db, {
          type: 'meeting',
          subject: meetingTitle,
          contact_id: contact.id,
          meeting_id: finalMeetingId,
          agent: 'fathom-webhook',
        });
      }
    }
  }

  let tasksCreated = 0;
  const primaryContact = matchedContacts[0] ?? null;

  if (aiOutput?.action_items) {
    for (const item of aiOutput.action_items) {
      if (!item.text || item.owner === 'customer') continue;
      const dueDate = new Date(Date.now() + item.due_days * 86400000).toISOString().split('T')[0];
      createActivity(db, {
        type: 'task',
        subject: `Follow up: ${item.text.slice(0, 100)}`,
        body: item.text,
        contact_id: primaryContact ?? undefined,
        meeting_id: finalMeetingId,
        agent: 'fathom-webhook',
        due_at: dueDate,
      });
      tasksCreated++;
    }
  }

  if (aiOutput?.follow_up_email_draft && primaryContact) {
    createActivity(db, {
      type: 'email_draft',
      subject: `Follow-up: ${meetingTitle}`,
      body: aiOutput.follow_up_email_draft,
      contact_id: primaryContact,
      meeting_id: finalMeetingId,
      agent: 'fathom-webhook',
    });
  }

  if (matchedContacts.length === 0 && attendeesRaw && attendeesRaw.length > 0) {
    const reviewId = randomUUID();
    db.prepare(`
      INSERT INTO crm_review_queue (id, type, entity_id, context, status, created_at)
      VALUES (?, 'contact_match', ?, ?, 'pending', datetime('now'))
    `).run(reviewId, finalMeetingId, JSON.stringify({
      reason: 'No existing contacts matched meeting attendees',
      attendees: attendeesRaw,
      meeting_title: meetingTitle,
    }));
  }

  return { meeting_id: finalMeetingId, matched_contacts: matchedContacts.length, tasks_created: tasksCreated };
}

export async function processWebhookQueue(db: Database.Database): Promise<{ processed: number; failed: number; skipped: number }> {
  const jobs = db.prepare(`
    SELECT * FROM crm_webhook_log
    WHERE status = 'pending'
      AND attempt_count < ?
      AND (locked_at IS NULL OR locked_at < datetime('now', '-5 minutes'))
    ORDER BY received_at ASC
    LIMIT 10
  `).all(MAX_ATTEMPTS) as WebhookJob[];

  let processed = 0;
  let failed = 0;
  let skipped = 0;

  for (const job of jobs) {
    db.prepare('UPDATE crm_webhook_log SET locked_at = datetime(\'now\'), attempt_count = attempt_count + 1 WHERE id = ?').run(job.id);

    try {
      const txn = db.transaction(() => {
        if (job.source === 'calcom' && job.event_type === 'BOOKING_CREATED') {
          processCalcomWebhook(db, job);
        } else if (job.source === 'fathom') {
          const payload = JSON.parse(job.payload);
          const summary = payload.default_summary as string ?? '';
          const actionItems = payload.action_items ? JSON.stringify(payload.action_items) : '[]';
          const attendees = payload.calendar_invitees ? JSON.stringify(payload.calendar_invitees) : '[]';

          let aiOutput: FathomAiOutput | null = null;
          return { summary, actionItems, attendees, needsAi: true };
        }
        return { needsAi: false };
      });

      const result = txn();

      if (result && 'needsAi' in result && result.needsAi) {
        let aiOutput: FathomAiOutput | null = null;
        try {
          aiOutput = await callClaudeForMeetingAnalysis(
            (result as { summary: string }).summary,
            (result as { actionItems: string }).actionItems,
            (result as { attendees: string }).attendees,
          );
        } catch (aiErr) {
          console.error(`[crm-processor] Claude API failed for job ${job.id}:`, aiErr);
        }

        const writeTxn = db.transaction(() => {
          processFathomWebhook(db, job, aiOutput);
        });
        writeTxn();
      }

      db.prepare("UPDATE crm_webhook_log SET status = 'completed', processed_at = datetime('now'), locked_at = NULL WHERE id = ?").run(job.id);
      processed++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const nextRetry = new Date(Date.now() + Math.pow(2, job.attempt_count) * 60000).toISOString();
      const newStatus = (job.attempt_count + 1) >= MAX_ATTEMPTS ? 'failed' : 'pending';

      db.prepare(`
        UPDATE crm_webhook_log
        SET status = ?, last_error = ?, next_retry_at = ?, locked_at = NULL
        WHERE id = ?
      `).run(newStatus, message, nextRetry, job.id);

      if (newStatus === 'failed') failed++;
      else skipped++;
    }
  }

  return { processed, failed, skipped };
}
