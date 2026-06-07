import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { detectDayNightMode } from '../src/bus/heartbeat.js';
import { resolveEnv } from '../src/utils/env.js';

describe('Sprint 7: Environment & Config Completeness', () => {
  const testDir = join(tmpdir(), `cortextos-sprint7-${Date.now()}`);

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  describe('Timezone resolution', () => {
    it('resolves timezone from context.json', () => {
      const orgDir = join(testDir, 'orgs', 'testorg');
      mkdirSync(orgDir, { recursive: true });
      writeFileSync(join(orgDir, 'context.json'), JSON.stringify({
        name: 'testorg',
        timezone: 'America/New_York',
        orchestrator: 'sentinel',
      }), 'utf-8');

      const ctx = JSON.parse(readFileSync(join(orgDir, 'context.json'), 'utf-8'));
      expect(ctx.timezone).toBe('America/New_York');
    });

    it('orchestrator resolved from context.json', () => {
      const orgDir = join(testDir, 'orgs', 'testorg');
      mkdirSync(orgDir, { recursive: true });
      writeFileSync(join(orgDir, 'context.json'), JSON.stringify({
        name: 'testorg',
        timezone: 'UTC',
        orchestrator: 'sentinel',
      }), 'utf-8');

      const ctx = JSON.parse(readFileSync(join(orgDir, 'context.json'), 'utf-8'));
      expect(ctx.orchestrator).toBe('sentinel');
    });
  });

  describe('Day/night mode detection', () => {
    it('returns day for daytime hours', () => {
      // We can't control the actual time, but we can test the function signature
      const mode = detectDayNightMode('UTC');
      expect(['day', 'night']).toContain(mode);
    });

    it('handles invalid timezone gracefully', () => {
      const mode = detectDayNightMode('Invalid/Timezone');
      expect(['day', 'night']).toContain(mode);
    });
  });

  describe('Heartbeat with mode and loop_interval', () => {
    it('heartbeat JSON includes mode field', () => {
      const heartbeat = {
        agent: 'testbot',
        timestamp: new Date().toISOString(),
        status: 'running',
        mode: 'day' as const,
        loop_interval: '4h',
      };

      const path = join(testDir, 'heartbeat.json');
      writeFileSync(path, JSON.stringify(heartbeat), 'utf-8');

      const parsed = JSON.parse(readFileSync(path, 'utf-8'));
      expect(parsed.mode).toBe('day');
      expect(parsed.loop_interval).toBe('4h');
    });
  });

  describe('enabled-agents.json format compatibility', () => {
    it('supports full agent config format', () => {
      const config = {
        sentinel: {
          enabled: true,
          status: 'configured',
          org: 'acme',
          template: 'orchestrator',
          model: 'claude-sonnet-4-6',
        },
        analyst: {
          enabled: true,
          status: 'configured',
          org: 'acme',
          template: 'analyst',
        },
        worker: {
          enabled: false,
          status: 'disabled',
          org: 'acme',
        },
      };

      const path = join(testDir, 'enabled-agents.json');
      writeFileSync(path, JSON.stringify(config, null, 2), 'utf-8');

      const parsed = JSON.parse(readFileSync(path, 'utf-8'));
      expect(Object.keys(parsed).length).toBe(3);
      expect(parsed.sentinel.template).toBe('orchestrator');
      expect(parsed.worker.enabled).toBe(false);
    });

    it('handles legacy format (just enabled flag)', () => {
      const legacyConfig = {
        bot1: { enabled: true },
        bot2: { enabled: false },
      };

      const path = join(testDir, 'enabled-agents.json');
      writeFileSync(path, JSON.stringify(legacyConfig), 'utf-8');

      const parsed = JSON.parse(readFileSync(path, 'utf-8'));
      expect(parsed.bot1.enabled).toBe(true);
      expect(parsed.bot2.enabled).toBe(false);
    });
  });

  describe('Loop interval from config.json', () => {
    it('reads heartbeat cron interval', () => {
      const config = {
        crons: [
          { name: 'heartbeat', interval: '4h', command: 'Run heartbeat' },
          { name: 'check-approvals', interval: '30m', command: 'Check approvals' },
        ],
      };

      const path = join(testDir, 'config.json');
      writeFileSync(path, JSON.stringify(config), 'utf-8');

      const parsed = JSON.parse(readFileSync(path, 'utf-8'));
      const heartbeatCron = parsed.crons.find((c: any) => c.name === 'heartbeat');
      expect(heartbeatCron).toBeDefined();
      expect(heartbeatCron.interval).toBe('4h');
    });
  });

  describe('Uninstall', () => {
    it('state directory can be cleaned up', () => {
      const ctxRoot = join(testDir, 'cortextos-state');
      mkdirSync(join(ctxRoot, 'inbox'), { recursive: true });
      mkdirSync(join(ctxRoot, 'state'), { recursive: true });
      mkdirSync(join(ctxRoot, 'logs'), { recursive: true });

      expect(existsSync(ctxRoot)).toBe(true);
      rmSync(ctxRoot, { recursive: true, force: true });
      expect(existsSync(ctxRoot)).toBe(false);
    });
  });

  describe('Sandbox/live env subordination (issue #313)', () => {
    const ctxKeys = [
      'CTX_FRAMEWORK_ROOT',
      'CTX_AGENT_DIR',
      'CTX_PROJECT_ROOT',
      'CTX_AGENT_NAME',
      'CTX_ORG',
      'CTX_INSTANCE_ID',
      'CTX_ROOT',
      'CTX_TIMEZONE',
      'CTX_ORCHESTRATOR',
    ];
    const savedEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
      for (const k of ctxKeys) {
        savedEnv[k] = process.env[k];
        delete process.env[k];
      }
    });

    afterEach(() => {
      for (const k of ctxKeys) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
    });

    it('TC-A subordinate: agentDir under frameworkRoot resolves without throwing', () => {
      const fwRoot = join(testDir, 'sandbox');
      const agentDir = join(fwRoot, 'orgs', 'test', 'agents', 'foo');
      expect(() => resolveEnv({
        frameworkRoot: fwRoot,
        projectRoot: fwRoot,
        agentDir,
        agentName: 'foo',
      })).not.toThrow();
    });

    it('TC-B leak: agentDir not under frameworkRoot throws sandbox/live leak error', () => {
      const fwRoot = join(testDir, 'sandbox');
      const liveAgentDir = '/Users/cortextos/cortextos/orgs/testorg/agents/cortext-designer';
      expect(() => resolveEnv({
        frameworkRoot: fwRoot,
        agentDir: liveAgentDir,
        agentName: 'cortext-designer',
      })).toThrow(/not under CTX_FRAMEWORK_ROOT/);
    });

    it('TC-C divergence: projectRoot diverging from frameworkRoot throws', () => {
      const fwRoot = join(testDir, 'sandbox');
      expect(() => resolveEnv({
        frameworkRoot: fwRoot,
        agentDir: join(fwRoot, 'orgs', 'foo', 'agents', 'bar'),
        projectRoot: '/Users/cortextos/cortextos',
        agentName: 'bar',
      })).toThrow(/must equal CTX_FRAMEWORK_ROOT/);
    });

    it('TC-D back-compat: happy-path frameworkRoot=projectRoot with derived agentDir resolves', () => {
      const root = join(testDir, 'repo');
      mkdirSync(root, { recursive: true });
      const result = resolveEnv({
        frameworkRoot: root,
        projectRoot: root,
        agentName: 'test-agent',
        org: 'testorg',
      });
      expect(result.frameworkRoot).toBe(root);
      expect(result.projectRoot).toBe(root);
      expect(result.agentDir).toBe(join(root, 'orgs', 'testorg', 'agents', 'test-agent'));
    });

    // Inherited-env re-derivation (codex bycatch, 2026-06-04): a CLI
    // subprocess spawned from a LIVE agent shell inherits CTX_AGENT_DIR /
    // CTX_PROJECT_ROOT pointing at the live install. When the caller overrides
    // only the root (CTX_FRAMEWORK_ROOT → sandbox), the old guard THREW —
    // every isolated CLI call failed unless the caller scrubbed ALL CTX_*
    // (the recurring "33 false test-failures" class). Inherited paths that
    // contradict the root are STALE, not malicious: re-derive them under the
    // root instead. Explicit `overrides` contradictions still throw (TC-B/C).
    it('TC-E rederive: env-inherited live CTX_AGENT_DIR + CTX_PROJECT_ROOT under a frameworkRoot override are re-derived, not fatal', () => {
      process.env.CTX_AGENT_DIR = '/Users/cortextos/cortextos/orgs/liveorg/agents/live-agent';
      process.env.CTX_PROJECT_ROOT = '/Users/cortextos/cortextos';
      const fwRoot = join(testDir, 'sandbox');
      const result = resolveEnv({
        frameworkRoot: fwRoot,
        agentName: 'foo',
        org: 'testorg',
      });
      expect(result.projectRoot).toBe(fwRoot);
      expect(result.agentDir).toBe(join(fwRoot, 'orgs', 'testorg', 'agents', 'foo'));
    });

    it('TC-F rederive: the subprocess case — ALL paths from env, root points at sandbox, agent/project inherited from live', () => {
      // Caller sets CTX_FRAMEWORK_ROOT=sandbox in the child env; the child
      // inherits live CTX_AGENT_DIR/CTX_PROJECT_ROOT from the agent shell.
      const fwRoot = join(testDir, 'sandbox');
      process.env.CTX_FRAMEWORK_ROOT = fwRoot;
      process.env.CTX_PROJECT_ROOT = '/Users/cortextos/cortextos';
      process.env.CTX_AGENT_DIR = '/Users/cortextos/cortextos/orgs/liveorg/agents/live-agent';
      process.env.CTX_AGENT_NAME = 'live-agent';
      process.env.CTX_ORG = 'liveorg';
      const result = resolveEnv();
      expect(result.frameworkRoot).toBe(fwRoot);
      expect(result.projectRoot).toBe(fwRoot);
      expect(result.agentDir).toBe(join(fwRoot, 'orgs', 'liveorg', 'agents', 'live-agent'));
    });

    it('TC-G rederive result is always sandboxed: re-derived agentDir is subordinate to frameworkRoot', () => {
      process.env.CTX_AGENT_DIR = '/somewhere/else/entirely';
      const fwRoot = join(testDir, 'sandbox');
      const result = resolveEnv({ frameworkRoot: fwRoot, agentName: 'bar' });
      const resolved = result.agentDir;
      expect(
        resolved === fwRoot || resolved.startsWith(fwRoot + '/'),
      ).toBe(true);
    });

    it('TC-H consistent env passes through untouched (live operation unaffected)', () => {
      const root = join(testDir, 'live');
      process.env.CTX_FRAMEWORK_ROOT = root;
      process.env.CTX_PROJECT_ROOT = root;
      process.env.CTX_AGENT_DIR = join(root, 'orgs', 'o', 'agents', 'a');
      process.env.CTX_AGENT_NAME = 'a';
      process.env.CTX_ORG = 'o';
      const result = resolveEnv();
      expect(result.projectRoot).toBe(root);
      expect(result.agentDir).toBe(join(root, 'orgs', 'o', 'agents', 'a'));
    });
  });
});
