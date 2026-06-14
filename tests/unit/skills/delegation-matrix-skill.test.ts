import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const SKILL_PATH = join(ROOT, 'community', 'skills', 'delegation-matrix', 'SKILL.md');

describe('delegation-matrix skill policy', () => {
  const skill = readFileSync(SKILL_PATH, 'utf-8');

  it('formalizes Codex review as the standard build policy', () => {
    expect(skill).toContain('Codex review is the standard policy for build work');
    expect(skill).toContain('Do not use it to skip review for normal build PRs');
    expect(skill).toContain('| **Mode 1** | Standard reviewer |');
    expect(skill).toContain('| **Mode 2** | Implementer + reviewer |');
  });

  it('keeps no-Codex mode as an explicit exception rather than the default', () => {
    expect(skill).toContain('| **Mode 3** | Not used | Explicit no-Codex exception');
    expect(skill).toContain('Use only when Codex is unavailable or the orchestrator explicitly scopes the task as no-Codex.');
    expect(skill).not.toContain('Reviewer only | Out of the box');
    expect(skill).not.toContain('Code review before PR | — | **owns** (Mode 3)');
  });
});
