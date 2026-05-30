import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initializeCrmSchema } from '../../../src/bus/crm-schema.js';
import { processWebhookQueue } from '../../../src/bus/crm-webhook-processor.js';

/**
 * Source-based test isolation (#5, canonical fix — skip-and-audit).
 *
 * The content heuristic (isTestFixtureJob: test.com / "Firma AS") is a
 * best-effort fallback that fails once fixtures look real ("Strategimøte",
 * full names, "... Holding AS"). The canonical fix classifies a webhook as
 * test at INGESTION by which secret signed it: a request signed with
 * CALCOM_TEST_WEBHOOK_SECRET is stamped crm_webhook_log.is_test = 1
 * (see dashboard .../calcom/classify.ts + route.ts). The queue processor then
 * drops is_test=1 jobs to a terminal, auditable status='skipped_test' BEFORE
 * any CRM write or sales notification.
 *
 * Because nothing is created for a test job, there is zero downstream surface
 * to leak from — no test contact/company/deal/activity, no notification, no
 * pollution of any prod report. A real (prod-signed, is_test=0) booking is
 * unaffected and flows through the full pipeline, which is verified here at the
 * queue level (and in webhook-processor.test.ts at the unit level).
 */
describe('source-based test isolation (skip-and-audit)', () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'crm-source-iso-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.pragma('foreign_keys = ON');
    initializeCrmSchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Deliberately REAL-looking identity so the content heuristic does NOT fire —
  // isolation here must come purely from the source gate (is_test column).
  function realLookingPayload(bookingId: string): string {
    return JSON.stringify({
      triggerEvent: 'BOOKING_CREATED',
      payload: {
        bookingId,
        title: 'Strategimøte',
        attendees: [{ name: 'Kari Nordmann', email: 'kari@bergenshipping.no' }],
        responses: { company: { value: 'Bergen Shipping Holding AS' } },
      },
    });
  }

  function enqueue(payload: string, isTest: 0 | 1): number {
    const res = db.prepare(`
      INSERT INTO crm_webhook_log (source, event_type, payload, status, is_test, received_at)
      VALUES ('calcom', 'BOOKING_CREATED', ?, 'pending', ?, datetime('now'))
    `).run(payload, isTest);
    return Number(res.lastInsertRowid);
  }

  function counts() {
    return {
      contacts: (db.prepare('SELECT COUNT(*) n FROM crm_contacts').get() as { n: number }).n,
      deals: (db.prepare('SELECT COUNT(*) n FROM crm_deals').get() as { n: number }).n,
      activities: (db.prepare('SELECT COUNT(*) n FROM crm_activities').get() as { n: number }).n,
    };
  }

  it('crm_webhook_log has an is_test column defaulting to 0', () => {
    const cols = db.prepare('PRAGMA table_info(crm_webhook_log)').all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'is_test')).toBe(true);
    const id = db.prepare(`INSERT INTO crm_webhook_log (source, event_type, payload, status, received_at) VALUES ('calcom','BOOKING_CREATED','{}','pending',datetime('now'))`).run().lastInsertRowid;
    const row = db.prepare('SELECT is_test FROM crm_webhook_log WHERE id = ?').get(id) as { is_test: number };
    expect(row.is_test).toBe(0);
  });

  it('drops a source-gated test job to skipped_test with ZERO CRM rows created', async () => {
    const id = enqueue(realLookingPayload('book_test_1'), 1);
    const res = await processWebhookQueue(db);

    expect(res.skippedTest).toBe(1);
    expect(res.processed).toBe(0);
    // Nothing created — no contact, deal, activity → nothing to leak anywhere.
    expect(counts()).toEqual({ contacts: 0, deals: 0, activities: 0 });
    // Terminal + auditable: the row is skipped_test and stays is_test=1.
    const row = db.prepare('SELECT status, is_test FROM crm_webhook_log WHERE id = ?').get(id) as { status: string; is_test: number };
    expect(row.status).toBe('skipped_test');
    expect(row.is_test).toBe(1);
  });

  // db-level pipeline E2E (mike): a prod-signed (is_test=0) booking flows through
  // the full enqueue → processWebhookQueue → CRM-rows path against a test DB,
  // proving the source gate did not weaken real-booking processing.
  it('processes a real (prod-signed, is_test=0) booking end-to-end into contact + deal + activity', async () => {
    enqueue(realLookingPayload('book_real_1'), 0);
    const res = await processWebhookQueue(db);

    expect(res.processed).toBe(1);
    expect(res.skippedTest).toBe(0);
    const c = counts();
    expect(c.contacts).toBe(1);
    expect(c.deals).toBe(1);
    expect(c.activities).toBeGreaterThanOrEqual(1);
    const contact = db.prepare('SELECT email FROM crm_contacts LIMIT 1').get() as { email: string };
    expect(contact.email).toBe('kari@bergenshipping.no');
    const status = db.prepare("SELECT status FROM crm_webhook_log WHERE payload LIKE '%book_real_1%'").get() as { status: string };
    expect(status.status).toBe('completed');
  });

  it('a test fixture and a real booking sharing a bookingId stay independent (no cross-suppression at the queue)', async () => {
    // Both enqueued (route-level dedupe is scoped by is_test); the test one is
    // skipped, the real one is fully processed.
    enqueue(realLookingPayload('shared_id'), 1);
    enqueue(realLookingPayload('shared_id'), 0);
    const res = await processWebhookQueue(db);

    expect(res.skippedTest).toBe(1);
    expect(res.processed).toBe(1);
    // The real booking still produced its CRM rows.
    expect(counts().deals).toBe(1);
  });
});
