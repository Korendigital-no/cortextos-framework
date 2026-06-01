import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Spy on child_process.execFile BEFORE importing the processor, so the
// processor's `import { execFile } from 'child_process'` binds to the spy.
// notifySales() execFiles the real `cli.js bus send-message sales`; the guard
// under test must prevent that from ever running inside the test suite.
const execFileSpy = vi.fn();
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFile: (...args: unknown[]) => execFileSpy(...args) };
});

const { initializeCrmSchema } = await import('../../../src/bus/crm-schema.js');
const { logWebhook } = await import('../../../src/bus/crm.js');
const { processCalcomWebhook, processFathomWebhook, processWebhookQueue } =
  await import('../../../src/bus/crm-webhook-processor.js');

let db: Database.Database;
let tmpDir: string;

beforeEach(() => {
  execFileSpy.mockClear();
  // Simulate the live environment that caused the leak: CTX_FRAMEWORK_ROOT set.
  // Only the test-run guard (VITEST/NODE_ENV) should stop the notification.
  process.env.CTX_FRAMEWORK_ROOT = '/tmp/fake-framework-root';
  tmpDir = mkdtempSync(join(tmpdir(), 'crm-notify-guard-'));
  db = new Database(join(tmpDir, 'test.db'));
  db.pragma('foreign_keys = ON');
  initializeCrmSchema(db);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.CTX_FRAMEWORK_ROOT;
});

function calcomJob() {
  const payload = {
    triggerEvent: 'BOOKING_CREATED',
    payload: {
      bookingId: 'book_guard',
      title: 'Discovery Call',
      attendees: [{ name: 'Ola', email: 'ola@bergenshipping.no' }],
      responses: { company: { value: 'Bergen Shipping AS' } },
    },
  };
  return { id: 1, source: 'calcom', event_type: 'BOOKING_CREATED', payload: JSON.stringify(payload), status: 'pending', attempt_count: 0 };
}

function fathomJob() {
  const payload = {
    recording_id: 'rec_guard',
    meeting_title: 'Test Meeting',
    default_summary: 'Discussed scope',
    action_items: [],
    calendar_invitees: [{ email: 'unknown@nobody.com', name: 'Unknown' }],
  };
  return { id: 2, source: 'fathom', event_type: 'meeting_content_ready', payload: JSON.stringify(payload), status: 'pending', attempt_count: 0 };
}

describe('notifySales test-run guard (source fix for the recurring fixture leak)', () => {
  it('does NOT spawn a sales notification when processCalcomWebhook runs under the test suite', () => {
    processCalcomWebhook(db, calcomJob());
    expect(execFileSpy).not.toHaveBeenCalled();
  });

  it('does NOT spawn a sales notification when processFathomWebhook runs under the test suite', () => {
    processFathomWebhook(db, fathomJob(), null);
    expect(execFileSpy).not.toHaveBeenCalled();
  });

  it('does NOT spawn a sales notification when a non-gated booking flows through processWebhookQueue', async () => {
    // bergenshipping.no is NOT a gated test domain, so the queue processes it as
    // a real booking — which is exactly the path that pinged the live sales agent.
    logWebhook(db, 'calcom', 'BOOKING_CREATED', calcomJob().payload);
    const res = await processWebhookQueue(db);
    expect(res.processed).toBe(1);
    expect(execFileSpy).not.toHaveBeenCalled();
  });

  it('positive control: with the test-run signals removed, the spy DOES fire (proves the guard is what suppresses it)', () => {
    // Without this, a broken test environment (e.g. mock not binding) could make
    // every assertion above pass vacuously. Drop VITEST + NODE_ENV so isTestRun()
    // is false, leaving CTX_FRAMEWORK_ROOT set — the exact production-like state.
    // execFile is mocked, so the spy captures the call; no real notification fires.
    const savedVitest = process.env.VITEST;
    const savedNodeEnv = process.env.NODE_ENV;
    delete process.env.VITEST;
    delete process.env.NODE_ENV;
    try {
      processCalcomWebhook(db, calcomJob());
      expect(execFileSpy).toHaveBeenCalledTimes(1);
      // And it targets the sales agent via the real CLI — the leak signature.
      const [, args] = execFileSpy.mock.calls[0] as [string, string[]];
      expect(args).toContain('sales');
      expect(args).toContain('send-message');
    } finally {
      if (savedVitest === undefined) delete process.env.VITEST; else process.env.VITEST = savedVitest;
      if (savedNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedNodeEnv;
    }
  });
});
