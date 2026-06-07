/**
 * tests/unit/cli/ecosystem-config.test.ts — portable ecosystem.config.js
 * (codex bycatch, stale-base, webhook-PR review 2026-06-05;
 * task_1780642446378)
 *
 * The committed ecosystem.config.js baked ABSOLUTE host paths
 * (/Users/<user>/cortextos/...) and a CTX_ROOT fallback hardcoded to the
 * 'default' instance:
 *   - any other checkout/host (and the imminent machine swap) breaks — PM2
 *     points at a dist/ that does not exist there;
 *   - `CTX_INSTANCE_ID=foo pm2 restart` WITHOUT CTX_ROOT set split state:
 *     the daemon ran as instance foo but wrote to ~/.cortextos/default.
 *
 * Contract pinned here: when the config is generated into the project root
 * (the normal case), all paths derive from __dirname at PM2-load time, and
 * CTX_ROOT derives from the EFFECTIVE instance (env override included).
 * When generated elsewhere (--output to another dir), absolute paths are
 * kept — __dirname would point at the wrong place.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { createRequire } from 'module';
import { renderEcosystemConfig } from '../../../src/cli/ecosystem';

const require_ = createRequire(import.meta.url);

let tmp: string;
let n = 0;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['CTX_INSTANCE_ID', 'CTX_ROOT', 'CTX_ORG'];

/** Write the rendered config into `dir` and require() it fresh. */
function loadConfig(content: string, dir: string): { apps: Array<Record<string, any>> } {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `ecosystem-${n++}.config.js`);
  writeFileSync(file, content, 'utf-8');
  delete require_.cache[file];
  return require_(file);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ecosystem-cfg-'));
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe('renderEcosystemConfig — portable paths (output in project root)', () => {
  function render(projectRoot: string) {
    return renderEcosystemConfig({
      projectRoot,
      outputDir: projectRoot,
      instance: 'default',
      org: 'testorg',
      hasDashboard: false,
      dashboardDir: join(projectRoot, 'dashboard'),
      isWindows: false,
    });
  }

  it('does not bake the generation-time project root into the file', () => {
    const projectRoot = join(tmp, 'checkout-a');
    const content = render(projectRoot);
    expect(content).not.toContain(projectRoot);
  });

  it('derives script/cwd/roots from __dirname at load time — survives a moved checkout', () => {
    const projectRoot = join(tmp, 'checkout-a');
    const content = render(projectRoot);
    // Load the SAME file from a DIFFERENT directory (simulates new host/checkout).
    const cfg = loadConfig(content, join(tmp, 'checkout-b'));
    // realpath: macOS tmpdir is /var -> /private/var; __dirname is the real path.
    const otherCheckout = realpathSync(join(tmp, 'checkout-b'));
    const daemon = cfg.apps[0];
    expect(daemon.script).toBe(join(otherCheckout, 'dist', 'daemon.js'));
    expect(daemon.cwd).toBe(otherCheckout);
    expect(daemon.env.CTX_FRAMEWORK_ROOT).toBe(otherCheckout);
    expect(daemon.env.CTX_PROJECT_ROOT).toBe(otherCheckout);
  });

  it('CTX_ROOT follows the EFFECTIVE instance: CTX_INSTANCE_ID=foo without CTX_ROOT -> ~/.cortextos/foo', () => {
    const projectRoot = join(tmp, 'checkout-a');
    const content = render(projectRoot);
    process.env.CTX_INSTANCE_ID = 'foo';
    const cfg = loadConfig(content, projectRoot);
    const daemon = cfg.apps[0];
    expect(daemon.env.CTX_INSTANCE_ID).toBe('foo');
    expect(daemon.env.CTX_ROOT).toBe(join(homedir(), '.cortextos', 'foo'));
    expect(daemon.args).toBe('--instance foo');
  });

  it('an explicit CTX_ROOT env override still wins', () => {
    const projectRoot = join(tmp, 'checkout-a');
    const content = render(projectRoot);
    process.env.CTX_INSTANCE_ID = 'foo';
    process.env.CTX_ROOT = '/custom/root';
    const cfg = loadConfig(content, projectRoot);
    expect(cfg.apps[0].env.CTX_ROOT).toBe('/custom/root');
  });

  it('falls back to the baked --instance value when no env is set', () => {
    const projectRoot = join(tmp, 'checkout-a');
    const content = renderEcosystemConfig({
      projectRoot,
      outputDir: projectRoot,
      instance: 'staging',
      org: 'testorg',
      hasDashboard: false,
      dashboardDir: join(projectRoot, 'dashboard'),
      isWindows: false,
    });
    const cfg = loadConfig(content, projectRoot);
    const daemon = cfg.apps[0];
    expect(daemon.env.CTX_INSTANCE_ID).toBe('staging');
    expect(daemon.env.CTX_ROOT).toBe(join(homedir(), '.cortextos', 'staging'));
  });

  it('dashboard block is also __dirname-derived', () => {
    const projectRoot = join(tmp, 'checkout-a');
    const content = renderEcosystemConfig({
      projectRoot,
      outputDir: projectRoot,
      instance: 'default',
      org: 'testorg',
      hasDashboard: true,
      dashboardDir: join(projectRoot, 'dashboard'),
      isWindows: false,
    });
    expect(content).not.toContain(projectRoot);
    const cfg = loadConfig(content, join(tmp, 'checkout-b'));
    const otherCheckout = realpathSync(join(tmp, 'checkout-b'));
    const dash = cfg.apps.find((a) => a.name === 'cortextos-dashboard')!;
    expect(dash.cwd).toBe(join(otherCheckout, 'dashboard'));
  });
});

describe('renderEcosystemConfig — output OUTSIDE the project root keeps absolute paths', () => {
  it('__dirname would point at the wrong place, so paths stay absolute and correct', () => {
    const projectRoot = join(tmp, 'checkout-a');
    const elsewhere = join(tmp, 'elsewhere');
    const content = renderEcosystemConfig({
      projectRoot,
      outputDir: elsewhere,
      instance: 'default',
      org: 'testorg',
      hasDashboard: false,
      dashboardDir: join(projectRoot, 'dashboard'),
      isWindows: false,
    });
    const cfg = loadConfig(content, elsewhere);
    const daemon = cfg.apps[0];
    expect(daemon.script).toBe(join(projectRoot, 'dist', 'daemon.js'));
    expect(daemon.cwd).toBe(projectRoot);
    // Instance-derived CTX_ROOT applies regardless of path mode.
    process.env.CTX_INSTANCE_ID = 'bar';
    const cfg2 = loadConfig(content, elsewhere);
    expect(cfg2.apps[0].env.CTX_ROOT).toBe(join(homedir(), '.cortextos', 'bar'));
  });
});
