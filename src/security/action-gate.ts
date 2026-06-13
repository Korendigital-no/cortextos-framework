/**
 * action-gate.ts — THE shared decision core for the approval gate.
 *
 * One classifier + one policy loader + one approval lookup, consumed by BOTH
 * enforcement surfaces: Surface A (bus/CLI — src/cli/bus.ts) and Surface B (the
 * PreToolUse hook — src/hooks/hook-action-gate.ts, Doc 3). Fix a rule once, both
 * surfaces inherit it; they cannot drift apart (SEC-INJECTION-v1 §3).
 *
 * Cross-cutting safety (fail-safe WITHOUT freezing the fleet — failure-mode-B
 * avoidance, mike doctrine):
 *  - conservative classifier: unknown action ⇒ null ⇒ allow + log.
 *  - staged rollout: off / shadow (log would-block, allow) before enforce.
 *  - owner control channel exempt + ALWAYS fail-open (the only operator-alert and
 *    approval-request path — a gate bug must never freeze it).
 *  - evaluateGate is TOTAL (never throws): on any internal error it fails OPEN,
 *    EXCEPT a positive `catastrophic` match (irreversible delete / money /
 *    non-owner external-send) fails CLOSED. This is co-dependent with the
 *    config-change gating of trust anchors (#1↔#8 interlock): fail-open is only
 *    safe because an agent cannot corrupt its own policy config without first
 *    tripping the config-change gate.
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync, statSync } from 'fs';
import type { ApprovalCategory, BusPaths } from '../types/index.js';
import {
  ALLOW,
  classifyBash,
  isConfigChangePath,
  type ClassifyResult,
} from './action-patterns.js';
import {
  resolveActionGateConfig,
  resolveApprovalPolicy,
  type ActionGateConfig,
  type ApprovalPolicy,
} from './policy.js';
import { findApproval, consumeApproval, writePendingApproval } from './approval-store.js';

// --- Action descriptors -----------------------------------------------------

export type ActionDescriptor =
  | { kind: 'telegram'; to: string; text: string; mediaType?: 'photo' | 'document' | null; filePath?: string }
  | { kind: 'bash'; command: string }
  // `content` (the bytes being written) binds the approval to a specific payload —
  // Doc 3's Write/Edit hook populates it so an approved benign write to a path
  // cannot be spent by a different payload to the same path (P2). Optional for
  // callers that only have the path.
  | { kind: 'write' | 'edit'; path: string; content?: string }
  | { kind: 'bus-command'; subcommand: string; detail?: string };

/**
 * High-impact bus subcommands that route around the tool surface but still need
 * gating (P2-8). update-approval is config-change (an agent resolving its OWN
 * approval is the manufacture vector, #1); CRM hard-deletes are data-deletion.
 */
const BUS_SUBCOMMAND_CATEGORY: Record<string, { category: ApprovalCategory; catastrophic: boolean }> = {
  // update-approval is config-change AND catastrophic: resolving an approval on a
  // gate error must fail CLOSED (never let a manufacture slip — the #1↔#8 interlock).
  'update-approval': { category: 'config-change', catastrophic: true },
  'delete-contact': { category: 'data-deletion', catastrophic: true },
  'delete-company': { category: 'data-deletion', catastrophic: true },
  'delete-deal': { category: 'data-deletion', catastrophic: true },
  'delete-document': { category: 'data-deletion', catastrophic: true },
  'delete-activity': { category: 'data-deletion', catastrophic: true },
  'delete-client': { category: 'data-deletion', catastrophic: true },
};

export interface ClassifyOptions {
  /** Trusted owner Telegram chat ids. `undefined` ⇒ owner-ness undeterminable. */
  ownerChatIds?: string[];
  scratchPrefixes?: string[];
}

/**
 * Map an action descriptor to a gated category (+ catastrophic flag) or ALLOW.
 * Conservative: only KNOWN-dangerous actions match; everything else is ALLOW.
 *
 * Owner carve-out (HARD invariant): a telegram to the owner ⇒ ALLOW always. When
 * `ownerChatIds` is undefined (owner list unresolvable), owner-ness cannot be
 * determined ⇒ ALLOW (unknown) — so an owner-list-resolution failure can NEVER
 * freeze the owner channel; only a POSITIVE non-owner match fails closed.
 */
export function classifyAction(d: ActionDescriptor, opts: ClassifyOptions = {}): ClassifyResult {
  switch (d.kind) {
    case 'telegram': {
      const owners = opts.ownerChatIds;
      if (owners === undefined) return ALLOW; // owner-ness undeterminable ⇒ never freeze
      if (owners.includes(String(d.to))) return ALLOW; // owner control channel — exempt
      // Non-owner send. Media-bearing or text — both are exfiltration vectors.
      return { category: 'external-comms', catastrophic: true, label: 'telegram-nonowner' };
    }
    case 'bash':
      return classifyBash(d.command, { scratchPrefixes: opts.scratchPrefixes, ownerChatIds: opts.ownerChatIds });
    case 'write':
    case 'edit':
      // config-change is catastrophic (fail-CLOSED on gate error): a corrupt
      // config must not let a trust-anchor write (policy / approvals / owner-chat)
      // slip via fail-open — the #1↔#8 interlock.
      return isConfigChangePath(d.path)
        ? { category: 'config-change', catastrophic: true, label: `${d.kind}-config` }
        : ALLOW;
    case 'bus-command': {
      const hit = BUS_SUBCOMMAND_CATEGORY[d.subcommand];
      return hit ? { category: hit.category, catastrophic: hit.catastrophic, label: `bus-${d.subcommand}` } : ALLOW;
    }
    default:
      return ALLOW;
  }
}

// --- Fingerprint ------------------------------------------------------------

function sha256(s: string | Buffer): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Hash a file's content; fall back to a size+mtime stat tag if unreadable. */
function fileTag(filePath: string): string {
  try {
    return 'h:' + sha256(readFileSync(filePath));
  } catch {
    try {
      const st = statSync(filePath);
      return `s:${st.size}:${Math.floor(st.mtimeMs)}`;
    } catch {
      return 'missing';
    }
  }
}

function normalizeBash(command: string): string {
  return command
    .replace(/\s+/g, ' ')
    .replace(/\/(?:private\/)?tmp\/[^\s'"]+/g, '/tmp/<volatile>') // mask temp paths
    .replace(/\/var\/folders\/[^\s'"]+/g, '/var/folders/<volatile>')
    .replace(/\b\d{10,}\b/g, '<ts>')                              // epoch-ish timestamps
    .trim();
}

/**
 * Stable fingerprint binding an approval to a specific normalized action.
 * `sha256(category + "\n" + normalized(descriptor))`. The category is part of the
 * hash, so the same command under a different category fingerprints differently.
 * Media payloads (P1-3) are bound via transport kind + media type + file content
 * hash — an approved caption cannot authorize sending an arbitrary document.
 */
export function fingerprint(category: ApprovalCategory, d: ActionDescriptor): string {
  let norm: string;
  switch (d.kind) {
    case 'telegram':
      norm = [
        'telegram',
        d.to,
        d.mediaType ?? 'text',
        d.filePath ? fileTag(d.filePath) : '',
        sha256(d.text ?? ''),
      ].join('\n');
      break;
    case 'bash':
      norm = 'bash\n' + normalizeBash(d.command);
      break;
    case 'write':
    case 'edit':
      // bind the path AND the content hash (when present) so an approval for one
      // payload to a path cannot be spent by a different payload to the same path.
      norm = `${d.kind}\n${d.path}\n${d.content !== undefined ? sha256(d.content) : ''}`;
      break;
    case 'bus-command':
      norm = `bus\n${d.subcommand}\n${d.detail ?? ''}`;
      break;
    default:
      norm = 'unknown';
  }
  return sha256(category + '\n' + norm);
}

// --- The decision -----------------------------------------------------------

export interface GateDecision {
  allow: boolean;
  category?: ApprovalCategory;
  approvalId?: string;
  reason?: string;
  /** Category not gated for THIS agent (always_ask miss) — logged, allowed. */
  soft?: boolean;
  /** shadow mode: would have blocked, but allowed (observe-only). */
  shadow?: boolean;
  /** Gate-internal error path (fail-open, or fail-closed for catastrophic). */
  error?: boolean;
  /** When shadow/soft/error, the reason a real enforce would have used (telemetry). */
  wouldBlockReason?: string;
  /** Present on a fresh block: the caller (surface) fires the human notify. */
  notify?: { approvalId: string; category: ApprovalCategory; title: string };
}

export interface GateInput {
  paths: BusPaths;
  frameworkRoot: string;
  org: string;
  agent: string;
  descriptor: ActionDescriptor;
  /** Test/override hooks — bypass fs resolution. */
  configOverride?: ActionGateConfig;
  policyOverride?: ApprovalPolicy;
}

function shortTitle(d: ActionDescriptor): string {
  switch (d.kind) {
    case 'telegram': return `send-telegram to ${d.to}`;
    case 'bash': return `bash: ${d.command.slice(0, 80)}`;
    case 'write':
    case 'edit': return `${d.kind} ${d.path}`;
    case 'bus-command': return `bus ${d.subcommand}`;
    default: return 'action';
  }
}

/**
 * Best-effort classification used ONLY on the error path. Never throws. When the
 * owner list could not be resolved (config-load error), `ownerChatIds` is
 * undefined ⇒ telegram classifies ALLOW ⇒ a non-owner send cannot be proven ⇒
 * fail-open (the owner channel is never frozen by a resolution failure).
 */
function bestEffortClassify(d: ActionDescriptor, ownerChatIds: string[] | undefined): ClassifyResult {
  try {
    return classifyAction(d, { ownerChatIds });
  } catch {
    return ALLOW;
  }
}

/**
 * Error-path decision: fail OPEN, except a POSITIVE catastrophic match fails
 * CLOSED (irreversible delete / money / non-owner external-send). The catastrophic
 * subset must require a positive match — an unknown / undeterminable classification
 * fails open (never-freeze).
 */
function errorDecision(d: ActionDescriptor, ownerChatIds: string[] | undefined, stage: string): GateDecision {
  const c = bestEffortClassify(d, ownerChatIds);
  if (c.category && c.catastrophic) {
    return {
      allow: false,
      error: true,
      category: c.category,
      reason: `gate error (${stage}); catastrophic action fail-closed`,
    };
  }
  return {
    allow: true,
    error: true,
    reason: `gate error (${stage}); fail-open`,
    wouldBlockReason: c.category ? `${c.category} (non-catastrophic, fail-open on error)` : undefined,
  };
}

/**
 * The gate decision, shared by both surfaces. TOTAL — never throws.
 */
export function evaluateGate(input: GateInput): GateDecision {
  const { paths, frameworkRoot, org, agent, descriptor } = input;

  // 1) Resolve enforcement config (mode + enforce list + owner anchor) from the
  //    TRUSTED org context. A corrupt context.json ⇒ owner list UNRESOLVED ⇒
  //    error path with ownerChatIds=undefined (owner channel never frozen).
  let config: ActionGateConfig;
  try {
    config = input.configOverride ?? resolveActionGateConfig(frameworkRoot, org);
  } catch {
    return errorDecision(descriptor, undefined, 'config-load');
  }

  if (config.mode === 'off') return { allow: true };

  // 2) Classify.
  let classified: ClassifyResult;
  try {
    classified = classifyAction(descriptor, { ownerChatIds: config.ownerChatIds });
  } catch {
    return errorDecision(descriptor, config.ownerChatIds, 'classify');
  }
  if (!classified.category) return { allow: true }; // unknown / safe / owner ⇒ allow

  const category = classified.category;

  // 3) Resolve policy (always_ask / never_ask). A corrupt config THROWS here →
  //    error path. The catastrophic subset still fails CLOSED (the #1↔#8 interlock:
  //    a corrupt config cannot turn a catastrophic action into an allow).
  let policy: ApprovalPolicy;
  try {
    policy = input.policyOverride ?? resolveApprovalPolicy(frameworkRoot, org, agent);
  } catch {
    return errorDecision(descriptor, config.ownerChatIds, 'policy-load');
  }

  // config-change is the gate's SELF-PROTECTION anchor and is UN-WAIVABLE: it is
  // always gated regardless of the agent's MUTABLE approval_rules. Subjecting it
  // to agent policy would be circular — an injected agent could add
  // never_ask:['config-change'] (or ship old defaults that omit it from
  // always_ask) and then self-resolve / rewrite policy / forge an approval row.
  // Other categories consult the agent policy (safe because config.json writes are
  // themselves config-change-gated — the #1↔#8 interlock).
  if (category !== 'config-change') {
    if (policy.never_ask.includes(category)) return { allow: true };
    if (!policy.always_ask.includes(category)) {
      return { allow: true, soft: true, category, wouldBlockReason: `${category} not in always_ask` };
    }
  }

  // 4) Category IS gated for this agent → bind to an approval.
  let lookup: ReturnType<typeof findApproval>;
  let fp: string;
  try {
    fp = fingerprint(category, descriptor);
    lookup = findApproval(paths, org, agent, category, fp);
  } catch {
    return errorDecision(descriptor, config.ownerChatIds, 'approval-lookup');
  }

  if (lookup.state === 'approved' && lookup.id) {
    // Atomic single-use spend. Allow ONLY if we win the consume rename.
    if (consumeApproval(paths, lookup.id)) {
      return { allow: true, category, approvalId: lookup.id };
    }
    lookup = { state: 'none' }; // lost the race → fall through to block/create
  }

  // 5) Mode layer. enforce (this category) vs shadow/non-enforced (observe-only).
  // NOTE: a pending approval row is written ONLY when we are actually going to
  // block (enforce). In shadow the action proceeds, so an approval would be moot —
  // creating one would just flood the pending queue with un-actioned rows. Shadow
  // emits would-block telemetry (the caller logs the decision) but writes nothing.
  const enforced = config.mode === 'enforce' && config.enforce.includes(category);

  if (lookup.state === 'pending' && lookup.id) {
    const reason = `blocked: ${category} awaiting approval ${lookup.id}. Mark your task blocked; it runs after approval.`;
    return enforced
      ? { allow: false, category, approvalId: lookup.id, reason }
      : { allow: true, shadow: true, category, approvalId: lookup.id, wouldBlockReason: reason };
  }

  // lookup.state === 'none'
  if (!enforced) {
    return { allow: true, shadow: true, category, wouldBlockReason: `would block: ${category} requires approval` };
  }

  // enforce + no existing approval → create the pending row (sync) + block + notify.
  let id: string;
  try {
    id = writePendingApproval(paths, {
      agent, org, category,
      title: shortTitle(descriptor),
      description: `Auto-created by action-gate for: ${shortTitle(descriptor)}`,
      action_fingerprint: fp,
    });
  } catch {
    // Pending-write failed → no approval id. Non-catastrophic ⇒ fail-open
    // (never-freeze); catastrophic ⇒ fail-closed (a destructive op must not slip
    // on a write failure).
    return classified.catastrophic
      ? { allow: false, error: true, category, reason: `gate error (pending-write); catastrophic action fail-closed` }
      : { allow: true, error: true, category, reason: `gate error (pending-write); fail-open` };
  }
  return {
    allow: false,
    category,
    approvalId: id,
    reason: `blocked: ${category} requires approval; created ${id}. Mark your task blocked; it runs after approval.`,
    notify: { approvalId: id, category, title: shortTitle(descriptor) },
  };
}
