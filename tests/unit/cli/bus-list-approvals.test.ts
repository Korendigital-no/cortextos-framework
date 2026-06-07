/**
 * tests/unit/cli/bus-list-approvals.test.ts
 *
 * REGRESSION SUITE for the 2026-06-07 sweep-blindness incident:
 * every agent's TOOLS.md documented `list-approvals [--status S]` but the
 * CLI never implemented --status. Agents following the doc got commander's
 * "unknown option '--status'" on stderr, exit 1, and EMPTY stdout — which
 * approval sweeps parsed as "zero pending". approval_1780662467_a1n2f sat
 * unseen in pending/ for 47h while the 4h re-ping rule was silently dead.
 *
 * These tests exercise the full CLI-to-disk path (parseAsync → action →
 * listApprovals → approvals/ dirs) with the EXACT invocation agents use.
 *
 * Strategy mirrors bus-crons.test.ts: busCommand is a module-level
 * singleton, so we isolate per test via CTX_* env vars pointing at a
 * tempdir, mock process.exit to throw, and spy on console.log/error.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// IPC mock — list-approvals never touches the daemon, but bus.ts pulls in
// IPC at module level; mock it so no real socket is ever attempted.
vi.mock('../../../src/daemon/ipc-server.js', () => {
  class MockIPCClient {
    send = vi.fn().mockResolvedValue({ success: true, data: 'mocked' });
    isDaemonRunning = vi.fn().mockResolvedValue(true);
  }
  return { IPCClient: MockIPCClient };
});

import { busCommand } from '../../../src/cli/bus';

const TEST_AGENT = 'boris';
const TEST_ORG = 'TestOrg';

let tmpRoot: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

const SAVED_ENV_KEYS = ['CTX_ROOT', 'CTX_AGENT_NAME', 'CTX_ORG', 'CTX_INSTANCE_ID'] as const;
const savedEnv: Record<string, string | undefined> = {};

/** Write an approval JSON directly into pending/ or resolved/. */
function seedApproval(
  bucket: 'pending' | 'resolved',
  id: string,
  status: 'pending' | 'approved' | 'rejected',
  org: string = TEST_ORG,
  createdAt: string = '2026-06-07T10:00:00Z',
): void {
  const dir = join(tmpRoot, 'orgs', org, 'approvals', bucket);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.json`),
    JSON.stringify({
      id,
      title: `title-${id}`,
      requesting_agent: TEST_AGENT,
      org,
      category: 'other',
      status,
      description: '',
      created_at: createdAt,
      updated_at: createdAt,
      resolved_at: bucket === 'resolved' ? createdAt : null,
      resolved_by: null,
    }),
  );
}

/** Parse the JSON the command printed and return the listed ids. */
function printedIds(): string[] {
  const jsonCall = logSpy.mock.calls.map((c) => String(c[0])).find((s) => s.trimStart().startsWith('['));
  expect(jsonCall, 'expected a JSON array on stdout').toBeDefined();
  return (JSON.parse(jsonCall!) as Array<{ id: string }>).map((a) => a.id);
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cortextos-list-approvals-'));
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.CTX_ROOT = tmpRoot;
  process.env.CTX_AGENT_NAME = TEST_AGENT;
  process.env.CTX_ORG = TEST_ORG;
  process.env.CTX_INSTANCE_ID = 'default';

  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
    else delete process.env[k];
  }
  logSpy.mockRestore();
  errSpy.mockRestore();
  exitSpy.mockRestore();
});

describe('bus list-approvals --status (the sweep invocation)', () => {
  it('THE regression: --status pending lists a pending approval instead of erroring', async () => {
    seedApproval('pending', 'approval_1_pend', 'pending');

    // The exact command line mike's and analyst's sweeps ran for 47h.
    await busCommand.parseAsync(['node', 'bus', 'list-approvals', '--status', 'pending']);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(printedIds()).toEqual(['approval_1_pend']);
  });

  it('default (no --status) is pending-only — backwards compatible', async () => {
    seedApproval('pending', 'approval_1_pend', 'pending');
    seedApproval('resolved', 'approval_2_appr', 'approved');

    await busCommand.parseAsync(['node', 'bus', 'list-approvals']);

    expect(printedIds()).toEqual(['approval_1_pend']);
  });

  it('--status approved / rejected / resolved filter the resolved bucket', async () => {
    seedApproval('pending', 'approval_1_pend', 'pending', TEST_ORG, '2026-06-07T10:00:00Z');
    seedApproval('resolved', 'approval_2_appr', 'approved', TEST_ORG, '2026-06-07T11:00:00Z');
    seedApproval('resolved', 'approval_3_rej', 'rejected', TEST_ORG, '2026-06-07T12:00:00Z');

    await busCommand.parseAsync(['node', 'bus', 'list-approvals', '--status', 'approved']);
    expect(printedIds()).toEqual(['approval_2_appr']);
    logSpy.mockClear();

    await busCommand.parseAsync(['node', 'bus', 'list-approvals', '--status', 'rejected']);
    expect(printedIds()).toEqual(['approval_3_rej']);
    logSpy.mockClear();

    await busCommand.parseAsync(['node', 'bus', 'list-approvals', '--status', 'resolved']);
    expect(printedIds()).toEqual(['approval_3_rej', 'approval_2_appr']);
    logSpy.mockClear();

    await busCommand.parseAsync(['node', 'bus', 'list-approvals', '--status', 'all']);
    expect(printedIds()).toEqual(['approval_3_rej', 'approval_2_appr', 'approval_1_pend']);
  });

  it('an INVALID --status value fails LOUDLY: exit 1 + error naming the valid set', async () => {
    // The incident's failure mode was a silent-looking failure. An invalid
    // value must never silently print [] — it exits 1 with a clear message.
    seedApproval('pending', 'approval_1_pend', 'pending');

    await expect(
      busCommand.parseAsync(['node', 'bus', 'list-approvals', '--status', 'bogus']),
    ).rejects.toThrow(/process\.exit\(1\)/);

    const errText = errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(errText).toContain("invalid --status 'bogus'");
    expect(errText).toContain('pending|approved|rejected|resolved|all');
    // And crucially: no JSON array was printed for the sweep to misread.
    expect(logSpy.mock.calls.map((c) => String(c[0])).some((s) => s.trimStart().startsWith('['))).toBe(false);
  });

  it('--format text prints status per row and a Total line naming the filter', async () => {
    seedApproval('pending', 'approval_1_pend', 'pending');

    await busCommand.parseAsync(['node', 'bus', 'list-approvals', '--status', 'pending', '--format', 'text']);

    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('[approval_1_pend]');
    expect(out).toContain('Status: pending');
    expect(out).toContain('Total: 1 (pending)');
  });

  it('--all-orgs aggregates the status filter across org directories, globally newest-first', async () => {
    // OrgTwo's approval is NEWER than OrgOne's; org directory iteration
    // order must not leak into the output (cross-review finding: per-org
    // lists were each sorted but the concat was not re-sorted).
    seedApproval('pending', 'approval_org1', 'pending', 'OrgOne', '2026-06-07T10:00:00Z');
    seedApproval('pending', 'approval_org2', 'pending', 'OrgTwo', '2026-06-07T11:00:00Z');
    seedApproval('resolved', 'approval_org1_res', 'approved', 'OrgOne');

    await busCommand.parseAsync(['node', 'bus', 'list-approvals', '--all-orgs', '--status', 'pending']);

    expect(printedIds()).toEqual(['approval_org2', 'approval_org1']);
  });
});
