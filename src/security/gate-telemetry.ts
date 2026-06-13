/**
 * gate-telemetry.ts — the single source of truth for action-gate telemetry shape.
 *
 * Both enforcement surfaces emit identical structured gate events: Surface A
 * (bus/CLI — src/cli/bus.ts gateBusAction) and Surface B (the PreToolUse hook —
 * src/hooks/hook-action-gate.ts). Keeping the event-name / severity / meta logic in
 * ONE place means the two surfaces cannot drift apart in what they report.
 *
 * SEC-INJECTION-v1 §9 (HARD): the meta payload carries ONLY classification facts
 * (kind / category / approval_id / allow). It NEVER includes the action payload —
 * the bash command, the file content, the telegram text, a path. A log line that
 * embedded attacker-controlled bytes would itself become an injection sink. These
 * helpers are pure (no fs, no network, no logEvent) so the no-payload invariant is
 * unit-testable in isolation.
 */

import type { EventSeverity } from '../types/index.js';
import type { GateDecision } from './action-gate.js';

/**
 * Whether a decision is worth logging at all. The boring allow case (no category
 * matched, not shadow/soft/error) is skipped to avoid flooding the activity feed on
 * every safe / owner-channel action — matches gateBusAction's original guard.
 */
export function shouldLogGate(decision: GateDecision): boolean {
  return Boolean(decision.category) || !decision.allow || Boolean(decision.error);
}

/**
 * Canonical event name for a gate decision. Mirrors the original gateBusAction
 * mapping exactly:
 *  - blocked + error   ⇒ gate_error
 *  - blocked           ⇒ gate_block
 *  - allowed + shadow  ⇒ gate_shadow_would_block
 *  - allowed + soft    ⇒ gate_soft_allow
 *  - allowed + error   ⇒ gate_error   (fail-open-on-error path)
 *  - allowed           ⇒ gate_allow
 */
export function gateEventName(decision: GateDecision): string {
  if (!decision.allow) return decision.error ? 'gate_error' : 'gate_block';
  if (decision.shadow) return 'gate_shadow_would_block';
  if (decision.soft) return 'gate_soft_allow';
  if (decision.error) return 'gate_error';
  return 'gate_allow';
}

/** critical only for a fail-CLOSED catastrophic error (blocked + error); else info. */
export function gateSeverity(decision: GateDecision): EventSeverity {
  return !decision.allow && decision.error ? 'critical' : 'info';
}

/**
 * Payload-free meta JSON. The four facts a reviewer needs, and NOTHING the attacker
 * controlled. `kind` is the descriptor kind (bash/write/edit/telegram/bus-command) —
 * a fixed enum, never free text.
 */
export function gateMeta(kind: string, decision: GateDecision): string {
  return JSON.stringify({
    kind,
    category: decision.category ?? null,
    approval_id: decision.approvalId ?? null,
    allow: decision.allow,
  });
}
