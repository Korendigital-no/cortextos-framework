/**
 * hook-action-gate.ts — PreToolUse hook (Surface B of the approval action-gate).
 *
 * The bus/CLI gate (Surface A, src/cli/bus.ts gateBusAction) only sees actions taken
 * THROUGH our own code. The highest-impact actions are raw tool calls that never touch
 * the CLI: `Bash: curl … api.resend.com`, `Bash: git push --force`, a `Write` to
 * `.claude/settings.json`, a `MultiEdit` to `config.json`. Agents run with
 * `--dangerously-skip-permissions`, so an injected instruction executes these with no
 * gate. SEC-INJECTION-v1 §3 names exactly this: untrusted content must not drive a
 * side-effect. This hook closes the tool-call surface.
 *
 * It maps a tool call to an ActionDescriptor, calls evaluateGate() IN-PROCESS (the SAME
 * shared core as Surface A — they cannot drift), logs payload-free telemetry, and BLOCKS
 * on a deny by emitting `permissionDecision:"deny"` (STEP-0 verified to block under
 * --dangerously-skip-permissions on claude 2.1.177; corroborated by the current Claude
 * Code hooks docs). Ships behind `action_gate_mode` (off/shadow/enforce) — shadow = zero
 * blocks.
 *
 * Safety posture (codex plan-review folded):
 *  - **fail-OPEN by default, fail-CLOSED on a positive catastrophic match.** A crashing or
 *    mis-configured gate must never wedge the fleet (failure-mode B). But a throw OUTSIDE
 *    the total core (stdin parse, env resolution, module load) must not silently allow a
 *    catastrophic action — so on any such throw we best-effort classify the
 *    (env-INDEPENDENT) descriptor and fail CLOSED only on a positive catastrophic match.
 *  - **env-trust is the honest Phase-1 limit.** The descriptor classification is
 *    env-independent (it reads the tool_input). But the gate MODE + owner anchor come from
 *    the env-derived frameworkRoot config — an agent that mispoints CTX_FRAMEWORK_ROOT /
 *    CTX_ORG can force the gate to "unconfigured ⇒ shadow". We narrow that by gating
 *    `.cortextos-env` writes (action-patterns config-change) and emitting `gate_unconfigured`
 *    telemetry; FULL closure is Phase-2 process isolation. This hook does NOT claim to
 *    close MODE env-spoofing.
 *  - **stdout is JSON-only.** The block object is written with `fs.writeSync(1, …)` (a
 *    buffered `process.stdout.write` can be truncated by `process.exit`); telemetry goes to
 *    the event file, never stdout; the detached notify child uses `stdio:'ignore'`.
 */

import { existsSync, writeSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { readStdin, parseHookInput } from './index.js';
import { resolveEnv } from '../utils/env.js';
import { resolvePaths } from '../utils/paths.js';
import { logEvent } from '../bus/event.js';
import {
  evaluateGate,
  classifyAction,
  type ActionDescriptor,
  type GateDecision,
  type GateInput,
} from '../security/action-gate.js';
import { gateEventName, gateSeverity, gateMeta, shouldLogGate } from '../security/gate-telemetry.js';

/** Include a tool_input field only when it is a usable string. */
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Map a Claude Code tool call to an ActionDescriptor, or null (safe ⇒ allow).
 *
 * PURE + NO-THROW (P2-4): a malformed tool_input must degrade to a descriptor or null,
 * never an exception — the exception path is the dangerous one (it would skip the gate).
 *
 * Every file-MUTATING tool is mapped so none bypasses the config-change gate (P1-1):
 * Write, Edit, MultiEdit, NotebookEdit. Classification of write/edit is by PATH
 * (isConfigChangePath); `content` only binds the approval fingerprint to a payload.
 * Bash is the command string (classified by action-patterns). Everything else
 * (WebFetch/Read/Grep/Glob/WebSearch/unknown) ⇒ null ⇒ allow.
 */
export function toDescriptor(toolName: string, toolInput: unknown): ActionDescriptor | null {
  const ti = (toolInput ?? {}) as Record<string, unknown>;
  switch (toolName) {
    case 'Bash': {
      const command = str(ti.command);
      return command ? { kind: 'bash', command } : null;
    }
    case 'Write': {
      const path = str(ti.file_path);
      return path ? { kind: 'write', path, content: str(ti.content) } : null;
    }
    case 'Edit': {
      const path = str(ti.file_path);
      return path ? { kind: 'edit', path, content: str(ti.new_string) } : null;
    }
    case 'MultiEdit': {
      // {file_path, edits:[{old_string,new_string,…}]}. Classify by file_path; bind the
      // concatenated new_strings as content. Missing/!array edits ⇒ content undefined.
      const path = str(ti.file_path);
      if (!path) return null;
      let content: string | undefined;
      if (Array.isArray(ti.edits)) {
        content = ti.edits
          .map(e => (e && typeof e === 'object' ? str((e as Record<string, unknown>).new_string) : undefined))
          .filter((s): s is string => s !== undefined)
          .join('\n') || undefined;
      }
      return { kind: 'edit', path, content };
    }
    case 'NotebookEdit': {
      // {notebook_path, new_source, …} writes a notebook file.
      const path = str(ti.notebook_path);
      return path ? { kind: 'edit', path, content: str(ti.new_source) } : null;
    }
    default:
      return null; // WebFetch/Read/Grep/Glob/WebSearch/unknown ⇒ allow (fast)
  }
}

export interface HookOutcome {
  block: boolean;
  reason?: string;
  notifyId?: string;
  /** The decision behind the outcome — telemetry is derived from it. */
  decision: GateDecision;
}

/**
 * PURE decision: run the shared core, project to a HookOutcome. No I/O, no exit — the
 * I/O orchestration lives in main(). evaluateGate is TOTAL and already encapsulates
 * off/shadow/enforce (shadow ⇒ allow:true; enforce-block ⇒ allow:false + notify;
 * catastrophic error ⇒ allow:false + error), so the hook only respects `decision.allow`.
 */
export function decideHook(descriptor: ActionDescriptor, gateInput: GateInput): HookOutcome {
  const decision = evaluateGate(gateInput);
  return {
    block: !decision.allow,
    reason: decision.reason,
    notifyId: decision.notify?.approvalId,
    decision,
  };
}

/**
 * Hook-boundary failsafe for throws OUTSIDE the total core (env resolution / paths /
 * module load) and for missing context. Best-effort classify the descriptor with NO
 * env (ownerChatIds undefined ⇒ owner channel never frozen). A POSITIVE catastrophic
 * match fails CLOSED; everything else (incl. classify throwing) fails OPEN. Mirrors
 * evaluateGate's errorDecision, applied where the core could not run.
 */
export function failsafeOutcome(descriptor: ActionDescriptor, stage: string): HookOutcome {
  let decision: GateDecision;
  try {
    const c = classifyAction(descriptor, { ownerChatIds: undefined });
    decision = c.category && c.catastrophic
      ? { allow: false, error: true, category: c.category, reason: `gate error (${stage}); catastrophic action fail-closed` }
      : { allow: true, error: true, category: c.category ?? undefined, reason: `gate error (${stage}); fail-open` };
  } catch {
    decision = { allow: true, error: true, reason: `gate error (${stage}, classify-threw); fail-open` };
  }
  return { block: !decision.allow, reason: decision.reason, decision };
}

/** dist/hooks/hook-action-gate.js → dist/cli.js (the bus CLI entry). */
function cliJsPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');
}

/**
 * Fire the human notify out-of-band. The hook must answer within its ≤5s timeout, so it
 * NEVER awaits the network — it spawns a fully detached, unref'd child that owns the
 * Telegram/activity I/O, then returns to emit the block. stdio:'ignore' so the child can
 * neither corrupt the JSON-only stdout nor keep the hook plumbing open. Only fires in
 * ENFORCE (shadow produces no `notify`). The approval row is already written by
 * evaluateGate, so this is notify-ONLY (no double-write). Best-effort: a spawn failure
 * still leaves the row on the dashboard.
 */
function spawnDetachedNotify(approvalId: string): void {
  try {
    const child = spawn(process.execPath, [cliJsPath(), 'bus', 'notify-approval-created', approvalId], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch {
    /* best-effort — the pending approval row is already persisted */
  }
}

/** Emit the verified deny schema as JSON-ONLY stdout (sync write) and exit 0. */
function emitBlock(reason?: string): never {
  const block = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason ?? 'blocked: this action requires approval',
    },
  };
  try {
    writeSync(1, JSON.stringify(block) + '\n');
  } catch {
    /* if even the sync write fails, exit 0 below = allow (never-freeze) */
  }
  process.exit(0);
}

function allow(): never {
  process.exit(0);
}

/**
 * Visibility: an env-spoof to a config-less frameworkRoot makes the gate "unconfigured
 * ⇒ shadow". Emit a trace (mirror Surface A's gate_unconfigured) so it is not silent.
 */
function maybeLogUnconfigured(
  paths: ReturnType<typeof resolvePaths>,
  org: string,
  agent: string,
  frameworkRoot: string,
  kind: string,
): void {
  try {
    if (!existsSync(join(frameworkRoot, 'orgs', org, 'context.json'))) {
      logEvent(paths, agent, org, 'action', 'gate_unconfigured', 'warning',
        JSON.stringify({ kind, framework_root: frameworkRoot, surface: 'tool-hook' }));
    }
  } catch {
    /* best-effort telemetry */
  }
}

async function main(): Promise<void> {
  // 1) Parse + descriptor — NO-THROW. If we cannot even derive a descriptor, allow.
  let descriptor: ActionDescriptor | null = null;
  try {
    const { tool_name, tool_input } = parseHookInput(await readStdin());
    descriptor = toDescriptor(tool_name, tool_input);
  } catch {
    return allow(); // unparsable input ⇒ nothing to gate
  }
  if (!descriptor) return allow(); // safe tool ⇒ allow fast

  // 2) Resolve env + run the gate. ANY throw OUTSIDE the total core ⇒ hook-boundary
  //    failsafe (catastrophic ⇒ block, else allow).
  let outcome: HookOutcome;
  let paths: ReturnType<typeof resolvePaths> | null = null;
  let agent = '';
  let org = '';
  try {
    const env = resolveEnv();
    agent = env.agentName;
    org = env.org;
    if (env.org && env.agentName && env.frameworkRoot) {
      paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);
      maybeLogUnconfigured(paths, env.org, env.agentName, env.frameworkRoot, descriptor.kind);
      outcome = decideHook(descriptor, {
        paths, frameworkRoot: env.frameworkRoot, org: env.org, agent: env.agentName, descriptor,
      });
    } else {
      outcome = failsafeOutcome(descriptor, 'missing-context'); // can't gate ⇒ failsafe
    }
  } catch {
    outcome = failsafeOutcome(descriptor, 'hook-exception');
  }

  // 3) Telemetry — payload-free, best-effort, never on stdout. Only when paths resolved.
  if (paths && agent && org && shouldLogGate(outcome.decision)) {
    try {
      logEvent(paths, agent, org, 'action',
        gateEventName(outcome.decision), gateSeverity(outcome.decision),
        gateMeta(descriptor.kind, outcome.decision));
    } catch {
      /* telemetry is best-effort */
    }
  }

  // 4) Block or allow. Spawn the detached notify BEFORE emitBlock (exit kills code after).
  if (outcome.block) {
    if (outcome.notifyId) spawnDetachedNotify(outcome.notifyId);
    return emitBlock(outcome.reason);
  }
  return allow();
}

// Run ONLY as the CLI entry point. Importing this module (tests) must not read stdin or
// exit — the proven loop-detector pattern runs main() unconditionally, which only avoids
// trouble because stdin never ends in tests; guarding on argv[1] is strictly safer.
const entry = process.argv[1] ?? '';
if (/hook-action-gate(\.[cm]?[jt]s)?$/.test(entry)) {
  main().catch(() => process.exit(0)); // last-resort fail-OPEN on any uncaught error
}
