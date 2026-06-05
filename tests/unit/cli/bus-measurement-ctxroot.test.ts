/**
 * P2 regression (codex bycatch, PR #58 review): the måle-garanti measurement
 * commands — `bus log-measurement` and `bus measurement-report` — called
 * resolvePaths WITHOUT env.ctxRoot, unlike every sibling bus command.
 *
 * resolvePaths is a pure function (it deliberately does NOT read
 * process.env.CTX_ROOT — see src/utils/paths.ts), so omitting the 4th arg
 * silently falls back to ~/.cortextos/<instanceId>. On the prod Mac
 * CTX_ROOT == ~/.cortextos/default so the trees coincide and the bug is
 * invisible; under any CTX_ROOT override deploy, measurement events land in
 * the wrong tree and measurement-report misses them — understating
 * time-saved and corrupting the 2 t/uke guarantee data.
 *
 * Test design notes (from codex plan review 2026-06-04):
 * - write + read are ONE test (report depends on the logged event; vitest
 *   tests must not depend on each other's side effects)
 * - the fallback tree is namespaced by a UNIQUE instanceId so the assertion
 *   "nothing leaked to the fallback" can never collide with (or mutate) a
 *   real ~/.cortextos/default on a dev machine
 * - the source invariant asserts "4th argument present", not an exact
 *   `env.ctxRoot` token, so valid future call shapes don't false-fail
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';

import { busCommand } from '../../../src/cli/bus';

// Every env var resolveEnv() reads must be pinned and restored, or the test
// inherits live agent state (CTX_AGENT_DIR etc.) from the parent shell.
const ENV_KEYS = [
  'CTX_ROOT',
  'CTX_AGENT_NAME',
  'CTX_ORG',
  'CTX_INSTANCE_ID',
  'CTX_FRAMEWORK_ROOT',
  'CTX_PROJECT_ROOT',
  'CTX_AGENT_DIR',
] as const;

const TEST_AGENT = 'measure-test-agent';
const TEST_ORG = 'measure-test-org'; // org NAME (becomes orgs/<org>), never a path
const TEST_CLIENT = '999888777';

let tempCtx: string;
let tempCwd: string;
let uniqueInstanceId: string;
let savedEnv: Record<string, string | undefined>;
let originalCwd: string;

beforeEach(() => {
  tempCtx = mkdtempSync(join(tmpdir(), 'measure-ctx-'));
  // cwd must be away from the repo so resolveEnv() can't pick up a
  // .cortextos-env file from the working tree.
  tempCwd = mkdtempSync(join(tmpdir(), 'measure-cwd-'));
  // Unique instanceId: the no-override fallback becomes
  // ~/.cortextos/<uniqueInstanceId> — guaranteed empty, never the real
  // 'default' tree, and safe to inspect without touching live data.
  uniqueInstanceId = `mtest${process.pid}${Math.floor(Math.random() * 1e6)}`;

  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  originalCwd = process.cwd();

  process.env.CTX_ROOT = tempCtx;
  process.env.CTX_AGENT_NAME = TEST_AGENT;
  process.env.CTX_ORG = TEST_ORG;
  process.env.CTX_INSTANCE_ID = uniqueInstanceId;
  delete process.env.CTX_FRAMEWORK_ROOT;
  delete process.env.CTX_PROJECT_ROOT;
  delete process.env.CTX_AGENT_DIR;

  process.chdir(tempCwd);
});

afterEach(() => {
  process.chdir(originalCwd);
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(tempCtx, { recursive: true, force: true });
  rmSync(tempCwd, { recursive: true, force: true });
  // The CTX_ROOT fix means nothing is written here; remove defensively so a
  // regression can never accrete junk under ~/.cortextos/<uniqueInstanceId>.
  rmSync(join(homedir(), '.cortextos', uniqueInstanceId), { recursive: true, force: true });
});

/** Collect all measurement/task_handled rows for TEST_CLIENT under a root. */
function clientEventsUnder(root: string): Array<Record<string, unknown>> {
  const eventsRoot = join(root, 'orgs', TEST_ORG, 'analytics', 'events');
  const rows: Array<Record<string, unknown>> = [];
  if (!existsSync(eventsRoot)) return rows;
  for (const agent of readdirSync(eventsRoot)) {
    const dir = join(eventsRoot, agent);
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.jsonl')) continue;
      for (const line of readFileSync(join(dir, file), 'utf-8').split('\n').filter(Boolean)) {
        const evt = JSON.parse(line);
        if (evt.category === 'measurement' && evt.event === 'task_handled'
            && evt.metadata?.client_id === TEST_CLIENT) rows.push(evt);
      }
    }
  }
  return rows;
}

describe('bus measurement commands honor env.ctxRoot (P2 måle-garanti data integrity)', () => {
  it('log-measurement writes under CTX_ROOT and measurement-report reads it back', async () => {
    await busCommand.parseAsync(
      ['log-measurement',
        '--client', TEST_CLIENT,
        '--task-type', 'booking',
        '--baseline-seconds', '600',
        '--human-touch-seconds', '60'],
      { from: 'user' },
    );

    // Write side: the event lands in the CTX_ROOT tree (file is named by the
    // current UTC date — logEvent always stamps "today", never completed_at).
    const written = clientEventsUnder(tempCtx);
    expect(written).toHaveLength(1);
    expect(written[0].metadata).toMatchObject({
      client_id: TEST_CLIENT,
      agent_id: TEST_AGENT,
      task_type: 'booking',
      baseline_seconds_per_task: 600,
      human_touch_seconds: 60,
      outcome: 'completed',
    });
    const today = new Date().toISOString().split('T')[0];
    expect(existsSync(join(
      tempCtx, 'orgs', TEST_ORG, 'analytics', 'events', TEST_AGENT, `${today}.jsonl`,
    ))).toBe(true);

    // Nothing leaked to the homedir fallback tree the old code wrote to.
    expect(clientEventsUnder(join(homedir(), '.cortextos', uniqueInstanceId))).toHaveLength(0);

    // Read side: the report aggregates from the SAME override tree, so the
    // event written above is found (old code read the fallback → 0 tasks).
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg?: unknown) => { logs.push(String(msg)); };
    try {
      await busCommand.parseAsync(
        ['measurement-report', '--client', TEST_CLIENT, '--json'],
        { from: 'user' },
      );
    } finally {
      console.log = origLog;
    }
    const report = JSON.parse(logs.join('\n'));
    expect(report.client_id).toBe(TEST_CLIENT);
    expect(report.tasks_completed).toBe(1);
    expect(report.gross_baseline_seconds).toBe(600);
    expect(report.human_touch_seconds).toBe(60);
    expect(report.time_saved_seconds).toBe(540);
  });

  it('source invariant: every resolvePaths() call in cli/bus.ts passes a ctxRoot (4th arg)', () => {
    // Closes the class: a future bus command that forgets the 4th arg fails
    // here instead of silently writing to the homedir fallback tree.
    // Resolve from this test file's location, not cwd — the suite chdirs to a
    // temp dir in beforeEach.
    const source = readFileSync(
      new URL('../../../src/cli/bus.ts', import.meta.url), 'utf-8',
    );
    const calls = source.match(/resolvePaths\(([^)]*)\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    const missingFourthArg = calls.filter(call => {
      const args = call.slice('resolvePaths('.length, -1);
      // Count top-level commas — all current call sites pass simple
      // identifier/member-expression args (no nested calls/objects).
      return args.split(',').length < 4;
    });
    expect(missingFourthArg, `resolvePaths calls missing ctxRoot (4th arg): ${missingFourthArg.join(' | ')}`).toHaveLength(0);
  });
});
