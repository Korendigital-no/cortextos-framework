/**
 * TOOLS.md ↔ CLI bus-command contract (task_1780837576225).
 *
 * Generalizes "test the documented command-line" — after the list-approvals
 * contract-drift bug (2026-06-07), where TOOLS.md promised a command/flag the
 * CLI did not expose. Every `cortextos bus <command>` documented in a shipped
 * template TOOLS.md MUST be a registered bus subcommand, so the docs can never
 * promise a command the CLI lacks; a doc that drifts ahead of the CLI fails the
 * build.
 *
 * Static parse of the command registry (src/cli/bus.ts `.command()` — the
 * source from which `cortextos bus --help` is generated): no build, no spawn,
 * deterministic. Scope: the `cortextos bus <command>` family (the bulk of
 * agent-facing commands and where this drift class bit). Top-level
 * `cortextos <command>` rows are a separate CLI surface, out of scope here.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(__dirname, '..', '..', '..');

/** Bus subcommands the CLI actually registers (source of `bus --help`). */
function registeredBusCommands(): Set<string> {
  const src = readFileSync(path.join(REPO, 'src/cli/bus.ts'), 'utf8');
  return new Set([...src.matchAll(/\.command\(['"]([a-z0-9-]+)['"]/g)].map((m) => m[1]));
}

/** Bus subcommands documented in each shipped template TOOLS.md command table. */
function documentedBusCommands(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const tplDir = path.join(REPO, 'templates');
  for (const tpl of readdirSync(tplDir)) {
    let txt: string;
    try {
      txt = readFileSync(path.join(tplDir, tpl, 'TOOLS.md'), 'utf8');
    } catch {
      continue; // template without a TOOLS.md
    }
    let inCommandTable = false;
    for (const line of txt.split('\n')) {
      if (/^\|\s*Command\s*\|/.test(line)) {
        inCommandTable = true; // header row of a "Command" table
        continue;
      }
      if (!inCommandTable) continue;
      if (!line.trim().startsWith('|')) {
        inCommandTable = false; // table ended
        continue;
      }
      const m = line.match(/^\|\s*`([^`]+)`/);
      if (!m) continue; // separator row (|---|) or a non-code cell
      const cmd = m[1].trim();
      if (cmd.startsWith('cortextos ')) continue; // top-level CLI, not a bus subcommand
      const name = cmd.split(/\s+/)[0];
      if (!out.has(name)) out.set(name, new Set());
      out.get(name)!.add(tpl);
    }
  }
  return out;
}

describe('TOOLS.md ↔ CLI bus-command contract', () => {
  it('every documented bus command exists in the CLI registry (no doc→CLI drift)', () => {
    const registered = registeredBusCommands();
    const documented = documentedBusCommands();
    const drift = [...documented.entries()]
      .filter(([cmd]) => !registered.has(cmd))
      .map(([cmd, tpls]) => `  ${cmd}  (documented in: ${[...tpls].sort().join(', ')})`);
    expect(
      drift,
      `Template TOOLS.md documents bus commands the CLI does not register ` +
        `(doc drifted ahead of src/cli/bus.ts):\n${drift.join('\n')}`,
    ).toEqual([]);
  });

  it('sanity: the parse found real commands on both sides (guards a silent no-op)', () => {
    // Without this, a regex that quietly matched nothing would make the contract
    // check a no-op that always "passes" — the classic rotted-test failure mode.
    expect(registeredBusCommands().size).toBeGreaterThan(50);
    expect(documentedBusCommands().size).toBeGreaterThan(20);
  });
});
