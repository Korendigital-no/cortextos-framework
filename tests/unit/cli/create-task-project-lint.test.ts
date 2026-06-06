/**
 * Kanban-tagging lint (fleet rule 2026-06-05, mike [S5]): `create-task`
 * without --project must WARN on stderr but still create the task —
 * the rule is enforced by tooling instead of memory, without breaking
 * existing flows (warn, never block).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let savedEnv: Record<string, string | undefined>;
let tmpRoot: string;
let cwdBefore: string;

beforeEach(() => {
  savedEnv = Object.fromEntries(
    Object.keys(process.env)
      .filter(k => k.startsWith('CTX_'))
      .map(k => [k, process.env[k]]),
  );
  for (const k of Object.keys(savedEnv)) delete process.env[k];
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-lint-'));
  process.env.CTX_ROOT = tmpRoot;
  process.env.CTX_AGENT_NAME = 'testagent';
  process.env.CTX_ORG = 'testorg';
  cwdBefore = process.cwd();
  process.chdir(tmpRoot); // no stray .cortextos-env
  vi.resetModules();
});

afterEach(() => {
  process.chdir(cwdBefore);
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('CTX_') && !(k in savedEnv)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function runCreateTask(args: string[]): Promise<{ stderr: string[] }> {
  const stderr: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    stderr.push(a.map(String).join(' '));
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const { busCommand } = await import('../../../src/cli/bus');
  await busCommand.parseAsync(['create-task', ...args], { from: 'user' });
  return { stderr };
}

function createdTaskFiles(): string[] {
  const dir = path.join(tmpRoot, 'orgs', 'testorg', 'tasks');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')) : [];
}

describe('create-task --project lint (fleet rule)', () => {
  it('WARNS on stderr without --project — but still creates the task (warn, never block)', async () => {
    const { stderr } = await runCreateTask(['Untagged task', '--desc', 'd']);
    expect(stderr.some(l => l.includes('WARN') && l.includes('--project'))).toBe(true);
    expect(createdTaskFiles().length, 'task must still be created').toBe(1);
  });

  it('stays silent with --project and creates the task tagged', async () => {
    const { stderr } = await runCreateTask(['Tagged task', '--project', 'framework']);
    expect(stderr.some(l => l.includes('--project'))).toBe(false);
    const files = createdTaskFiles();
    expect(files.length).toBe(1);
    const task = JSON.parse(
      fs.readFileSync(path.join(tmpRoot, 'orgs', 'testorg', 'tasks', files[0]), 'utf8'),
    );
    expect(task.project).toBe('framework');
  });
});
