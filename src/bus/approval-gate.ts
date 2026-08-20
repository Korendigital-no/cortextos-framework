// Approval-gate classification + satisfaction logic (WS1 finding #4).
//
// SCAFFOLD — NOT WIRED. These are the two pure functions a PreToolUse hook
// would call to enforce `approval_rules.always_ask` in the HARNESS layer (where
// prompt injection cannot bypass it), instead of relying on the agent prompt.
// See deliverables/core-hardening-design-2026-06-10.md for the phased rollout
// (Phase 1 shadow-mode → Phase 2 enforce). This module changes no behavior
// until a hook imports it; it is deliberately side-effect-free and tested.

import type { Approval, ApprovalCategory } from '../types/index.js';

/**
 * Classify a shell command into an approval category, or null if it is not a
 * gated high-blast-radius action. CONSERVATIVE by design: an unrecognized
 * command returns null (do NOT block) — a too-broad classifier would freeze a
 * fleet that legitimately sends/commits a lot (failure-mode B). Only the
 * categories an org lists in `approval_rules.always_ask` are ever enforced.
 */
export function classifyCommand(command: string): ApprovalCategory | null {
  const cmd = command.trim();

  // data-deletion: destructive filesystem / database verbs.
  if (/\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/.test(cmd)) return 'data-deletion';
  if (/\bDROP\s+(TABLE|DATABASE)\b/i.test(cmd)) return 'data-deletion';

  // deployment: push to the default branch / platform deploy verbs.
  if (/\bgit\s+push\b[^\n]*\b(main|master)\b/.test(cmd)) return 'deployment';
  if (/\b(vercel|netlify|fly|wrangler)\s+deploy\b/.test(cmd)) return 'deployment';

  // external-comms: outbound Telegram to a human (not fleet agent-to-agent).
  if (/cortextos\s+bus\s+send-telegram\b/.test(cmd)) return 'external-comms';

  // financial: money-moving verbs (placeholder anchor — extend per integrations).
  if (/\bstripe\b[^\n]*\b(charge|payout|refund|transfer)\b/.test(cmd)) return 'financial';

  return null;
}

/**
 * Is there a resolved, approved approval that authorizes this action for this
 * agent and category, within a freshness window? Freshness (default 1h) +
 * the caller marking an approval consumed prevents replaying an old grant.
 *
 * @param now epoch ms (injected for deterministic testing)
 */
export function isApprovalSatisfied(
  category: ApprovalCategory,
  requestingAgent: string,
  approvals: readonly Approval[],
  now: number,
  maxAgeMs = 3_600_000,
): boolean {
  return approvals.some((a) => {
    if (a.status !== 'approved') return false;
    if (a.category !== category) return false;
    if (a.requesting_agent !== requestingAgent) return false;
    if (!a.resolved_at) return false;
    const resolvedMs = Date.parse(a.resolved_at);
    if (Number.isNaN(resolvedMs)) return false;
    return now - resolvedMs <= maxAgeMs && now >= resolvedMs;
  });
}
