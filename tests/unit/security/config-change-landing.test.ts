import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { validateApprovalCategory, VALID_APPROVAL_CATEGORIES } from '../../../src/utils/validate';

const SRC = join(__dirname, '../../../src');

describe('config-change category landing (P1-C / P2-10)', () => {
  it('config-change is a valid approval category (else createApproval throws inside the gate)', () => {
    expect(VALID_APPROVAL_CATEGORIES).toContain('config-change');
    expect(() => validateApprovalCategory('config-change')).not.toThrow();
  });

  it('the full closed set is the 6 expected values (5 high-risk + other)', () => {
    expect(VALID_APPROVAL_CATEGORIES).toEqual([
      'external-comms', 'financial', 'deployment', 'data-deletion', 'config-change', 'other',
    ]);
  });

  it('SOURCE-INVARIANT: create-approval CLI derives its category list from VALID_APPROVAL_CATEGORIES (no drift)', () => {
    const bus = readFileSync(join(SRC, 'cli/bus.ts'), 'utf-8');
    // It must reference the shared constant...
    expect(bus).toMatch(/VALID_APPROVAL_CATEGORIES/);
    // ...and must NOT re-introduce a hardcoded category allow-list that can drift
    // from the validator (the old `['external-comms', ... 'other']` literal).
    expect(bus).not.toMatch(/\[\s*'external-comms',\s*'financial',\s*'deployment',\s*'data-deletion',\s*'other'\s*\]/);
  });

  it('SOURCE-INVARIANT: the default gated-category literals include config-change (interlock relies on it)', () => {
    for (const rel of ['cli/init.ts', 'cli/get-config.ts', 'cli/add-agent.ts', 'cli/import-agent.ts']) {
      const txt = readFileSync(join(SRC, rel), 'utf-8');
      // every place that hardcodes the 4-tuple default now carries config-change
      const hasBareFourTuple = /'external-comms',\s*'financial',\s*'deployment',\s*'data-deletion'\s*\]/.test(txt);
      expect(hasBareFourTuple, `${rel} still has a config-change-less default list`).toBe(false);
    }
  });
});
