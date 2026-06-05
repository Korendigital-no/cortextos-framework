import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initializeCrmSchema } from '../../../src/bus/crm-schema.js';
import { processWebhookQueue } from '../../../src/bus/crm-webhook-processor.js';

/**
 * Atomic claim + retry backoff (codex x2, independently rediscovered in PR #64
 * review — duplicate processing sends DUPLICATE sales notifications).
 *
 * 1) The claim is conditional: only the worker whose UPDATE changes the row
 *    owns the job. A second pass over the same snapshot must skip everything.
 * 2) next_retry_at gates the pending query: a failed job waits out its
 *    exponential backoff instead of retrying on every cron tick.
 */
describe('webhook queue — atomic claim + backoff', () => {
  let db: Database.Database;
  let tmpDir: string;

  const insertJob = (over: Record<string, unknown> = {}) => {
    const row = {
      source: 'calcom',
      event_type: 'UNSUPPORTED_EVENT', // unsupported => completes as no-op txn
      payload: '{}',
      status: 'pending',
      attempt_count: 0,
      is_test: 0,
      received_at: '2026-06-05 00:00:00',
      locked_at: null,
      next_retry_at: null,
      ...over,
    } as Record<string, unknown>;
    db.prepare(`
      INSERT INTO crm_webhook_log (source, event_type, payload, status, attempt_count, is_test, received_at, locked_at, next_retry_at)
      VALUES (@source, @event_type, @payload, @status, @attempt_count, @is_test, @received_at, @locked_at, @next_retry_at)
    `).run(row);
    return db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number };
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'crm-claim-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.pragma('foreign_keys = ON');
    initializeCrmSchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('a job is claimed exactly once — a competing claim on the same row changes nothing', async () => {
    const { id } = insertJob();
    // Simulate the overlapping worker that read the same snapshot: it claims first.
    const competing = db.prepare(`
      UPDATE crm_webhook_log
      SET locked_at = datetime('now'), attempt_count = attempt_count + 1
      WHERE id = ? AND status = 'pending'
        AND (locked_at IS NULL OR locked_at < datetime('now', '-5 minutes'))
    `).run(id);
    expect(competing.changes).toBe(1);

    // Our run now sees a freshly-locked row: the SELECT excludes it entirely,
    // and even if it didn't, the conditional claim would skip it.
    const res = await processWebhookQueue(db);
    expect(res.processed + res.failed + res.skipped + res.skippedTest).toBe(0);
    const row = db.prepare('SELECT attempt_count FROM crm_webhook_log WHERE id = ?').get(id) as { attempt_count: number };
    expect(row.attempt_count).toBe(1); // ONLY the competing claim incremented
  });

  it('a job in backoff (next_retry_at in the future) is not retried', async () => {
    insertJob({ next_retry_at: new Date(Date.now() + 60 * 60_000).toISOString(), attempt_count: 1 });
    const res = await processWebhookQueue(db);
    expect(res.processed + res.failed + res.skipped + res.skippedTest).toBe(0);
  });

  it('a job whose backoff has elapsed IS retried', async () => {
    const { id } = insertJob({ next_retry_at: '2026-06-05 00:01:00', attempt_count: 1 });
    const res = await processWebhookQueue(db);
    expect(res.processed).toBe(1); // unsupported event completes as no-op
    const row = db.prepare('SELECT status FROM crm_webhook_log WHERE id = ?').get(id) as { status: string };
    expect(row.status).toBe('completed');
  });

  it('stale locks (>5 min) are reclaimable — a crashed worker never wedges a job', async () => {
    const { id } = insertJob({ locked_at: '2026-06-05 00:00:00' }); // long stale
    const res = await processWebhookQueue(db);
    expect(res.processed).toBe(1);
    const row = db.prepare('SELECT status FROM crm_webhook_log WHERE id = ?').get(id) as { status: string };
    expect(row.status).toBe('completed');
  });
});
