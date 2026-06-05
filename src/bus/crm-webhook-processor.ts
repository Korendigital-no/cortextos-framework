import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { join } from 'path';
import {
  createContact, getContact, upsertContactByEmail, updateContact,
  createCompany, createDeal, createActivity, createMeeting, listContacts,
  logWebhook,
} from './crm.js';

/**
 * True when running inside the test suite. Vitest sets `VITEST=true` and
 * `NODE_ENV=test` automatically; either signal is sufficient.
 */
function isTestRun(): boolean {
  return Boolean(process.env.VITEST) || process.env.NODE_ENV === 'test';
}

function notifySales(message: string): void {
  // Source-level kill for the recurring "test-fixture leak" to the live sales
  // agent. The CRM processor functions (processCalcomWebhook / processFathomWebhook
  // / processWebhookQueue) are exercised directly by the unit suite with fixture
  // payloads. Without this guard, ANY test run in an environment that happens to
  // have CTX_FRAMEWORK_ROOT set (e.g. an agent or cron running `npm test` on the
  // live host) execFiles the real CLI and pings the live sales inbox with fixture
  // data — leaving NO row in crm_webhook_log because tests use a temp DB. That is
  // why the leak was intermittent (fires only when the suite runs) and untraceable.
  // The #5 signature gate, the isTestFixtureJob content heuristic, and the
  // sales-side filter only mask the symptom; this is the source. Tests must never
  // produce real outbound notifications.
  if (isTestRun()) return;
  const frameworkRoot = process.env.CTX_FRAMEWORK_ROOT;
  if (!frameworkRoot) return;
  const cliPath = join(frameworkRoot, 'dist', 'cli.js');
  const truncated = message.length > 2000 ? message.slice(0, 1997) + '...' : message;
  try {
    execFile(process.execPath, [cliPath, 'bus', 'send-message', 'sales', 'normal', truncated], {
      env: { ...process.env, CTX_AGENT_NAME: 'crm-webhook' },
      timeout: 5000,
    }, () => {});
  } catch { /* notification failure must never block CRM processing */ }
}

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
  // Source-based test isolation (#5): 1 when the ingestion route verified the
  // signature against CALCOM_TEST_WEBHOOK_SECRET. Such jobs are dropped to
  // skipped_test before any CRM write or sales notification — the canonical,
  // content-independent classifier (the heuristic below is the fallback).
  is_test?: number;
}

const DEFAULT_TEST_EMAIL_DOMAINS = [
  'test.com',
  'example.com',
  'example.org',
  'example.net',
  // Classic placeholder/demo company domains the test-runner uses alongside
  // the "Ola / Firma AS" fixture identity. No real Koren lead uses these.
  'acme.com',
  'acme.no',
];

/**
 * Domains that mark a webhook as a test-runner fixture rather than a real
 * lead. Configurable via CRM_TEST_EMAIL_DOMAINS (comma-separated) so an
 * operator can adjust without a code change. Any domain ending in `.test`
 * (RFC 6761 reserved) is always treated as a fixture.
 */
function testEmailDomains(): string[] {
  const env = process.env.CRM_TEST_EMAIL_DOMAINS;
  if (env && env.trim()) {
    return env.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
  }
  return DEFAULT_TEST_EMAIL_DOMAINS;
}

function isTestEmail(email: string | undefined | null): boolean {
  if (!email) return false;
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  const domain = email.slice(at + 1).toLowerCase().trim();
  if (!domain) return false;
  if (domain.endsWith('.test')) return true;
  return testEmailDomains().includes(domain);
}

const DEFAULT_TEST_COMPANY_NAMES = ['firma as', 'eksempel as', 'test as', 'example inc', 'acme', 'acme as', 'acme inc'];

/**
 * Placeholder company names that mark a fixture even when the email domain
 * looks real. The test-runner pairs throwaway .no domains with the literal
 * placeholder company "Firma AS" ("Company Inc") — caught by sales across
 * every burst. Configurable via CRM_TEST_COMPANY_NAMES (comma-separated).
 * Matched case-insensitively on the trimmed name; no real company is named
 * exactly "Firma AS".
 */
function testCompanyNames(): string[] {
  const env = process.env.CRM_TEST_COMPANY_NAMES;
  if (env && env.trim()) {
    return env.split(',').map((n) => n.trim().toLowerCase()).filter(Boolean);
  }
  return DEFAULT_TEST_COMPANY_NAMES;
}

function isTestCompany(name: string | undefined | null): boolean {
  if (!name) return false;
  return testCompanyNames().includes(name.trim().toLowerCase());
}

/**
 * True when a queued webhook is a test-runner fixture (any attendee/invitee
 * email is on a test domain). Such jobs are dropped to `skipped_test` before
 * any CRM write or sales notification, so an external test-runner hammering
 * the prod webhook endpoint can never pollute the pipeline or mask real
 * bookings in the sales inbox. Malformed payloads are treated as NOT test
 * fixtures so they still flow through normal error handling.
 */
export function isTestFixtureJob(job: WebhookJob): boolean {
  try {
    const payload = JSON.parse(job.payload);
    if (job.source === 'calcom') {
      const inner = payload.payload as Record<string, unknown> | undefined;
      const attendees = (inner?.attendees as Array<{ email?: string }> | undefined) ?? [];
      if (attendees.some((a) => isTestEmail(a.email))) return true;
      // Company-name fallback: catches throwaway-but-real-looking domains
      // (e.g. kari@bergenshipping.no) paired with the placeholder "Firma AS".
      const responses = inner?.responses as Record<string, { value?: string }> | undefined;
      const company = responses?.company?.value ?? responses?.['Company']?.value;
      return isTestCompany(company);
    }
    if (job.source === 'fathom') {
      const invitees = (payload.calendar_invitees as Array<{ email?: string }> | undefined) ?? [];
      return invitees.some((i) => isTestEmail(i.email));
    }
  } catch {
    // Unparseable payload → let the normal processing path surface the error.
  }
  return false;
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

  const responseDetails: string[] = [];
  if (responses) {
    for (const [key, val] of Object.entries(responses)) {
      if (key === 'name' || key === 'email' || key === 'location') continue;
      const value = (val as { value?: string })?.value;
      if (value) responseDetails.push(`${key}: ${value}`);
    }
  }

  const phone = (inner.attendees as Array<{ phone?: string }> | undefined)?.[0]?.phone;
  if (phone) {
    updateContact(db, contact.id, { phone });
  }

  const bodyParts = [`Booking created via Cal.com. ID: ${bookingId}`];
  if (responseDetails.length > 0) bodyParts.push(`\nResponses:\n${responseDetails.join('\n')}`);

  createActivity(db, {
    type: 'booking',
    subject: title,
    body: bodyParts.join(''),
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

  const responseSummary = responseDetails.length > 0 ? ` Booking responses: ${responseDetails.join(', ')}.` : '';
  notifySales(
    `New Cal.com booking: "${title}". Contact: ${contactName} (${contactEmail}).` +
    (companyName ? ` Company: ${companyName}.` : '') +
    (newDeal ? ' New lead created.' : ` Existing deal (${dealId}).`) +
    responseSummary +
    ` Use /customer-research or /lead-research-assistant for enrichment.`
  );

  return { contact_id: contact.id, deal_id: dealId, new_deal: newDeal };
}

interface FathomAiOutput {
  meeting_category: string;
  deal_signals: { interest_level: string; budget_mentioned: boolean; timeline: string; needs: string[] };
  action_items: Array<{ text: string; owner: string; due_days: number }>;
  follow_up_email_draft: string;
}

export async function callAiForMeetingAnalysis(
  summary: string,
  actionItems: string,
  attendees: string,
): Promise<FathomAiOutput> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey });

  const response = await client.chat.completions.create({
    model: 'gpt-5.4',
    max_tokens: 2048,
    messages: [
      {
        role: 'system',
        content: 'You are a CRM assistant that analyzes sales meeting data. Extract structured information from meeting summaries and action items. Be precise and concise. If information is not available, use reasonable defaults. For due_days, estimate based on urgency (1-3 for urgent, 5-7 for normal, 14 for low priority). For owner, use "sales" if unclear. Always respond with valid JSON only, no markdown.',
      },
      {
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
}`,
      },
    ],
  });

  const text = response.choices[0]?.message?.content ?? '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in AI response');

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

  const contactNames = matchedContacts.length > 0
    ? (attendeesRaw?.filter(a => a.email).map(a => a.name || a.email).join(', ') ?? 'unknown')
    : 'no matched contacts';
  const aiSummary = aiOutput
    ? ` Category: ${aiOutput.meeting_category}. Interest: ${aiOutput.deal_signals?.interest_level ?? 'unknown'}.`
    : '';

  notifySales(
    `Meeting recorded: "${meetingTitle}". Contacts: ${contactNames}.` +
    ` ${tasksCreated} follow-up tasks created.` +
    aiSummary +
    (aiOutput?.follow_up_email_draft ? ' Email draft ready - run cortextos bus crm-activities list --type email_draft.' : '') +
    (matchedContacts.length === 0 ? ' No contact match - review queue item created.' : '') +
    ` Use /cold-email for outreach or /sales-enablement for prep.`
  );

  return { meeting_id: finalMeetingId, matched_contacts: matchedContacts.length, tasks_created: tasksCreated };
}

export async function processWebhookQueue(db: Database.Database): Promise<{ processed: number; failed: number; skipped: number; skippedTest: number }> {
  // next_retry_at gate: a failed job waits out its exponential backoff instead
  // of being retried on every cron tick until MAX_ATTEMPTS (codex P2).
  const jobs = db.prepare(`
    SELECT * FROM crm_webhook_log
    WHERE status = 'pending'
      AND attempt_count < ?
      AND (locked_at IS NULL OR locked_at < datetime('now', '-5 minutes'))
      AND (next_retry_at IS NULL OR next_retry_at <= datetime('now'))
    ORDER BY received_at ASC
    LIMIT 10
  `).all(MAX_ATTEMPTS) as WebhookJob[];

  // ATOMIC CLAIM (codex P1): two overlapping runs could both read the same
  // pending rows above before either locked them — both would process the job
  // and send DUPLICATE sales notifications. The claim is now conditional: only
  // the worker whose UPDATE actually changes the row owns it; everyone else
  // skips. (claim-then-classify: the test-skip below also runs post-claim.)
  const claim = db.prepare(`
    UPDATE crm_webhook_log
    SET locked_at = datetime('now'), attempt_count = attempt_count + 1
    WHERE id = ?
      AND status = 'pending'
      AND (locked_at IS NULL OR locked_at < datetime('now', '-5 minutes'))
  `);

  let processed = 0;
  let failed = 0;
  let skipped = 0;
  let skippedTest = 0;

  for (const job of jobs) {
    if (claim.run(job.id).changes === 0) continue; // another worker owns it

    // Drop test fixtures before any CRM write or sales notification.
    // status='skipped_test' is terminal (the pending query never re-selects
    // it) and auditable in crm_webhook_log.
    //
    // Two classifiers, source-gate first (#5): job.is_test === 1 means the
    // ingestion route verified the signature against CALCOM_TEST_WEBHOOK_SECRET
    // — a content-independent, structural verdict that holds even when a fixture
    // is indistinguishable from a real booking by payload. isTestFixtureJob is
    // the legacy content heuristic, kept as a fallback for untagged traffic
    // (e.g. no test secret configured yet). Nothing is created for either, so
    // there is zero downstream surface to leak from.
    if (job.is_test === 1 || isTestFixtureJob(job)) {
      db.prepare("UPDATE crm_webhook_log SET status = 'skipped_test', processed_at = datetime('now'), locked_at = NULL WHERE id = ?").run(job.id);
      skippedTest++;
      continue;
    }

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
          aiOutput = await callAiForMeetingAnalysis(
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

  return { processed, failed, skipped, skippedTest };
}
