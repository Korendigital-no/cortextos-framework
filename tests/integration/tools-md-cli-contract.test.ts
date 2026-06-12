/**
 * Contract-drift guard: every command/flag documented in a TOOLS.md must
 * actually exist in the CLI (task_1780837576225).
 *
 * Background: TOOLS.md is the agents' command cheat-sheet. When a documented
 * command or flag does not exist in the CLI (the `list-approvals` class of bug),
 * agents build commands that fail at runtime. This test parses the documented
 * command line out of every TOOLS.md and asserts it against the AUTHORITATIVE
 * CLI contract — commander's registered `bus` subcommands and their options,
 * which is exactly what `cortextos bus --help` is generated from. Documentation
 * promising a command/flag the CLI doesn't have fails the build.
 *
 * Generalizes the regression-test principle "test the DOCUMENTED command line".
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { busCommand } from '../../src/cli/bus.js';

const ROOT = process.cwd();

// --- Authoritative CLI contract (commander registry) -----------------------
// command name (and aliases) -> set of registered long flags for that command.
const cliCommands = new Map<string, Set<string>>();
/** Long flags of a command AND all its nested subcommands (so a documented
 *  `crm-contacts … --flag` whose flag lives on a nested `list`/`create` still
 *  resolves — the parser only sees the top-level verb). */
function collectFlags(cmd: import('commander').Command): Set<string> {
  const longs = new Set<string>();
  for (const o of cmd.options) if (o.long) longs.add(o.long);
  longs.add('--help'); // commander auto-adds this to every command
  for (const sub of cmd.commands) for (const f of collectFlags(sub)) longs.add(f);
  return longs;
}
for (const c of busCommand.commands) {
  const longs = collectFlags(c);
  cliCommands.set(c.name(), longs);
  for (const alias of c.aliases()) cliCommands.set(alias, longs);
}
// bus-group-level options apply to every subcommand.
const globalFlags = new Set<string>(
  busCommand.options.map((o) => o.long).filter((l): l is string => !!l),
);
globalFlags.add('--help');

// --- TOOLS.md parser -------------------------------------------------------
interface DocCommand {
  file: string;
  cmd: string;
  flags: string[];
  raw: string;
}

/**
 * Parse the "## Command Index" section of a TOOLS.md. Each documented command
 * is the first backticked token of a markdown table row, e.g.
 *   | `create-task "<title>" --desc "<desc>"` | Create a task |
 * yields { cmd: 'create-task', flags: ['--desc'] }. The Environment Variables
 * section (before Command Index) is skipped so env vars aren't read as commands.
 */
function parseToolsMd(file: string): DocCommand[] {
  const md = readFileSync(file, 'utf-8');
  const rel = file.replace(ROOT + '/', '');
  const out: DocCommand[] = [];
  let inIndex = false;
  for (const line of md.split('\n')) {
    if (line.startsWith('## ')) inIndex = /Command Index/i.test(line);
    if (!inIndex) continue;
    const m = line.match(/^\|\s*`([^`]+)`\s*\|/);
    if (!m) continue;
    const cell = m[1].trim();
    const tokens = cell.split(/\s+/);
    let cmd = tokens[0];
    // Full form `cortextos bus <verb> …` documents a bus command → validate the
    // verb. `cortextos <x>` where x != bus documents a TOP-LEVEL command
    // (start/status/stop/…), out of scope for this bus-contract check (validating
    // those needs the program object, which can't be imported without parse()).
    if (cmd === 'cortextos') {
      if (tokens[1] !== 'bus') continue;
      cmd = tokens[2];
    }
    // A bus command is a lowercase, hyphenated verb token. This naturally
    // excludes env-var rows (UPPER_CASE) and prose cells.
    if (!cmd || !/^[a-z][a-z0-9-]+$/.test(cmd)) continue;
    const flags = cell.match(/--[a-z][a-z0-9-]+/g) ?? [];
    out.push({ file: rel, cmd, flags: [...new Set(flags)], raw: cell });
  }
  return out;
}

function findToolsMd(): string[] {
  const out: string[] = [];
  const roots = [join(ROOT, 'templates'), join(ROOT, 'community', 'agents')];
  for (const r of roots) {
    if (!existsSync(r)) continue;
    for (const name of readdirSync(r)) {
      const p = join(r, name, 'TOOLS.md');
      if (existsSync(p) && statSync(p).isFile()) out.push(p);
    }
  }
  return out;
}

const toolsFiles = findToolsMd();
const documented = toolsFiles.flatMap(parseToolsMd);

describe('TOOLS.md ↔ CLI contract (no doc-drift)', () => {
  it('finds TOOLS.md files and the CLI registers bus commands', () => {
    // 10 TOOLS.md ship today (5 templates + 5 community agents); tolerate one
    // lacking a Command Index, but catch accidental scan-perimeter shrinkage.
    expect(toolsFiles.length).toBeGreaterThanOrEqual(9);
    expect(cliCommands.size).toBeGreaterThanOrEqual(10);
    expect(documented.length).toBeGreaterThanOrEqual(20);
  });

  it('every documented command exists as a real CLI bus command', () => {
    const drift = documented
      .filter((d) => !cliCommands.has(d.cmd))
      .map((d) => `${d.file}: \`${d.cmd}\` is documented but not a registered \`cortextos bus\` command`);
    expect(drift, drift.join('\n')).toEqual([]);
  });

  it('every documented --flag exists on its command (or is a bus-global flag)', () => {
    const drift: string[] = [];
    for (const d of documented) {
      const cmdFlags = cliCommands.get(d.cmd);
      if (!cmdFlags) continue; // command-existence covered by the test above
      for (const f of d.flags) {
        if (!cmdFlags.has(f) && !globalFlags.has(f)) {
          drift.push(`${d.file}: \`${d.cmd} ${f}\` — flag documented but not registered on the command`);
        }
      }
    }
    expect(drift, drift.join('\n')).toEqual([]);
  });
});
