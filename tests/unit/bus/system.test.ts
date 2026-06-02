import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { selfRestart, hardRestart, autoCommit, checkGoalStaleness, postActivity, containsCredential } from '../../../src/bus/system';
import type { BusPaths } from '../../../src/types';

function makePaths(testDir: string, agent: string = 'test-agent'): BusPaths {
  return {
    ctxRoot: testDir,
    inbox: join(testDir, 'inbox', agent),
    inflight: join(testDir, 'inflight', agent),
    processed: join(testDir, 'processed', agent),
    logDir: join(testDir, 'logs', agent),
    stateDir: join(testDir, 'state', agent),
    taskDir: join(testDir, 'tasks'),
    approvalDir: join(testDir, 'approvals'),
    analyticsDir: join(testDir, 'analytics'),
    heartbeatDir: join(testDir, 'heartbeats'),
  };
}

describe('Bus System', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-system-test-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('selfRestart', () => {
    it('creates marker file and appends to restarts.log', () => {
      const paths = makePaths(testDir);
      selfRestart(paths, 'test-agent', 'config reload needed');

      // Check marker file
      const markerPath = join(paths.stateDir, '.restart-planned');
      expect(existsSync(markerPath)).toBe(true);
      const markerContent = readFileSync(markerPath, 'utf-8').trim();
      expect(markerContent).toBe('config reload needed');

      // Check restarts.log
      const logPath = join(paths.logDir, 'restarts.log');
      expect(existsSync(logPath)).toBe(true);
      const logContent = readFileSync(logPath, 'utf-8');
      expect(logContent).toContain('SELF-RESTART: config reload needed');
      expect(logContent).toMatch(/\[\d{4}-\d{2}-\d{2}T/);
    });

    it('uses default reason when none provided', () => {
      const paths = makePaths(testDir);
      selfRestart(paths, 'test-agent');

      const logPath = join(paths.logDir, 'restarts.log');
      const logContent = readFileSync(logPath, 'utf-8');
      expect(logContent).toContain('SELF-RESTART: no reason specified');
    });
  });

  describe('hardRestart', () => {
    it('creates .force-fresh and .restart-planned markers', () => {
      const paths = makePaths(testDir);
      hardRestart(paths, 'test-agent', 'context handoff');

      expect(existsSync(join(paths.stateDir, '.force-fresh'))).toBe(true);
      expect(existsSync(join(paths.stateDir, '.restart-planned'))).toBe(true);
      const logContent = readFileSync(join(paths.logDir, 'restarts.log'), 'utf-8');
      expect(logContent).toContain('HARD-RESTART: context handoff');
    });

    it('uses default reason when none provided', () => {
      const paths = makePaths(testDir);
      hardRestart(paths, 'test-agent');
      const logContent = readFileSync(join(paths.logDir, 'restarts.log'), 'utf-8');
      expect(logContent).toContain('HARD-RESTART: no reason specified');
    });
  });

  describe('autoCommit', () => {
    let gitDir: string;

    beforeEach(() => {
      gitDir = mkdtempSync(join(tmpdir(), 'cortextos-autocommit-test-'));
      execSync('git init', { cwd: gitDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: gitDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: gitDir, stdio: 'pipe' });
      // Create initial commit so git status works properly
      writeFileSync(join(gitDir, '.gitkeep'), '');
      execSync('git add .gitkeep && git commit -m "init"', { cwd: gitDir, stdio: 'pipe' });
    });

    afterEach(() => {
      rmSync(gitDir, { recursive: true, force: true });
    });

    it('filters out .env files', () => {
      writeFileSync(join(gitDir, 'app.env'), 'SECRET=abc');
      writeFileSync(join(gitDir, 'safe.txt'), 'hello');

      const report = autoCommit(gitDir, true);
      expect(report.status).toBe('dry_run');
      expect(report.staged).toContain('safe.txt');
      expect(report.blocked.some(b => b.includes('app.env'))).toBe(true);
    });

    it('blocks all dot-env variants (.env.local, .env.production)', () => {
      writeFileSync(join(gitDir, '.env.local'), 'token=A8kQ2mZ9pL4vX7wR1tB6nC3dF5gH0jY');
      writeFileSync(join(gitDir, '.env.production'), 'API_KEY=kJ8mN2pQ7rT4wX9zB1cD6fH3g');

      const report = autoCommit(gitDir, true);
      expect(report.staged).not.toContain('.env.local');
      expect(report.staged).not.toContain('.env.production');
      expect(report.blocked.some(b => b.includes('.env.local'))).toBe(true);
      expect(report.blocked.some(b => b.includes('.env.production'))).toBe(true);
    });

    it('filters out files with credential patterns', () => {
      // Realistic leaked secret: keyword assignment with a high-entropy value.
      writeFileSync(join(gitDir, 'config.json'), '{"api_secret": "A8kQ2mZ9pL4vX7wR1tB6nC3dF5gH0jY"}');
      writeFileSync(join(gitDir, 'readme.md'), 'just a readme');

      const report = autoCommit(gitDir, true);
      expect(report.blocked.some(b => b.includes('config.json') && b.includes('credential'))).toBe(true);
      expect(report.staged).toContain('readme.md');
    });

    it('does not flag false positives (cookie-name comments, package-lock substrings)', () => {
      // proxy.ts regression: a comment mentioning a query param is not a secret.
      writeFileSync(
        join(gitDir, 'proxy.ts'),
        '// SSE endpoints require ?token=<jwt> auth\nconst name = "__Secure-authjs.session-token";\n',
      );
      // package-lock regression: "microtask-" contains "sk-"; integrity is base64.
      writeFileSync(
        join(gitDir, 'package-lock.json'),
        '{\n  "resolved": "https://registry.npmjs.org/queue-microtask/-/queue-microtask-1.2.3.tgz",\n  "integrity": "sha512-AKIAabc123token=secretkey=NkO8RvCxxQ9z+mD7w0pLqWeRtYuIoP2aSdFgHjKl=="\n}\n',
      );

      const report = autoCommit(gitDir, true);
      expect(report.staged).toContain('proxy.ts');
      expect(report.staged).toContain('package-lock.json');
      expect(report.blocked.some(b => b.includes('proxy.ts'))).toBe(false);
      expect(report.blocked.some(b => b.includes('package-lock.json'))).toBe(false);
    });

    it('allows script files even with credential-like patterns', () => {
      writeFileSync(join(gitDir, 'deploy.sh'), '#!/bin/bash\ntoken=get_from_env');
      writeFileSync(join(gitDir, 'app.py'), 'password=input("Enter:")');
      writeFileSync(join(gitDir, 'main.js'), 'const secret=process.env.SECRET');

      const report = autoCommit(gitDir, true);
      expect(report.staged).toContain('deploy.sh');
      expect(report.staged).toContain('app.py');
      expect(report.staged).toContain('main.js');
    });

    it('filters out binary/temp files', () => {
      writeFileSync(join(gitDir, 'output.log'), 'log data');
      writeFileSync(join(gitDir, 'cache.tmp'), 'temp');
      writeFileSync(join(gitDir, 'app.pid'), '12345');

      const report = autoCommit(gitDir, true);
      expect(report.blocked.some(b => b.includes('output.log'))).toBe(true);
      expect(report.blocked.some(b => b.includes('cache.tmp'))).toBe(true);
      expect(report.blocked.some(b => b.includes('app.pid'))).toBe(true);
    });

    it('dry-run does not stage files', () => {
      writeFileSync(join(gitDir, 'newfile.txt'), 'content');

      const report = autoCommit(gitDir, true);
      expect(report.status).toBe('dry_run');

      // Verify nothing is staged
      const staged = execSync('git diff --cached --name-only', { cwd: gitDir, encoding: 'utf-8' });
      expect(staged.trim()).toBe('');
    });

    it('returns clean when no changes', () => {
      const report = autoCommit(gitDir);
      expect(report.status).toBe('clean');
    });

    it('stages safe files when not dry-run', () => {
      writeFileSync(join(gitDir, 'newfile.txt'), 'content');

      const report = autoCommit(gitDir, false);
      expect(report.status).toBe('staged');
      expect(report.staged).toContain('newfile.txt');

      // Verify file is actually staged
      const staged = execSync('git diff --cached --name-only', { cwd: gitDir, encoding: 'utf-8' });
      expect(staged.trim()).toContain('newfile.txt');
    });

    it('returns nothing_to_stage when all files blocked', () => {
      writeFileSync(join(gitDir, 'secrets.env'), 'API_KEY=123');

      const report = autoCommit(gitDir);
      expect(report.status).toBe('nothing_to_stage');
      expect(report.blocked.length).toBeGreaterThan(0);
    });
  });

  describe('checkGoalStaleness', () => {
    it('identifies stale goals', () => {
      // Create org/agent structure with old timestamp
      const agentDir = join(testDir, 'orgs', 'myorg', 'agents', 'worker');
      mkdirSync(agentDir, { recursive: true });

      const oldDate = new Date(Date.now() - 10 * 86400 * 1000).toISOString();
      writeFileSync(join(agentDir, 'GOALS.md'), `# Goals\n\n## Updated\n${oldDate}\n\nSome goal`);

      const report = checkGoalStaleness(testDir, 7);
      expect(report.summary.total).toBe(1);
      expect(report.summary.stale).toBe(1);
      expect(report.agents[0].status).toBe('stale');
      expect(report.agents[0].agent).toBe('worker');
      expect(report.agents[0].org).toBe('myorg');
      expect(report.agents[0].stale).toBe(true);
    });

    it('identifies fresh goals', () => {
      const agentDir = join(testDir, 'orgs', 'myorg', 'agents', 'worker');
      mkdirSync(agentDir, { recursive: true });

      const recentDate = new Date().toISOString();
      writeFileSync(join(agentDir, 'GOALS.md'), `# Goals\n\n## Updated\n${recentDate}\n\nSome goal`);

      const report = checkGoalStaleness(testDir, 7);
      expect(report.summary.fresh).toBe(1);
      expect(report.agents[0].status).toBe('fresh');
      expect(report.agents[0].stale).toBe(false);
    });

    it('handles missing GOALS.md', () => {
      const agentDir = join(testDir, 'orgs', 'myorg', 'agents', 'worker');
      mkdirSync(agentDir, { recursive: true });
      // No GOALS.md created

      const report = checkGoalStaleness(testDir);
      expect(report.agents[0].status).toBe('missing');
      expect(report.agents[0].stale).toBe(true);
      expect(report.agents[0].reason).toContain('no GOALS.md');
    });

    it('handles missing timestamp in GOALS.md', () => {
      const agentDir = join(testDir, 'orgs', 'myorg', 'agents', 'worker');
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(agentDir, 'GOALS.md'), '# Goals\n\nJust some text without updated section');

      const report = checkGoalStaleness(testDir);
      expect(report.agents[0].status).toBe('no_timestamp');
      expect(report.agents[0].stale).toBe(true);
    });

    it('handles unparseable timestamp', () => {
      const agentDir = join(testDir, 'orgs', 'myorg', 'agents', 'worker');
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(agentDir, 'GOALS.md'), '# Goals\n\n## Updated\nnot-a-date\n');

      const report = checkGoalStaleness(testDir);
      expect(report.agents[0].status).toBe('parse_error');
      expect(report.agents[0].stale).toBe(true);
    });

    it('returns empty report when no orgs directory', () => {
      const report = checkGoalStaleness(testDir);
      expect(report.summary.total).toBe(0);
      expect(report.agents).toEqual([]);
    });

    it('scans multiple orgs and agents', () => {
      // Create two orgs with agents
      for (const org of ['org1', 'org2']) {
        const agentDir = join(testDir, 'orgs', org, 'agents', 'bot');
        mkdirSync(agentDir, { recursive: true });
        const date = new Date().toISOString();
        writeFileSync(join(agentDir, 'GOALS.md'), `# Goals\n\n## Updated\n${date}\n`);
      }

      const report = checkGoalStaleness(testDir);
      expect(report.summary.total).toBe(2);
    });
  });

  describe('postActivity', () => {
    it('returns false when not configured', async () => {
      const result = await postActivity(
        join(testDir, 'nonexistent'),
        testDir,
        'myorg',
        'hello',
      );
      expect(result).toBe(false);
    });

    it('returns false when env file has no token', async () => {
      const orgDir = join(testDir, 'orgdir');
      mkdirSync(orgDir, { recursive: true });
      writeFileSync(join(orgDir, 'activity-channel.env'), 'ACTIVITY_CHAT_ID=123\n');

      const result = await postActivity(orgDir, testDir, 'myorg', 'hello');
      expect(result).toBe(false);
    });

    it('returns false when env file has no chat ID', async () => {
      const orgDir = join(testDir, 'orgdir');
      mkdirSync(orgDir, { recursive: true });
      writeFileSync(join(orgDir, 'activity-channel.env'), 'ACTIVITY_BOT_TOKEN=abc123\n');

      const result = await postActivity(orgDir, testDir, 'myorg', 'hello');
      expect(result).toBe(false);
    });
  });

  describe('containsCredential', () => {
    // --- False positives that previously blocked auto-commit (2026-06-01) ---
    it('ignores cookie-name comments in source (proxy.ts regression)', () => {
      expect(containsCredential('// SSE endpoints require ?token=<jwt> auth', 'proxy.ts')).toBe(false);
      expect(containsCredential('const COOKIE = "__Secure-authjs.session-token";', 'proxy.ts')).toBe(false);
    });

    it('ignores "sk-" substring inside package names (package-lock regression)', () => {
      const line = '"resolved": "https://registry.npmjs.org/queue-microtask/-/queue-microtask-1.2.3.tgz",';
      expect(containsCredential(line, 'package-lock.json')).toBe(false);
    });

    it('ignores base64 integrity hashes in lockfiles', () => {
      const line = '      "integrity": "sha512-AKIAtoken=secretkey=NkO8RvCxxQ9z+mD7w0pLqWeRtYuIoP2aSdFgHjKl==",';
      expect(containsCredential(line, 'package-lock.json')).toBe(false);
    });

    it('ignores bare identifiers and env-var references', () => {
      expect(containsCredential('const token = getToken();', 'a.ts')).toBe(false);
      expect(containsCredential('apiKey: process.env.API_KEY', 'a.ts')).toBe(false);
      expect(containsCredential('secret: "${VAULT_SECRET}"', 'a.ts')).toBe(false);
      expect(containsCredential('password = "your-password-here"', 'a.ts')).toBe(false);
    });

    // --- True positives that MUST still be caught ---
    it('flags real token formats', () => {
      expect(containsCredential('const k = "sk-' + 'a'.repeat(40) + '"', 'a.ts')).toBe(true);
      expect(containsCredential('GH=ghp_' + 'b'.repeat(36), 'a.ts')).toBe(true);
      expect(containsCredential('aws = AKIA' + 'ABCDEFGH12345678', 'a.ts')).toBe(true);
      // Azure connection string ending in base64 padding.
      expect(containsCredential('DefaultEndpointsProtocol=https;AccountKey=' + 'a'.repeat(86) + '==;', 'app.config')).toBe(true);
      // Anthropic key (hyphenated) in a plain source literal, no secret-keyword LHS.
      expect(containsCredential('const anthropic = "sk-ant-api03-' + 'x'.repeat(90) + '"', 'client.ts')).toBe(true);
    });

    it('flags unquoted secret assignments in YAML config', () => {
      expect(containsCredential('password: A8kQ2mZ9pL4vX7wR1tB6nC3dF5gH0jY', 'values.yaml')).toBe(true);
      expect(containsCredential('api_token=kJ8mN2pQ7rT4wX9zB1cD6fH3g', 'config.yml')).toBe(true);
    });

    it('flags unquoted secrets in extensionless + dotfile credential files', () => {
      expect(containsCredential('password=A8kQ2mZ9pL4vX7wR1tB6nC3dF5gH0jY', 'credentials')).toBe(true);
      expect(containsCredential('//registry.npmjs.org/:_authToken=npm_aB3kQ2mZ9pL4vX7wR1tB6nC3dF5gH0', '.npmrc')).toBe(true);
    });

    it('flags secret-keyword assignments with high-entropy literal values', () => {
      expect(containsCredential('"api_secret": "A8kQ2mZ9pL4vX7wR1tB6nC3dF5gH0jY"', 'config.json')).toBe(true);
      expect(containsCredential("auth_token = 'kJ8mN2pQ7rT4wX9zB1cD6fH3gL5vY0aS'", 'config.yaml')).toBe(true);
      // Quoted passwords with special characters (@ ! $ :) are captured too.
      expect(containsCredential('"password": "p@ssw0rd!ThisIsSecret"', 'config.json')).toBe(true);
    });

    it('does not flag quoted multi-word prose assigned to a secret-ish key', () => {
      expect(containsCredential('"secret_note": "remember to rotate this later"', 'config.json')).toBe(false);
    });

    it('flags UNQUOTED secret assignments in ini/properties-style configs', () => {
      // Regression: must not let unquoted config secrets slip through.
      expect(containsCredential('password=A8kQ2mZ9pL4vX7wR1tB6nC3dF5gH0jY', 'credentials.ini')).toBe(true);
      expect(containsCredential('api_key = kJ8mN2pQ7rT4wX9zB1cD6fH3g', 'app.properties')).toBe(true);
      // Passwords with special characters (@ ! $ :) are captured too.
      expect(containsCredential('password=p@ssw0rd!ThisIsSecret', 'app.conf')).toBe(true);
    });

    it('does NOT flag unquoted CODE expressions assigned to a secret keyword', () => {
      // proxy.ts:186 regression — value is code, not a literal secret.
      expect(containsCredential('const token = authHeader.slice(7);', 'proxy.ts')).toBe(false);
      expect(containsCredential('const secret = getSecretFromVault();', 'a.ts')).toBe(false);
      expect(containsCredential('password = hashedPasswordValue', 'a.ts')).toBe(false);
    });

    it('still flags a real token format even inside a lockfile (non-integrity line)', () => {
      const line = '  "_authToken": "sk-' + 'z'.repeat(40) + '"';
      expect(containsCredential(line, 'package-lock.json')).toBe(true);
    });
  });
});
