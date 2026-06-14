import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  classifyAction,
  fingerprint,
  evaluateGate,
  type ActionDescriptor,
  type GateInput,
} from '../../../src/security/action-gate';
import { writePendingApproval, findApproval, consumeApproval } from '../../../src/security/approval-store';
import type { ActionGateConfig, ApprovalPolicy } from '../../../src/security/policy';
import { resolvePaths } from '../../../src/utils/paths';
import type { Approval, BusPaths } from '../../../src/types';

const ORG = 'testorg';
const AGENT = 'forge';
const OWNER = '6733625733';

function ctxJson(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

describe('action-gate: classifyAction', () => {
  it('telegram to owner ⇒ ALLOW; non-owner ⇒ catastrophic external-comms; undefined owners ⇒ ALLOW', () => {
    const send = (to: string): ActionDescriptor => ({ kind: 'telegram', to, text: 'hi' });
    expect(classifyAction(send(OWNER), { ownerChatIds: [OWNER] }).category).toBeNull();
    const non = classifyAction(send('999'), { ownerChatIds: [OWNER] });
    expect(non.category).toBe('external-comms');
    expect(non.catastrophic).toBe(true);
    expect(classifyAction(send('999'), { ownerChatIds: undefined }).category).toBeNull();
  });

  it('write/edit to a config path ⇒ config-change (catastrophic); to code ⇒ ALLOW', () => {
    const w = classifyAction({ kind: 'write', path: 'orgs/x/agents/y/config.json' });
    expect(w.category).toBe('config-change');
    expect(w.catastrophic).toBe(true); // fail-CLOSED on gate error (#1↔#8 interlock)
    expect(classifyAction({ kind: 'edit', path: '.env' }).category).toBe('config-change');
    expect(classifyAction({ kind: 'write', path: 'src/foo.ts' }).category).toBeNull();
  });

  it('bus update-approval ⇒ config-change; CRM deletes ⇒ catastrophic data-deletion; safe ⇒ ALLOW', () => {
    expect(classifyAction({ kind: 'bus-command', subcommand: 'update-approval' }).category).toBe('config-change');
    const del = classifyAction({ kind: 'bus-command', subcommand: 'delete-contact' });
    expect(del.category).toBe('data-deletion');
    expect(del.catastrophic).toBe(true);
    const publish = classifyAction({ kind: 'bus-command', subcommand: 'submit-community-item-contribute' });
    expect(publish.category).toBe('deployment');
    expect(publish.catastrophic).toBe(false);
    expect(classifyAction({ kind: 'bus-command', subcommand: 'list-tasks' }).category).toBeNull();
  });
});

describe('action-gate: fingerprint', () => {
  it('same action ⇒ same fp; different text/category ⇒ different fp', () => {
    const a: ActionDescriptor = { kind: 'telegram', to: '999', text: 'hello' };
    const b: ActionDescriptor = { kind: 'telegram', to: '999', text: 'hello' };
    const c: ActionDescriptor = { kind: 'telegram', to: '999', text: 'DIFFERENT' };
    expect(fingerprint('external-comms', a)).toBe(fingerprint('external-comms', b));
    expect(fingerprint('external-comms', a)).not.toBe(fingerprint('external-comms', c));
    expect(fingerprint('external-comms', a)).not.toBe(fingerprint('data-deletion', a));
  });

  it('volatile temp-path masking ⇒ same fp for the same logical command', () => {
    const a: ActionDescriptor = { kind: 'bash', command: 'rm -rf /tmp/abc123/x' };
    const b: ActionDescriptor = { kind: 'bash', command: 'rm -rf /tmp/zzz999/x' };
    expect(fingerprint('data-deletion', a)).toBe(fingerprint('data-deletion', b));
  });

  it('media payload is bound: same caption + different file ⇒ different fp (P1-3)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fp-media-'));
    const f1 = join(dir, 'a.pdf'); const f2 = join(dir, 'b.pdf');
    writeFileSync(f1, 'AAAA'); writeFileSync(f2, 'BBBB');
    const d1: ActionDescriptor = { kind: 'telegram', to: '999', text: 'report', mediaType: 'document', filePath: f1 };
    const d2: ActionDescriptor = { kind: 'telegram', to: '999', text: 'report', mediaType: 'document', filePath: f2 };
    expect(fingerprint('external-comms', d1)).not.toBe(fingerprint('external-comms', d2));
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('action-gate: evaluateGate matrix (overrides — pure logic)', () => {
  let testDir: string;
  let paths: BusPaths;
  const cfg = (mode: ActionGateConfig['mode'], enforce: any[] = []): ActionGateConfig =>
    ({ mode, enforce, ownerChatIds: [OWNER] });
  const policy: ApprovalPolicy = { always_ask: ['external-comms', 'data-deletion', 'config-change'], never_ask: [] };

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'gate-matrix-'));
    paths = resolvePaths(AGENT, 'default', ORG, testDir);
  });
  afterEach(() => rmSync(testDir, { recursive: true, force: true }));

  const base = (descriptor: ActionDescriptor, config: ActionGateConfig): GateInput => ({
    paths, frameworkRoot: testDir, org: ORG, agent: AGENT, descriptor,
    configOverride: config, policyOverride: policy,
  });

  const nonOwner: ActionDescriptor = { kind: 'telegram', to: '999', text: 'exfil' };

  it('mode off ⇒ allow, no gating', () => {
    expect(evaluateGate(base(nonOwner, cfg('off'))).allow).toBe(true);
  });

  it('safe action (owner telegram) ⇒ allow', () => {
    const owner: ActionDescriptor = { kind: 'telegram', to: OWNER, text: 'hi' };
    expect(evaluateGate(base(owner, cfg('enforce', ['external-comms']))).allow).toBe(true);
  });

  it('gated + enforce + no approval ⇒ BLOCK + creates ONE pending (idempotent)', () => {
    const d1 = evaluateGate(base(nonOwner, cfg('enforce', ['external-comms'])));
    expect(d1.allow).toBe(false);
    expect(d1.category).toBe('external-comms');
    expect(d1.approvalId).toBeTruthy();
    const d2 = evaluateGate(base(nonOwner, cfg('enforce', ['external-comms'])));
    expect(d2.allow).toBe(false);
    // same fingerprint ⇒ references existing pending, does NOT create a 2nd
    const pendingFiles = readdirSync(join(paths.approvalDir, 'pending')).filter(f => f.endsWith('.json'));
    expect(pendingFiles.length).toBe(1);
    expect(d2.approvalId).toBe(d1.approvalId);
  });

  it('gated + approved+unconsumed ⇒ allow + single-use (2nd attempt blocks again)', () => {
    const fp = fingerprint('external-comms', nonOwner);
    // write an approved, unconsumed row bound to (org, agent, category, fp)
    mkdirSync(join(paths.approvalDir, 'resolved'), { recursive: true });
    const row: Approval = {
      id: 'approval_test_1', title: 't', requesting_agent: AGENT, org: ORG, category: 'external-comms',
      status: 'approved', description: '', created_at: 'x', updated_at: 'x', resolved_at: 'x', resolved_by: 'human',
      action_fingerprint: fp, consumed_at: null,
    };
    writeFileSync(join(paths.approvalDir, 'resolved', 'approval_test_1.json'), JSON.stringify(row));

    const first = evaluateGate(base(nonOwner, cfg('enforce', ['external-comms'])));
    expect(first.allow).toBe(true);
    expect(first.approvalId).toBe('approval_test_1');
    // single-use: a second attempt with the same fp must block again (row consumed)
    const second = evaluateGate(base(nonOwner, cfg('enforce', ['external-comms'])));
    expect(second.allow).toBe(false);
  });

  it('never_ask waives the category ⇒ allow', () => {
    const input = base(nonOwner, cfg('enforce', ['external-comms']));
    input.policyOverride = { always_ask: ['external-comms'], never_ask: ['external-comms'] };
    expect(evaluateGate(input).allow).toBe(true);
  });

  it('category not in always_ask ⇒ allow (soft, log-only)', () => {
    const input = base(nonOwner, cfg('enforce', ['external-comms']));
    input.policyOverride = { always_ask: ['data-deletion'], never_ask: [] };
    const d = evaluateGate(input);
    expect(d.allow).toBe(true);
    expect(d.soft).toBe(true);
  });

  it('shadow mode ⇒ allow (flagged shadow) and writes NO pending row (observe-only)', () => {
    const d = evaluateGate(base(nonOwner, cfg('shadow', ['external-comms'])));
    expect(d.allow).toBe(true);
    expect(d.shadow).toBe(true);
    expect(d.wouldBlockReason).toContain('external-comms');
    // observe-only: must not flood the pending queue
    const pendingExists = (() => { try { return readdirSync(join(paths.approvalDir, 'pending')).length; } catch { return 0; } })();
    expect(pendingExists).toBe(0);
  });

  it('enforce mode but category NOT in enforce list ⇒ shadow (allow)', () => {
    const d = evaluateGate(base(nonOwner, cfg('enforce', ['data-deletion'])));
    expect(d.allow).toBe(true);
    expect(d.shadow).toBe(true);
  });
});

describe('action-gate: atomic single-use consume (race)', () => {
  let testDir: string;
  let paths: BusPaths;
  beforeEach(() => { testDir = mkdtempSync(join(tmpdir(), 'gate-consume-')); paths = resolvePaths(AGENT, 'default', ORG, testDir); });
  afterEach(() => rmSync(testDir, { recursive: true, force: true }));

  it('two concurrent consumes of the same approval ⇒ exactly one wins', () => {
    mkdirSync(join(paths.approvalDir, 'resolved'), { recursive: true });
    const row: Approval = {
      id: 'approval_race', title: 't', requesting_agent: AGENT, org: ORG, category: 'data-deletion',
      status: 'approved', description: '', created_at: 'x', updated_at: 'x', resolved_at: 'x', resolved_by: 'h',
      action_fingerprint: 'fp', consumed_at: null,
    };
    writeFileSync(join(paths.approvalDir, 'resolved', 'approval_race.json'), JSON.stringify(row));
    const a = consumeApproval(paths, 'approval_race');
    const b = consumeApproval(paths, 'approval_race');
    expect([a, b].filter(Boolean).length).toBe(1); // exactly one winner
    // and the consumed row is no longer found as available
    expect(findApproval(paths, ORG, AGENT, 'data-deletion', 'fp').state).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// SECURITY INVARIANTS (codex code-review must confirm these stay green)
// ---------------------------------------------------------------------------

describe('action-gate: #1↔#8 INTERLOCK (corrupt config must not become a fail-open bypass)', () => {
  let testDir: string;
  let paths: BusPaths;

  function writeContext(obj: Record<string, unknown>) {
    const dir = join(testDir, 'orgs', ORG);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'context.json'), ctxJson(obj));
  }
  function corruptAgentConfig() {
    const dir = join(testDir, 'orgs', ORG, 'agents', AGENT);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), '{ this is not valid json ');
  }

  beforeEach(() => { testDir = mkdtempSync(join(tmpdir(), 'gate-interlock-')); paths = resolvePaths(AGENT, 'default', ORG, testDir); });
  afterEach(() => rmSync(testDir, { recursive: true, force: true }));

  it('corrupt policy config + a CATASTROPHIC action ⇒ still BLOCKED (fail-closed, not fail-open)', () => {
    // valid context (owner list resolvable, enforce on) but corrupt AGENT config
    writeContext({ action_gate_mode: 'enforce', action_gate_enforce: ['data-deletion'], owner_telegram_chat_ids: [OWNER] });
    corruptAgentConfig(); // resolveApprovalPolicy will throw ⇒ error path

    const catastrophic: ActionDescriptor = { kind: 'bash', command: 'rm -rf ~/cortextos/prod-data' };
    const d = evaluateGate({ paths, frameworkRoot: testDir, org: ORG, agent: AGENT, descriptor: catastrophic });
    expect(d.allow).toBe(false);     // fail-CLOSED on the catastrophic subset
    expect(d.error).toBe(true);
  });

  it('corrupt policy config + a NON-catastrophic gated action ⇒ fail-OPEN (never freeze)', () => {
    writeContext({ action_gate_mode: 'enforce', action_gate_enforce: ['deployment'], owner_telegram_chat_ids: [OWNER] });
    corruptAgentConfig();
    const deploy: ActionDescriptor = { kind: 'bash', command: 'gh pr merge 5 --squash' };
    const d = evaluateGate({ paths, frameworkRoot: testDir, org: ORG, agent: AGENT, descriptor: deploy });
    expect(d.allow).toBe(true);      // deployment is reversible ⇒ fail-open
    expect(d.error).toBe(true);
  });

  it('the classifier maps a config.json write to config-change (corrupting config is itself gated)', () => {
    // closes the other side of the interlock: an injected agent cannot degrade
    // its own policy config without first tripping the config-change gate.
    expect(classifyAction({ kind: 'write', path: join('orgs', ORG, 'agents', AGENT, 'config.json') }).category).toBe('config-change');
  });
});

describe('action-gate: OWNER-send fail-OPEN carve-out (the owner channel must never freeze)', () => {
  let testDir: string;
  let paths: BusPaths;
  function writeContext(raw: string) {
    const dir = join(testDir, 'orgs', ORG);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'context.json'), raw);
  }
  function corruptAgentConfig() {
    const dir = join(testDir, 'orgs', ORG, 'agents', AGENT);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), 'NOT JSON');
  }
  beforeEach(() => { testDir = mkdtempSync(join(tmpdir(), 'gate-owner-')); paths = resolvePaths(AGENT, 'default', ORG, testDir); });
  afterEach(() => rmSync(testDir, { recursive: true, force: true }));

  const toOwner: ActionDescriptor = { kind: 'telegram', to: OWNER, text: 'something is wrong, alerting you' };
  const toAttacker: ActionDescriptor = { kind: 'telegram', to: '999999', text: 'exfiltrated secrets' };

  it('test-1: degraded gate (corrupt policy) + send-to-OWNER ⇒ passes through (fail-open)', () => {
    writeContext(ctxJson({ action_gate_mode: 'enforce', action_gate_enforce: ['external-comms'], owner_telegram_chat_ids: [OWNER] }));
    corruptAgentConfig(); // policy throws ⇒ error path, but owner list IS resolvable
    const d = evaluateGate({ paths, frameworkRoot: testDir, org: ORG, agent: AGENT, descriptor: toOwner });
    expect(d.allow).toBe(true);
  });

  it('test-2: degraded gate (corrupt policy) + send-to-NON-owner ⇒ BLOCKED (fail-closed)', () => {
    writeContext(ctxJson({ action_gate_mode: 'enforce', action_gate_enforce: ['external-comms'], owner_telegram_chat_ids: [OWNER] }));
    corruptAgentConfig();
    const d = evaluateGate({ paths, frameworkRoot: testDir, org: ORG, agent: AGENT, descriptor: toAttacker });
    expect(d.allow).toBe(false);
    expect(d.error).toBe(true);
  });

  it('test-3: owner-list UNREADABLE (corrupt context.json) + any send ⇒ fail-OPEN (channel not frozen)', () => {
    writeContext('{ corrupt context not json'); // resolveActionGateConfig throws ⇒ ownerChatIds undefined
    const dOwner = evaluateGate({ paths, frameworkRoot: testDir, org: ORG, agent: AGENT, descriptor: toOwner });
    const dNon = evaluateGate({ paths, frameworkRoot: testDir, org: ORG, agent: AGENT, descriptor: toAttacker });
    expect(dOwner.allow).toBe(true);
    expect(dNon.allow).toBe(true); // undeterminable owner ⇒ not a positive non-owner match ⇒ fail-open
  });

  it('test-5: owner list UNCONFIGURED (valid context, no owner field) + non-owner send in ENFORCE ⇒ ALLOW (never freeze on rollout)', () => {
    // the prod-edge: a live org without owner_telegram_chat_ids must NOT freeze
    // every telegram send at enforce flip. Unconfigured ⇒ undefined ⇒ allow.
    writeContext(ctxJson({ action_gate_mode: 'enforce', action_gate_enforce: ['external-comms'] }));
    const d = evaluateGate({ paths, frameworkRoot: testDir, org: ORG, agent: AGENT, descriptor: toAttacker });
    expect(d.allow).toBe(true);
  });
});

describe('action-gate: config-change auto-enforce + catastrophic (interlock via real fs)', () => {
  let testDir: string;
  let paths: BusPaths;
  function writeContext(obj: Record<string, unknown>) {
    const dir = join(testDir, 'orgs', ORG);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'context.json'), ctxJson(obj));
  }
  function corruptAgentConfig() {
    const dir = join(testDir, 'orgs', ORG, 'agents', AGENT);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), 'not json {');
  }
  beforeEach(() => { testDir = mkdtempSync(join(tmpdir(), 'gate-cc-')); paths = resolvePaths(AGENT, 'default', ORG, testDir); });
  afterEach(() => rmSync(testDir, { recursive: true, force: true }));

  const writeConfig: ActionDescriptor = { kind: 'write', path: join('orgs', ORG, 'agents', AGENT, 'config.json') };

  it('#3: config-change is force-enforced when ANY category is enforced (else self-resolve hole)', () => {
    // enforce list lists ONLY external-comms; config-change must still block.
    writeContext({ action_gate_mode: 'enforce', action_gate_enforce: ['external-comms'], owner_telegram_chat_ids: [OWNER] });
    const d = evaluateGate({ paths, frameworkRoot: testDir, org: ORG, agent: AGENT, descriptor: writeConfig });
    expect(d.allow).toBe(false);          // blocked despite not being in the explicit enforce list
    expect(d.category).toBe('config-change');
  });

  it('#4: corrupt config + a config-change action ⇒ fail-CLOSED (no manufacture bypass via fail-open)', () => {
    writeContext({ action_gate_mode: 'enforce', action_gate_enforce: ['external-comms'], owner_telegram_chat_ids: [OWNER] });
    corruptAgentConfig(); // resolveApprovalPolicy throws ⇒ error path
    const d = evaluateGate({ paths, frameworkRoot: testDir, org: ORG, agent: AGENT, descriptor: writeConfig });
    expect(d.allow).toBe(false);          // config-change is catastrophic ⇒ fail-closed on error
    expect(d.error).toBe(true);
  });

  function writeAgentConfig(rules: { always_ask: string[]; never_ask: string[] }) {
    const dir = join(testDir, 'orgs', ORG, 'agents', AGENT);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ approval_rules: rules }));
  }

  it('config-change is UN-WAIVABLE: agent never_ask cannot waive it under enforce', () => {
    writeContext({ action_gate_mode: 'enforce', action_gate_enforce: ['external-comms'], owner_telegram_chat_ids: [OWNER] });
    writeAgentConfig({ always_ask: ['external-comms'], never_ask: ['config-change'] }); // attempt to self-waive
    const d = evaluateGate({ paths, frameworkRoot: testDir, org: ORG, agent: AGENT, descriptor: writeConfig });
    expect(d.allow).toBe(false); // never_ask ignored for the anchor
  });

  it('config-change is UN-WAIVABLE: agent always_ask omitting it (old defaults) still blocks under enforce', () => {
    writeContext({ action_gate_mode: 'enforce', action_gate_enforce: ['external-comms'], owner_telegram_chat_ids: [OWNER] });
    writeAgentConfig({ always_ask: ['external-comms', 'data-deletion'], never_ask: [] }); // no config-change
    const d = evaluateGate({ paths, frameworkRoot: testDir, org: ORG, agent: AGENT, descriptor: writeConfig });
    expect(d.allow).toBe(false); // always_ask omission ignored for the anchor
  });
});

describe('action-gate: Write/Edit content-bound fingerprint (P2, for Doc 3)', () => {
  it('same path + different content ⇒ different fp (an approved write cannot be re-spent for a new payload)', () => {
    const p = 'orgs/x/agents/y/config.json';
    const fpA = fingerprint('config-change', { kind: 'write', path: p, content: 'benign' });
    const fpB = fingerprint('config-change', { kind: 'write', path: p, content: 'MALICIOUS' });
    expect(fpA).not.toBe(fpB);
    // and stable for the same content
    expect(fingerprint('config-change', { kind: 'write', path: p, content: 'benign' })).toBe(fpA);
  });
});
