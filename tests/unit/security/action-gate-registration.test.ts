import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Drift guard (the #108 distribution-test model): every agent TEMPLATE must register
 * the action-gate PreToolUse hook, as the FIRST PreToolUse entry, with a matcher that
 * covers every file-mutating + external tool. A template that forgets it (or registers
 * it after another blocking hook) fails CI. This can only police TEMPLATES — live agent
 * settings under orgs/ are gitignored and updated by a direct deploy edit (documented in
 * the PR); the template guard ensures every FUTURE agent ships the gate.
 */
const TEMPLATE_ROOT = join(__dirname, '..', '..', '..', 'templates');
const TEMPLATES = ['agent', 'analyst', 'orchestrator'];
const REQUIRED_MATCHER_TOOLS = ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

function preToolUse(template: string): any[] {
  const p = join(TEMPLATE_ROOT, template, '.claude', 'settings.json');
  const settings = JSON.parse(readFileSync(p, 'utf-8'));
  return settings?.hooks?.PreToolUse ?? [];
}

describe('action-gate registration: every template registers hook-action-gate', () => {
  for (const template of TEMPLATES) {
    describe(`template: ${template}`, () => {
      it('registers cortextos bus hook-action-gate as a PreToolUse command hook', () => {
        const pre = preToolUse(template);
        const cmds = pre.flatMap((e: any) => (e.hooks ?? []).map((h: any) => h.command));
        expect(cmds, `${template} missing hook-action-gate`).toContain('cortextos bus hook-action-gate');
      });

      it('places hook-action-gate as the FIRST PreToolUse entry (security before liveness)', () => {
        const pre = preToolUse(template);
        const first = pre[0];
        const firstCmds = (first?.hooks ?? []).map((h: any) => h.command);
        expect(firstCmds, `${template} hook-action-gate is not first`).toContain('cortextos bus hook-action-gate');
      });

      it('the entry is a command hook with a matcher covering all mutating/external tools and a tight timeout', () => {
        const pre = preToolUse(template);
        const entry = pre.find((e: any) => (e.hooks ?? []).some((h: any) => h.command === 'cortextos bus hook-action-gate'));
        expect(entry).toBeDefined();
        // matcher must cover every file-mutating tool (Bash + Write/Edit/MultiEdit/NotebookEdit)
        for (const tool of REQUIRED_MATCHER_TOOLS) {
          expect(entry.matcher, `${template} matcher missing ${tool}`).toContain(tool);
        }
        const hook = entry.hooks.find((h: any) => h.command === 'cortextos bus hook-action-gate');
        expect(hook.type).toBe('command');
        expect(hook.timeout, `${template} timeout too high`).toBeLessThanOrEqual(5);
      });
    });
  }
});
