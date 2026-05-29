import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Framework-side (CLI) content-status-audit scanner. Hermetic temp blog dir
// via the WEBSITE_REPO_PATH env override (read at call-time). Self-contained:
// no dashboard import, no gray-matter.

let tmpRoot: string;
let blogDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-status-audit-'));
  blogDir = path.join(tmpRoot, 'content', 'blog');
  fs.mkdirSync(blogDir, { recursive: true });
  process.env.WEBSITE_REPO_PATH = tmpRoot;
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.WEBSITE_REPO_PATH;
});

function write(filename: string, content: string): void {
  fs.writeFileSync(path.join(blogDir, filename), content, 'utf-8');
}

const healthy = (status: string, slug?: string) => `---
title: A Post
date: '2026-05-29'
${slug ? `slug: ${slug}\n` : ''}excerpt: >-
  A short excerpt that spans
  more than one line.
status: ${status}
---

Body text.
`;

describe('framework auditContentStatus', () => {
  it('clean corpus → ok:true, no drift, lists published slugs', async () => {
    write('alpha.md', healthy('published'));
    write('beta.md', healthy('draft'));
    write('gamma.mdx', healthy('published'));
    write('README.md', '# readme, not a post');

    const { auditContentStatus } = await import('../../../src/bus/content-status-audit.js');
    const report = auditContentStatus();

    expect(report.ok).toBe(true);
    expect(report.drift).toHaveLength(0);
    expect(report.published.sort()).toEqual(['alpha', 'gamma']);
  });

  it('published post missing required excerpt → drift', async () => {
    write('good.md', healthy('published'));
    write(
      'broken.md',
      `---
title: Broken
date: '2026-05-29'
status: published
---

Body.
`,
    );

    const { auditContentStatus } = await import('../../../src/bus/content-status-audit.js');
    const report = auditContentStatus();

    expect(report.ok).toBe(false);
    expect(report.published).toContain('good');
    const d = report.drift.find((x) => x.filename === 'broken.md');
    expect(d).toBeTruthy();
    expect(d!.reason).toBe('published-but-missing-required-field');
    expect(d!.detail).toMatch(/excerpt/);
  });

  it('duplicate published slug → drift on both', async () => {
    write('first.md', healthy('published', 'shared-slug'));
    write('second.md', healthy('published', 'shared-slug'));

    const { auditContentStatus } = await import('../../../src/bus/content-status-audit.js');
    const report = auditContentStatus();

    expect(report.ok).toBe(false);
    const dups = report.drift.filter((d) => d.reason === 'published-but-duplicate-slug');
    expect(dups.map((d) => d.filename).sort()).toEqual(['first.md', 'second.md']);
  });

  it('broken draft is NOT drift (no publish intent)', async () => {
    write('ok.md', healthy('published'));
    write(
      'draft-broken.md',
      `---
title: Draft Broken
date: '2026-05-29'
status: draft
---

Body.
`,
    );

    const { auditContentStatus } = await import('../../../src/bus/content-status-audit.js');
    const report = auditContentStatus();

    expect(report.ok).toBe(true);
    expect(report.drift).toHaveLength(0);
  });

  it('formatAuditReport produces readable text, no raw JSON', async () => {
    write('first.md', healthy('published', 'dup'));
    write('second.md', healthy('published', 'dup'));

    const { auditContentStatus, formatAuditReport } = await import(
      '../../../src/bus/content-status-audit.js'
    );
    const text = formatAuditReport(auditContentStatus());

    expect(text).toMatch(/Content status audit/);
    expect(text).toMatch(/Drift detected/);
    expect(text).toMatch(/duplicate-slug/);
    // No raw JSON braces dumping the object.
    expect(text).not.toMatch(/\{"/);
    expect(text).not.toMatch(/"drift":/);
  });

  it('missing blog dir → empty clean report', async () => {
    fs.rmSync(blogDir, { recursive: true, force: true });
    const { auditContentStatus } = await import('../../../src/bus/content-status-audit.js');
    const report = auditContentStatus();
    expect(report.ok).toBe(true);
    expect(report.published).toHaveLength(0);
    expect(report.drift).toHaveLength(0);
  });

  it('status with trailing YAML comment still registers as published', async () => {
    // `status: published # note` is valid YAML → published. The scanner must
    // not treat the comment as part of the value (codex MED).
    write(
      'commented.md',
      `---
title: Commented
date: '2026-05-29'
status: published # ready to ship
---

Body.
`,
    );
    const { auditContentStatus } = await import('../../../src/bus/content-status-audit.js');
    const report = auditContentStatus();
    // It IS intended-published and IS missing excerpt → must be flagged, not invisible.
    expect(report.ok).toBe(false);
    const d = report.drift.find((x) => x.filename === 'commented.md');
    expect(d).toBeTruthy();
    expect(d!.reason).toBe('published-but-missing-required-field');
  });

  it('published post with title: null is flagged as missing required field', async () => {
    write(
      'nulltitle.md',
      `---
title: null
date: '2026-05-29'
excerpt: Has excerpt.
status: published
---

Body.
`,
    );
    const { auditContentStatus } = await import('../../../src/bus/content-status-audit.js');
    const report = auditContentStatus();
    expect(report.ok).toBe(false);
    const d = report.drift.find((x) => x.filename === 'nulltitle.md');
    expect(d!.reason).toBe('published-but-missing-required-field');
    expect(d!.detail).toMatch(/title/);
  });

  it('quoted status with a trailing comment still registers as published', async () => {
    write(
      'quoted.md',
      `---
title: Quoted
date: '2026-05-29'
status: "published" # ship it
---

Body.
`,
    );
    const { auditContentStatus } = await import('../../../src/bus/content-status-audit.js');
    const report = auditContentStatus();
    // Intended-published + missing excerpt → must be flagged, not invisible.
    expect(report.ok).toBe(false);
    const d = report.drift.find((x) => x.filename === 'quoted.md');
    expect(d!.reason).toBe('published-but-missing-required-field');
  });

  it('published post with an unterminated quoted required field is flagged', async () => {
    // title opens a quote that never closes → the real loader rejects it; the
    // scanner normalizes to empty so the required-field check trips.
    write(
      'unterminated.md',
      `---
title: "Broken
date: '2026-05-29'
excerpt: Has excerpt.
status: published
---

Body.
`,
    );
    const { auditContentStatus } = await import('../../../src/bus/content-status-audit.js');
    const report = auditContentStatus();
    expect(report.ok).toBe(false);
    const d = report.drift.find((x) => x.filename === 'unterminated.md');
    expect(d!.reason).toBe('published-but-missing-required-field');
    expect(d!.detail).toMatch(/title/);
  });

  it('published post with an invalid slug is flagged', async () => {
    write(
      'badslug.md',
      `---
title: Bad Slug
date: '2026-05-29'
excerpt: Has excerpt.
slug: Not A Valid Slug!
status: published
---

Body.
`,
    );
    const { auditContentStatus } = await import('../../../src/bus/content-status-audit.js');
    const report = auditContentStatus();
    expect(report.ok).toBe(false);
    const d = report.drift.find((x) => x.filename === 'badslug.md');
    expect(d!.reason).toBe('published-but-invalid-slug');
  });
});
