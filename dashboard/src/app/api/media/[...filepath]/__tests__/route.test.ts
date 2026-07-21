import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';

const rootTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'media-route-'));
const ctxRoot = path.join(rootTmp, 'ctx');
const frameworkRoot = path.join(rootTmp, 'framework');
const externalRoot = path.join(rootTmp, 'external-project');

process.env.CTX_ROOT = ctxRoot;
process.env.CTX_FRAMEWORK_ROOT = frameworkRoot;

type MediaRoute = typeof import('../route');
let media: MediaRoute;

beforeAll(async () => {
  media = await import('../route');
});

afterAll(() => {
  try { fs.rmSync(rootTmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  fs.rmSync(ctxRoot, { recursive: true, force: true });
  fs.rmSync(frameworkRoot, { recursive: true, force: true });
  fs.rmSync(externalRoot, { recursive: true, force: true });
  fs.mkdirSync(ctxRoot, { recursive: true });
  fs.mkdirSync(frameworkRoot, { recursive: true });
  fs.mkdirSync(externalRoot, { recursive: true });
});

function makeRequest(filepath: string[], search = ''): NextRequest {
  const urlPath = filepath.map(s => encodeURIComponent(s)).join('/');
  return new NextRequest(new URL(`/api/media/${urlPath}${search}`, 'http://localhost'));
}

function get(filepath: string[]) {
  return media.GET(makeRequest(filepath), { params: Promise.resolve({ filepath }) });
}

function splitFsPath(absPath: string): string[] {
  return absPath.replace(/\\/g, '/').split('/');
}

describe('GET /api/media/[...filepath] allowed roots', () => {
  it('serves files under CTX_ROOT so existing deliverables keep working', async () => {
    const deliverable = path.join(ctxRoot, 'orgs', 'korendigital', 'deliverables', 'forge', 'task_1', 'report.md');
    fs.mkdirSync(path.dirname(deliverable), { recursive: true });
    fs.writeFileSync(deliverable, '# Report');

    const res = await get(['orgs', 'korendigital', 'deliverables', 'forge', 'task_1', 'report.md']);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('# Report');
  });

  it('does not implicitly serve files from CTX_FRAMEWORK_ROOT', async () => {
    const secret = 'SHOULD_NOT_LEAK=1';
    fs.writeFileSync(path.join(frameworkRoot, '.env'), secret);

    const res = await get(['..', 'framework', '.env']);
    const body = await res.text();

    expect(res.status).toBe(404);
    expect(body).not.toContain(secret);
  });

  it('serves files from an explicit additional allowed root', async () => {
    const configDir = path.join(ctxRoot, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'allowed-roots.json'),
      JSON.stringify({ additional_roots: [externalRoot] }),
    );

    const report = path.join(externalRoot, 'report.md');
    fs.writeFileSync(report, '# External');

    const res = await get(splitFsPath(report));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('# External');
  });
});
