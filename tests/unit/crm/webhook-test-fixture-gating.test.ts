import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initializeCrmSchema } from '../../../src/bus/crm-schema.js';
import { logWebhook } from '../../../src/bus/crm.js';
import { processWebhookQueue } from '../../../src/bus/crm-webhook-processor.js';

/**
 * An external test-runner repeatedly POSTs fixture webhooks (Test Booking /
 * *@test.com) to the prod webhook endpoint. Before this gate, the queue
 * processor created real CRM contacts/deals AND fired notifySales() into the
 * live sales inbox for every fixture — masking real Cal.com bookings. The
 * gate detects test-fixture jobs by attendee/invitee email domain and marks
 * them `skipped_test` without any CRM write or notification.
 *
 * The gate lives in processWebhookQueue (not the lower-level process*Webhook
 * functions) so direct unit tests of those functions — which legitimately
 * use test.com fixtures — keep exercising the full processing path.
 */
describe('processWebhookQueue test-fixture gating', () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'crm-gate-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.pragma('foreign_keys = ON');
    initializeCrmSchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function calcomPayload(email: string, title = 'Test Booking', company = 'Bergen Shipping AS'): string {
    return JSON.stringify({
      triggerEvent: 'BOOKING_CREATED',
      payload: {
        bookingId: `book_${email}`,
        title,
        attendees: [{ name: 'Ola', email }],
        responses: { company: { value: company } },
      },
    });
  }

  function fathomPayload(email: string): string {
    return JSON.stringify({
      recording_id: `rec_${email}`,
      meeting_title: 'Test Meeting',
      default_summary: 'fixture',
      calendar_invitees: [{ email, name: 'Test' }],
    });
  }

  it('marks test-fixture calcom bookings skipped_test with no CRM write or notify', async () => {
    const id = logWebhook(db, 'calcom', 'BOOKING_CREATED', calcomPayload('repeat@test.com'));

    const result = await processWebhookQueue(db);

    expect(result.skippedTest).toBe(1);
    expect(result.processed).toBe(0);

    const row = db.prepare('SELECT status FROM crm_webhook_log WHERE id = ?').get(id) as { status: string };
    expect(row.status).toBe('skipped_test');

    // No CRM pollution.
    const contacts = db.prepare("SELECT COUNT(*) AS n FROM crm_contacts WHERE email = 'repeat@test.com'").get() as { n: number };
    expect(contacts.n).toBe(0);
    const deals = db.prepare('SELECT COUNT(*) AS n FROM crm_deals').get() as { n: number };
    expect(deals.n).toBe(0);
  });

  it('gates test-fixture fathom meetings too', async () => {
    const id = logWebhook(db, 'fathom', 'meeting_content_ready', fathomPayload('dup@test.com'));

    const result = await processWebhookQueue(db);

    expect(result.skippedTest).toBe(1);
    const row = db.prepare('SELECT status FROM crm_webhook_log WHERE id = ?').get(id) as { status: string };
    expect(row.status).toBe('skipped_test');
    const meetings = db.prepare('SELECT COUNT(*) AS n FROM crm_meetings').get() as { n: number };
    expect(meetings.n).toBe(0);
  });

  it('lets real bookings through (genuine company domain)', async () => {
    // A real lead on a genuine .no company domain — must NOT be gated even
    // though the title matches the fixture wording. The gate keys on email
    // domain, not title, precisely so real leads with ordinary titles flow.
    const id = logWebhook(db, 'calcom', 'BOOKING_CREATED', calcomPayload('kari@bergenshipping.no', 'Discovery Call'));

    const result = await processWebhookQueue(db);

    expect(result.skippedTest).toBe(0);
    expect(result.processed).toBe(1);
    const row = db.prepare('SELECT status FROM crm_webhook_log WHERE id = ?').get(id) as { status: string };
    expect(row.status).toBe('completed');
    const contact = db.prepare("SELECT COUNT(*) AS n FROM crm_contacts WHERE email = 'kari@bergenshipping.no'").get() as { n: number };
    expect(contact.n).toBe(1);
  });

  it('gates the acme.no placeholder-domain fixture variant', async () => {
    // The test-runner started using kari@acme.no with "Discovery Call" titles
    // (flagged by sales). acme.no is a placeholder domain, not a real lead.
    const id = logWebhook(db, 'calcom', 'BOOKING_CREATED', calcomPayload('kari@acme.no', 'Discovery Call'));
    const result = await processWebhookQueue(db);
    expect(result.skippedTest).toBe(1);
    const row = db.prepare('SELECT status FROM crm_webhook_log WHERE id = ?').get(id) as { status: string };
    expect(row.status).toBe('skipped_test');
  });

  it('company-name fallback gates real-looking .no domains paired with "Firma AS"', async () => {
    // Exact slip-through sales caught: kari@bergenshipping.no (real-looking,
    // not on any test-domain list) + company "Firma AS" (placeholder).
    const payload = JSON.stringify({
      triggerEvent: 'BOOKING_CREATED',
      payload: {
        bookingId: 'book_slip',
        title: 'Discovery Call',
        attendees: [{ name: 'Ola', email: 'kari@bergenshipping.no' }],
        responses: { company: { value: 'Firma AS' } },
      },
    });
    const id = logWebhook(db, 'calcom', 'BOOKING_CREATED', payload);
    const result = await processWebhookQueue(db);
    expect(result.skippedTest).toBe(1);
    const row = db.prepare('SELECT status FROM crm_webhook_log WHERE id = ?').get(id) as { status: string };
    expect(row.status).toBe('skipped_test');
    const contact = db.prepare("SELECT COUNT(*) AS n FROM crm_contacts WHERE email = 'kari@bergenshipping.no'").get() as { n: number };
    expect(contact.n).toBe(0);
  });

  it('case-insensitive company match (" firma as " → gated)', async () => {
    const payload = JSON.stringify({
      triggerEvent: 'BOOKING_CREATED',
      payload: {
        bookingId: 'book_ci',
        title: 'Discovery Call',
        attendees: [{ name: 'Ola', email: 'someone@realcorp.no' }],
        responses: { company: { value: '  FIRMA AS  ' } },
      },
    });
    logWebhook(db, 'calcom', 'BOOKING_CREATED', payload);
    const result = await processWebhookQueue(db);
    expect(result.skippedTest).toBe(1);
  });

  it('skipped_test jobs are not re-selected on the next run', async () => {
    logWebhook(db, 'calcom', 'BOOKING_CREATED', calcomPayload('test@test.com'));
    await processWebhookQueue(db);
    const second = await processWebhookQueue(db);
    expect(second.skippedTest).toBe(0);
    expect(second.processed).toBe(0);
  });

  it('honors CRM_TEST_EMAIL_DOMAINS override', async () => {
    const saved = process.env.CRM_TEST_EMAIL_DOMAINS;
    process.env.CRM_TEST_EMAIL_DOMAINS = 'sandbox.io';
    try {
      // test.com is no longer a configured test domain → real booking proceeds.
      logWebhook(db, 'calcom', 'BOOKING_CREATED', calcomPayload('lead@test.com', 'Discovery Call'));
      // sandbox.io now counts as a test domain → gated.
      logWebhook(db, 'calcom', 'BOOKING_CREATED', calcomPayload('qa@sandbox.io'));
      const result = await processWebhookQueue(db);
      expect(result.skippedTest).toBe(1);
      expect(result.processed).toBe(1);
    } finally {
      if (saved === undefined) delete process.env.CRM_TEST_EMAIL_DOMAINS;
      else process.env.CRM_TEST_EMAIL_DOMAINS = saved;
    }
  });
});
