/**
 * tests/unit/daemon/dispatch-delivery.test.ts
 *
 * REGRESSION SUITE for the 2026-06-07 dispatch silent-failure family —
 * four mechanisms that all marked/consumed BEFORE verified delivery:
 *
 *  A) Cron catch-up batch concatenation: injectMessage sent Enter via
 *     fire-and-forget setTimeout and resolved immediately; a second
 *     injection's paste landed inside the first one's 300ms Enter window
 *     and the prompts silently mangled (3 crons "fired" 11:14Z, none
 *     delivered). Fix: injections are serialized — paste+Enter complete
 *     before the next paste begins.
 *
 *  B) Fast-checker auto-ACK: pollCycle ack'd inbox messages the moment
 *     bytes hit the PTY, so the documented 5-min un-ACK'd redelivery
 *     could never happen (HIGH-prio message unread 3h). Fix: messages
 *     stay in inflight/ until the AGENT acks; stale recovery redelivers,
 *     bounded by MAX_REDELIVERIES with a loud park.
 *
 *  C) Reminders were boot-prompt-only: a reminder due mid-session never
 *     fired until the next restart (Vidda reminder 47 min overdue). Fix:
 *     runtime sweep injects overdue reminders with ack instruction.
 *
 *  D) Urgent signal consumed before delivery: .urgent-signal was
 *     unlinked BEFORE injecting and the result ignored — a NOT_RUNNING
 *     window lost the signal forever (the lost activation-go). Fix:
 *     inject first, unlink only on delivered (or DEDUPED = already
 *     delivered once).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('child_process', () => ({ execFile: vi.fn() }));

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FastChecker } from '../../../src/daemon/fast-checker';
import { AgentProcess } from '../../../src/daemon/agent-process';
import { MessageDedup, KEYS } from '../../../src/pty/inject';
import { checkInbox } from '../../../src/bus/message';
import type { BusPaths, CtxEnv, AgentConfig, InboxMessage } from '../../../src/types';

const PASTE_START = '\x1b[200~';

function createTestPaths(testDir: string): BusPaths {
  const paths: BusPaths = {
    ctxRoot: testDir,
    inbox: join(testDir, 'inbox'),
    inflight: join(testDir, 'inflight'),
    processed: join(testDir, 'processed'),
    logDir: join(testDir, 'logs'),
    stateDir: join(testDir, 'state'),
    taskDir: join(testDir, 'tasks'),
    approvalDir: join(testDir, 'approvals'),
    analyticsDir: join(testDir, 'analytics'),
    deliverablesDir: join(testDir, 'deliverables'),
  };
  for (const dir of Object.values(paths)) {
    if (dir !== testDir) mkdirSync(dir, { recursive: true });
  }
  return paths;
}

/** Mock AgentProcess surface used by FastChecker delivery paths. */
function createMockAgent(name = 'test-agent') {
  return {
    name,
    isBootstrapped: vi.fn().mockReturnValue(true),
    injectMessage: vi.fn().mockResolvedValue(true),
    injectMessageDetailed: vi.fn().mockResolvedValue({ ok: true }),
    getInjectionsSinceMark: vi.fn().mockReturnValue(0),
    markInjectionsSeen: vi.fn(),
    write: vi.fn(),
  } as any;
}

function writeInboxMessage(paths: BusPaths, id: string, opts: { from?: string; text?: string; redeliveries?: number } = {}): string {
  const filename = `2-${Date.now()}-from-${opts.from ?? 'mike'}-abcde-${id}.json`;
  const msg: InboxMessage & { redeliveries?: number } = {
    id,
    from: opts.from ?? 'mike',
    to: 'test-agent',
    priority: 'normal',
    timestamp: new Date().toISOString(),
    text: opts.text ?? `text for ${id}`,
    reply_to: null,
    ...(opts.redeliveries !== undefined ? { redeliveries: opts.redeliveries } : {}),
  } as any;
  writeFileSync(join(paths.inbox, filename), JSON.stringify(msg));
  return filename;
}

let testDir: string;
let paths: BusPaths;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'cortextos-dispatch-test-'));
  paths = createTestPaths(testDir);
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// A) Injection serialization (AgentProcess.injectMessageDetailed)
// ---------------------------------------------------------------------------

describe('A) AgentProcess injection serialization (cron catch-up batch repro)', () => {
  function createAgentProcess(writes: string[]): AgentProcess {
    const ap = new AgentProcess('alice', {} as CtxEnv, {} as AgentConfig, () => {});
    (ap as any).pty = { write: (d: string) => writes.push(d) };
    (ap as any).status = 'running';
    return ap;
  }

  it('two concurrent injections NEVER interleave: paste1→Enter1→paste2→Enter2', async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const ap = createAgentProcess(writes);

    const p1 = ap.injectMessageDetailed('first prompt');
    const p2 = ap.injectMessageDetailed('second prompt');

    await vi.advanceTimersByTimeAsync(1000); // 2 × 300ms Enter delays + slack
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    const firstPasteIdx = writes.findIndex(w => w.includes('first prompt'));
    const secondPasteIdx = writes.findIndex(w => w.includes('second prompt'));
    const firstEnterIdx = writes.indexOf(KEYS.ENTER);
    expect(firstPasteIdx).toBeGreaterThanOrEqual(0);
    expect(secondPasteIdx).toBeGreaterThanOrEqual(0);
    expect(firstEnterIdx).toBeGreaterThanOrEqual(0);

    // THE regression: before the fix, second paste was written BEFORE the
    // first Enter (inside its 300ms window) and the prompts concatenated.
    expect(secondPasteIdx).toBeGreaterThan(firstEnterIdx);

    // Full shape: exactly two Enters, each after its own paste.
    expect(writes.filter(w => w === KEYS.ENTER)).toHaveLength(2);
    const secondEnterIdx = writes.indexOf(KEYS.ENTER, firstEnterIdx + 1);
    expect(secondEnterIdx).toBeGreaterThan(secondPasteIdx);
  });

  it('resolves mark-after-deliver: promise pending until paste AND Enter are written', async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const ap = createAgentProcess(writes);

    let resolved = false;
    const p = ap.injectMessageDetailed('cron prompt').then(r => { resolved = true; return r; });

    await vi.advanceTimersByTimeAsync(299);
    expect(resolved).toBe(false); // Enter not yet written — caller must not mark fired

    await vi.advanceTimersByTimeAsync(2);
    const r = await p;
    expect(r.ok).toBe(true);
    expect(writes[writes.length - 1]).toBe(KEYS.ENTER);
  });

  it('a failed link does not wedge the queue for the next injection', async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const ap = new AgentProcess('alice', {} as CtxEnv, {} as AgentConfig, () => {});
    let failFirst = true;
    (ap as any).pty = {
      write: (d: string) => {
        if (failFirst && d.startsWith(PASTE_START)) { failFirst = false; throw new Error('pty write exploded'); }
        writes.push(d);
      },
    };
    (ap as any).status = 'running';

    const p1 = ap.injectMessageDetailed('will fail');
    const p2 = ap.injectMessageDetailed('must still deliver');
    // Attach rejection expectation BEFORE advancing timers (unhandled-rejection hygiene)
    const p1Expect = expect(p1).rejects.toThrow('pty write exploded');
    await vi.advanceTimersByTimeAsync(1000);
    await p1Expect;
    const r2 = await p2;
    expect(r2.ok).toBe(true);
    expect(writes.some(w => w.includes('must still deliver'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B) pollCycle: no auto-ACK + failure re-queues Telegram
// ---------------------------------------------------------------------------

describe('B) pollCycle mark-after-deliver (sweep-redelivery contract)', () => {
  it('THE regression: injected inbox message stays in inflight/ — NOT auto-ACK\'d to processed/', async () => {
    vi.useFakeTimers();
    writeInboxMessage(paths, 'msg-stays-inflight');
    const agent = createMockAgent();
    const checker = new FastChecker(agent, paths, '/tmp/framework');

    const cycle = (checker as any).pollCycle();
    await vi.advanceTimersByTimeAsync(6000); // post-inject 5s cooldown
    await cycle;

    expect(agent.injectMessageDetailed).toHaveBeenCalledTimes(1);
    const injectedText = String(agent.injectMessageDetailed.mock.calls[0][0]);
    expect(injectedText).toContain('msg-stays-inflight');

    // Message must remain in inflight/ awaiting the AGENT's ack —
    // the old code moved it to processed/ here, killing redelivery.
    expect(readdirSync(paths.inflight)).toHaveLength(1);
    expect(readdirSync(paths.processed)).toHaveLength(0);
    expect(readdirSync(paths.inbox)).toHaveLength(0);
  });

  it('failed injection re-queues Telegram messages and leaves inbox messages for stale redelivery', async () => {
    writeInboxMessage(paths, 'msg-after-failure');
    const agent = createMockAgent();
    agent.injectMessageDetailed.mockResolvedValue({ ok: false, code: 'NOT_RUNNING', message: 'pty down' });
    const checker = new FastChecker(agent, paths, '/tmp/framework');
    checker.queueTelegramMessage('=== TELEGRAM from Vilhelm ===\nhei\n');

    await (checker as any).pollCycle();

    // Telegram message re-queued (it has no disk backing — dropping it
    // would silently lose an operator message).
    expect((checker as any).telegramMessages).toHaveLength(1);
    // Inbox message sits in inflight/, recoverable by the 5-min stale sweep.
    expect(readdirSync(paths.inflight)).toHaveLength(1);
  });

  it('formatInboxMessage salts each delivery so redelivery is not MessageDedup\'d', async () => {
    vi.useFakeTimers();
    const agent = createMockAgent();
    const checker = new FastChecker(agent, paths, '/tmp/framework');
    const msg: InboxMessage = {
      id: 'salt-test', from: 'mike', to: 'test-agent', priority: 'high',
      timestamp: new Date().toISOString(), text: 'same text', reply_to: null,
    } as any;

    const first = (checker as any).formatInboxMessage(msg);
    await vi.advanceTimersByTimeAsync(1500); // distinct delivery timestamp
    const second = (checker as any).formatInboxMessage(msg);

    expect(first).not.toBe(second);
    const dedup = new MessageDedup();
    expect(dedup.isDuplicate(first)).toBe(false);
    expect(dedup.isDuplicate(second)).toBe(false); // would be true (= silently dropped) without the salt
  });
});

// ---------------------------------------------------------------------------
// B2) recoverStaleInflight: bounded redelivery with loud park
// ---------------------------------------------------------------------------

describe('B2) stale-inflight redelivery counter and MAX_REDELIVERIES park', () => {
  function ageInflightFiles(): void {
    const old = new Date(Date.now() - 10 * 60 * 1000); // 10 min — past the 5-min threshold
    for (const f of readdirSync(paths.inflight)) {
      utimesSync(join(paths.inflight, f), old, old);
    }
  }

  it('recovery increments the redeliveries counter on the message', () => {
    writeInboxMessage(paths, 'counted-msg');
    // First checkInbox: delivers, moves to inflight
    let msgs = checkInbox(paths);
    expect(msgs).toHaveLength(1);
    expect((msgs[0] as any).redeliveries ?? 0).toBe(0);

    ageInflightFiles();
    msgs = checkInbox(paths); // stale recovery → back to inbox → re-read
    expect(msgs).toHaveLength(1);
    expect((msgs[0] as any).redeliveries).toBe(1);
  });

  it('the redelivery clock starts at DELIVERY, not send: a message that waited long in inbox/ is not instantly stale', () => {
    // SELF-DIFF FINDING during the fix: renameSync preserves mtime, so a
    // message that sat in inbox/ >5 min (agent down / boot backlog) used to
    // land in inflight/ already past the stale threshold — it would
    // re-recover on every subsequent cycle and exhaust MAX_REDELIVERIES in
    // minutes while the agent was actively handling it.
    const filename = writeInboxMessage(paths, 'old-inbox-msg');
    const old = new Date(Date.now() - 30 * 60 * 1000); // sat in inbox 30 min
    utimesSync(join(paths.inbox, filename), old, old);

    let msgs = checkInbox(paths); // deliver → inflight, clock restarted
    expect(msgs).toHaveLength(1);

    msgs = checkInbox(paths); // immediately after delivery: NOT stale
    expect(msgs).toHaveLength(0);
    expect(readdirSync(paths.inflight)).toHaveLength(1); // still inflight, not recovered
  });

  it('parks the message LOUDLY in processed/ after MAX_REDELIVERIES, never a silent loop', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    writeInboxMessage(paths, 'exhausted-msg', { redeliveries: 3 }); // already at the cap
    checkInbox(paths); // → inflight
    ageInflightFiles();

    const msgs = checkInbox(paths); // 4th recovery attempt → park
    expect(msgs).toHaveLength(0);
    expect(readdirSync(paths.inflight)).toHaveLength(0);
    const processedFiles = readdirSync(paths.processed);
    expect(processedFiles).toHaveLength(1);
    const parked = JSON.parse(readFileSync(join(paths.processed, processedFiles[0]), 'utf-8'));
    expect(parked.redelivery_exhausted).toBe(true);
    expect(parked.redeliveries).toBe(4);

    const errText = errSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(errText).toContain('REDELIVERY EXHAUSTED');
    expect(errText).toContain('exhausted-msg');
    errSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// C) Overdue reminder runtime dispatch
// ---------------------------------------------------------------------------

describe('C) overdue reminders fire into the RUNNING session (Vidda repro)', () => {
  function writeReminders(reminders: Array<{ id: string; fire_at: string; status: string; prompt: string }>): void {
    writeFileSync(
      join(paths.stateDir, 'pending-reminders.json'),
      JSON.stringify(reminders.map(r => ({ created_at: '2026-06-07T00:00:00Z', ...r }))),
    );
  }

  it('THE regression: an overdue reminder is injected mid-session with an ack instruction', async () => {
    writeReminders([{ id: 'rem-vidda', fire_at: '2026-06-07T08:00:00Z', status: 'pending', prompt: 'Send Vidda-oppfølging' }]);
    const agent = createMockAgent();
    const checker = new FastChecker(agent, paths, '/tmp/framework');

    await (checker as any).checkOverdueReminders();

    expect(agent.injectMessageDetailed).toHaveBeenCalledTimes(1);
    const text = String(agent.injectMessageDetailed.mock.calls[0][0]);
    expect(text).toContain('rem-vidda');
    expect(text).toContain('Send Vidda-oppfølging');
    // Mark-after-handle: the AGENT acks; the dispatcher never auto-acks.
    expect(text).toContain('cortextos bus ack-reminder rem-vidda');
  });

  it('re-injects an un-ACK\'d reminder only after the 10-min backoff', async () => {
    writeReminders([{ id: 'rem-backoff', fire_at: '2026-06-07T08:00:00Z', status: 'pending', prompt: 'p' }]);
    const agent = createMockAgent();
    const checker = new FastChecker(agent, paths, '/tmp/framework');

    await (checker as any).checkOverdueReminders();
    expect(agent.injectMessageDetailed).toHaveBeenCalledTimes(1);

    // Force the sweep gate open but stay inside the per-reminder backoff
    (checker as any).reminderLastSweepMs = 0;
    await (checker as any).checkOverdueReminders();
    expect(agent.injectMessageDetailed).toHaveBeenCalledTimes(1); // no spam

    // Past the backoff → re-inject
    (checker as any).reminderLastSweepMs = 0;
    (checker as any).reminderInjectedAt.set('rem-backoff', Date.now() - 11 * 60 * 1000);
    await (checker as any).checkOverdueReminders();
    expect(agent.injectMessageDetailed).toHaveBeenCalledTimes(2);
  });

  it('an acked reminder stops being injected and its backoff entry is pruned', async () => {
    writeReminders([{ id: 'rem-acked', fire_at: '2026-06-07T08:00:00Z', status: 'pending', prompt: 'p' }]);
    const agent = createMockAgent();
    const checker = new FastChecker(agent, paths, '/tmp/framework');
    await (checker as any).checkOverdueReminders();
    expect(agent.injectMessageDetailed).toHaveBeenCalledTimes(1);

    writeReminders([{ id: 'rem-acked', fire_at: '2026-06-07T08:00:00Z', status: 'acked', prompt: 'p' }]);
    (checker as any).reminderLastSweepMs = 0;
    (checker as any).reminderInjectedAt.set('rem-acked', 0); // backoff long expired
    await (checker as any).checkOverdueReminders();
    expect(agent.injectMessageDetailed).toHaveBeenCalledTimes(1); // no re-inject
    expect((checker as any).reminderInjectedAt.has('rem-acked')).toBe(false); // pruned
  });

  it('failed injection does NOT record the backoff — retried on the next sweep', async () => {
    writeReminders([{ id: 'rem-retry', fire_at: '2026-06-07T08:00:00Z', status: 'pending', prompt: 'p' }]);
    const agent = createMockAgent();
    agent.injectMessageDetailed.mockResolvedValueOnce({ ok: false, code: 'NOT_RUNNING', message: 'down' });
    const checker = new FastChecker(agent, paths, '/tmp/framework');

    await (checker as any).checkOverdueReminders();
    expect((checker as any).reminderInjectedAt.has('rem-retry')).toBe(false);

    (checker as any).reminderLastSweepMs = 0;
    await (checker as any).checkOverdueReminders(); // mock back to ok
    expect(agent.injectMessageDetailed).toHaveBeenCalledTimes(2);
    expect((checker as any).reminderInjectedAt.has('rem-retry')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D) Urgent signal: inject first, consume only on delivery
// ---------------------------------------------------------------------------

describe('D) urgent-signal delivery (lost activation-go repro)', () => {
  const signalContent = JSON.stringify({ from: 'mike', message: 'AKTIVERINGS-GO', timestamp: '2026-06-06T20:43:00Z' });

  function writeSignal(): string {
    const p = join(paths.stateDir, '.urgent-signal');
    writeFileSync(p, signalContent);
    return p;
  }

  it('THE regression: NOT_RUNNING retains the signal file for retry instead of consuming it', async () => {
    const signalPath = writeSignal();
    const agent = createMockAgent();
    agent.injectMessageDetailed.mockResolvedValue({ ok: false, code: 'NOT_RUNNING', message: 'restart window' });
    const checker = new FastChecker(agent, paths, '/tmp/framework');

    await (checker as any).checkUrgentSignal();

    // Old behavior unlinked BEFORE injecting — the go-signal was lost forever.
    expect(existsSync(signalPath)).toBe(true);

    // PTY comes back → next poll delivers and consumes.
    agent.injectMessageDetailed.mockResolvedValue({ ok: true });
    await (checker as any).checkUrgentSignal();
    expect(existsSync(signalPath)).toBe(false);
    expect(agent.injectMessageDetailed).toHaveBeenCalledTimes(2);
    expect(String(agent.injectMessageDetailed.mock.calls[1][0])).toContain('AKTIVERINGS-GO');
  });

  it('successful delivery consumes the signal', async () => {
    const signalPath = writeSignal();
    const agent = createMockAgent();
    const checker = new FastChecker(agent, paths, '/tmp/framework');

    await (checker as any).checkUrgentSignal();

    expect(existsSync(signalPath)).toBe(false);
    expect(agent.injectMessageDetailed).toHaveBeenCalledTimes(1);
  });

  it('DEDUPED consumes the signal (already delivered once) without looping', async () => {
    const signalPath = writeSignal();
    const agent = createMockAgent();
    agent.injectMessageDetailed.mockResolvedValue({ ok: false, code: 'DEDUPED', message: 'dup' });
    const checker = new FastChecker(agent, paths, '/tmp/framework');

    await (checker as any).checkUrgentSignal();

    expect(existsSync(signalPath)).toBe(false);
  });
});
