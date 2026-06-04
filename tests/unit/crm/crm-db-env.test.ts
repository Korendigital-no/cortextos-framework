/**
 * getCrmDb environment resolution (task_1780606343419).
 *
 * THE BUG: crm-db.ts read process.env.CTX_ROOT directly and THREW when it was
 * absent — even though resolveEnv() (used by the rest of the bus CLI) falls
 * back to .cortextos-env and the canonical default root
 * ~/.cortextos/<instanceId>. Every CRM CLI command (crm-contacts, crm-pipeline,
 * webhook processing, ...) was therefore unusable outside agent subprocesses
 * that happen to export CTX_ROOT. Found by codex review (PR #64 R1 bycatch).
 *
 * THE FIX: resolve ctxRoot/instanceId through resolveEnv() like every other
 * bus module. resolveEnv never returns an empty ctxRoot, so the throw is gone.
 *
 * Test isolation: getCrmDb caches a module-level singleton, so each test
 * resets modules and re-imports. HOME is pointed at a temp dir so the
 * default-root path never touches the real ~/.cortextos.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let savedEnv: Record<string, string | undefined>;
let tmpHome: string;
let cwdBefore: string;

beforeEach(() => {
  // Snapshot and clear EVERY CTX_* key plus HOME: resolveEnv also reads
  // CTX_FRAMEWORK_ROOT / CTX_PROJECT_ROOT / CTX_AGENT_DIR (whose ambient
  // values from an agent shell can trip the sandbox/live leak guards),
  // CTX_TIMEZONE and CTX_ORCHESTRATOR. Tests opt back in per-case.
  savedEnv = Object.fromEntries(
    Object.keys(process.env)
      .filter(k => k.startsWith('CTX_'))
      .concat('HOME')
      .map(k => [k, process.env[k]]),
  );
  for (const k of Object.keys(savedEnv)) {
    if (k !== 'HOME') delete process.env[k];
  }
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-db-env-'));
  // cwd matters: resolveEnv reads .cortextos-env from cwd — run from the temp
  // dir so a stray .cortextos-env in the repo can't leak into the test.
  cwdBefore = process.cwd();
  process.chdir(tmpHome);
  vi.resetModules();
});

afterEach(async () => {
  const { closeCrmDb } = await import('../../../src/bus/crm-db.js');
  closeCrmDb();
  process.chdir(cwdBefore);
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('CTX_') && !(k in savedEnv)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('getCrmDb environment resolution', () => {
  it('works WITHOUT CTX_ROOT — falls back to the resolveEnv default root', async () => {
    delete process.env.CTX_ROOT;
    delete process.env.CTX_INSTANCE_ID;
    process.env.HOME = tmpHome; // os.homedir() honors $HOME on POSIX

    const { getCrmDb } = await import('../../../src/bus/crm-db.js');
    const db = getCrmDb(); // previously: threw "CTX_ROOT ... is required"
    // Sanity: the connection is usable and the schema initialized.
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='crm_contacts'").get()).toBeTruthy();

    const expected = path.join(tmpHome, '.cortextos', 'default', 'dashboard', 'cortextos-default.db');
    expect(fs.existsSync(expected), `expected DB at default root: ${expected}`).toBe(true);
  });

  it('honors an explicit CTX_ROOT (and CTX_INSTANCE_ID) exactly as before', async () => {
    const ctxRoot = path.join(tmpHome, 'explicit-root');
    process.env.CTX_ROOT = ctxRoot;
    process.env.CTX_INSTANCE_ID = 'testinst';

    const { getCrmDb } = await import('../../../src/bus/crm-db.js');
    getCrmDb();
    expect(fs.existsSync(path.join(ctxRoot, 'dashboard', 'cortextos-testinst.db'))).toBe(true);
  });

  it('works from a cwd whose basename is not a valid agent name (e.g. ~/Documents)', async () => {
    // resolveEnv defaults agentName to basename(cwd) and validates it.
    // getCrmDb consumes only ctxRoot/instanceId, so it pins a constant
    // agentName override — running a CRM CLI command from an uppercase or
    // dotted directory must not throw "CTX_AGENT_NAME is invalid".
    delete process.env.CTX_ROOT;
    delete process.env.CTX_INSTANCE_ID;
    delete process.env.CTX_AGENT_NAME;
    process.env.HOME = tmpHome;
    const uppercaseCwd = path.join(tmpHome, 'MyProject');
    fs.mkdirSync(uppercaseCwd);
    process.chdir(uppercaseCwd);

    const { getCrmDb } = await import('../../../src/bus/crm-db.js');
    expect(() => getCrmDb()).not.toThrow();
  });

  it('honors a .cortextos-env file in cwd when env vars are absent', async () => {
    delete process.env.CTX_ROOT;
    delete process.env.CTX_INSTANCE_ID;
    process.env.HOME = tmpHome;
    const fileRoot = path.join(tmpHome, 'file-root');
    fs.writeFileSync(path.join(tmpHome, '.cortextos-env'), `CTX_ROOT=${fileRoot}\n`);

    const { getCrmDb } = await import('../../../src/bus/crm-db.js');
    getCrmDb();
    expect(fs.existsSync(path.join(fileRoot, 'dashboard', 'cortextos-default.db'))).toBe(true);
  });

  it('INTENTIONAL behavior change: .cortextos-env CTX_INSTANCE_ID is honored even when CTX_ROOT is exported', async () => {
    // Before this fix, instanceId came only from process.env (?? 'default'),
    // so exported-CTX_ROOT + file-only CTX_INSTANCE_ID silently used
    // cortextos-default.db. resolveEnv merges per-field (env var > file >
    // default) — the same DB-selection semantics as every other bus module.
    // This pins the merge so the divergence cannot silently return.
    const ctxRoot = path.join(tmpHome, 'mixed-root');
    process.env.CTX_ROOT = ctxRoot;
    delete process.env.CTX_INSTANCE_ID;
    fs.writeFileSync(path.join(tmpHome, '.cortextos-env'), 'CTX_INSTANCE_ID=fileinst\n');

    const { getCrmDb } = await import('../../../src/bus/crm-db.js');
    getCrmDb();
    expect(fs.existsSync(path.join(ctxRoot, 'dashboard', 'cortextos-fileinst.db'))).toBe(true);
  });

  it('source-invariant: crm-db.ts resolves env through resolveEnv, never raw process.env', () => {
    const src = fs.readFileSync(
      path.join(cwdBefore, 'src', 'bus', 'crm-db.ts'),
      'utf8',
    );
    expect(src, 'crm-db.ts must call resolveEnv()').toMatch(/resolveEnv\(/);
    expect(src, 'crm-db.ts must not read process.env.CTX_ROOT directly').not.toMatch(
      /process\.env\.CTX_ROOT/,
    );
    expect(src, 'the CTX_ROOT-required throw must be gone').not.toMatch(/is required for CRM/);
  });
});
