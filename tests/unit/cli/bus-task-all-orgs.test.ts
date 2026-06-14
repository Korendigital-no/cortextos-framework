/**
 * Regression coverage for task_1781302887081:
 * task commands documented dashboard-parity --all-orgs, but only approvals
 * implemented the flag. Exercise the real commander surface so TOOLS.md and
 * CLI behavior cannot drift again.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { Task } from '../../../src/types/index.js';

vi.mock('../../../src/daemon/ipc-server.js', () => {
  class MockIPCClient {
    send = vi.fn().mockResolvedValue({ success: true, data: 'mocked' });
    isDaemonRunning = vi.fn().mockResolvedValue(true);
  }
  return { IPCClient: MockIPCClient };
});

import { busCommand } from '../../../src/cli/bus';

const TEST_AGENT = 'cx';
const TEST_ORG = 'OrgOne';

let tmpRoot: string;
let logSpy: ReturnType<typeof vi.spyOn>;
const SAVED_ENV_KEYS = ['CTX_ROOT', 'CTX_AGENT_NAME', 'CTX_ORG', 'CTX_INSTANCE_ID'] as const;
const savedEnv: Record<string, string | undefined> = {};

function seedTask(org: string, task: Partial<Task> & Pick<Task, 'id' | 'title' | 'status' | 'created_at' | 'updated_at'>): void {
  const dir = join(tmpRoot, 'orgs', org, 'tasks');
  mkdirSync(dir, { recursive: true });
  const full: Task = {
    description: '',
    type: 'agent',
    needs_approval: false,
    assigned_to: TEST_AGENT,
    created_by: TEST_AGENT,
    org,
    priority: 'normal',
    project: 'framework',
    kpi_key: null,
    completed_at: null,
    due_date: null,
    archived: false,
    ...task,
  };
  writeFileSync(join(dir, `${full.id}.json`), JSON.stringify(full));
}

function printedJson<T>(): T {
  const jsonCall = logSpy.mock.calls.map((c) => String(c[0])).find((s) => /^[\[{]/.test(s.trimStart()));
  expect(jsonCall, 'expected JSON on stdout').toBeDefined();
  return JSON.parse(jsonCall!) as T;
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cortextos-task-all-orgs-'));
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.CTX_ROOT = tmpRoot;
  process.env.CTX_AGENT_NAME = TEST_AGENT;
  process.env.CTX_ORG = TEST_ORG;
  process.env.CTX_INSTANCE_ID = 'default';
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
    else delete process.env[k];
  }
  logSpy.mockRestore();
});

describe('bus task commands --all-orgs', () => {
  it('list-tasks --all-orgs aggregates all org task directories globally newest-first', async () => {
    seedTask('OrgOne', {
      id: 'task_org1',
      title: 'older task',
      status: 'pending',
      created_at: '2026-06-10T10:00:00Z',
      updated_at: '2026-06-10T10:00:00Z',
    });
    seedTask('OrgTwo', {
      id: 'task_org2',
      title: 'newer task',
      status: 'pending',
      created_at: '2026-06-10T11:00:00Z',
      updated_at: '2026-06-10T11:00:00Z',
    });

    await busCommand.parseAsync(['node', 'bus', 'list-tasks', '--all-orgs', '--format', 'json']);

    const tasks = printedJson<Task[]>();
    expect(tasks.map((t) => t.id)).toEqual(['task_org2', 'task_org1']);
    expect(tasks.map((t) => t.org)).toEqual(['OrgTwo', 'OrgOne']);
  });

  it('check-stale-tasks --all-orgs aggregates stale buckets across orgs', async () => {
    seedTask('OrgOne', {
      id: 'task_stale_progress',
      title: 'stale progress',
      status: 'in_progress',
      created_at: '2020-01-01T00:00:00Z',
      updated_at: '2020-01-01T00:00:00Z',
    });
    seedTask('OrgTwo', {
      id: 'task_stale_pending',
      title: 'stale pending',
      status: 'pending',
      created_at: '2020-01-01T00:00:00Z',
      updated_at: '2020-01-01T00:00:00Z',
    });

    await busCommand.parseAsync(['node', 'bus', 'check-stale-tasks', '--all-orgs']);

    const report = printedJson<{
      stale_in_progress: Task[];
      stale_pending: Task[];
      stale_human: Task[];
      overdue: Task[];
    }>();
    expect(report.stale_in_progress.map((t) => `${t.org}:${t.id}`)).toEqual(['OrgOne:task_stale_progress']);
    expect(report.stale_pending.map((t) => `${t.org}:${t.id}`)).toEqual(['OrgTwo:task_stale_pending']);
  });

  it('archive-tasks --all-orgs dry-run sums archive candidates across orgs without moving files', async () => {
    seedTask('OrgOne', {
      id: 'task_done_org1',
      title: 'done one',
      status: 'completed',
      created_at: '2020-01-01T00:00:00Z',
      updated_at: '2020-01-01T00:00:00Z',
      completed_at: '2020-01-02T00:00:00Z',
    });
    seedTask('OrgTwo', {
      id: 'task_done_org2',
      title: 'done two',
      status: 'completed',
      created_at: '2020-01-01T00:00:00Z',
      updated_at: '2020-01-01T00:00:00Z',
      completed_at: '2020-01-02T00:00:00Z',
    });

    await busCommand.parseAsync(['node', 'bus', 'archive-tasks', '--all-orgs', '--dry-run']);

    expect(printedJson()).toEqual({ archived: 2, skipped: 0, dry_run: true });
    expect(existsSync(join(tmpRoot, 'orgs', 'OrgOne', 'tasks', 'task_done_org1.json'))).toBe(true);
    expect(existsSync(join(tmpRoot, 'orgs', 'OrgTwo', 'tasks', 'task_done_org2.json'))).toBe(true);
  });
});
