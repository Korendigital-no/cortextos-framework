/**
 * policy.ts — resolve the approval policy and the action-gate enforcement config
 * for the gate. Read-only fs; NO network.
 *
 * Two trust tiers (the #1↔#8 interlock):
 *  - **Enforcement mode + owner-chat anchor** come from the TRUSTED org
 *    `context.json` (`action_gate_mode`, `action_gate_enforce`,
 *    `owner_telegram_chat_ids`) — NOT agent-owned config, so the mode itself and
 *    the owner exemption cannot be self-disabled by an injected `config.json` edit.
 *  - **always_ask / never_ask** reuse the existing resolution (org default →
 *    agent `config.json` override). Honoring the agent override is safe ONLY
 *    because writes to `config.json` are `config-change`-gated — an injected agent
 *    cannot add `never_ask` without first tripping the gate.
 *
 * CRITICAL: these resolvers **throw** on a corrupt/unreadable config (unlike the
 * display-tolerant get-config CLI, which warns and falls back). A gate that
 * silently fell back to permissive defaults on a corrupt config would BE the
 * bypass (corrupt config → permissive → action allowed). The throw drives
 * evaluateGate's fail-open/closed error path instead — where the catastrophic
 * subset fails CLOSED.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { stripBom } from '../utils/strip-bom.js';
import type { ApprovalCategory } from '../types/index.js';

/** Categories gated by default when an org context has no explicit list. */
export const DEFAULT_GATED_CATEGORIES: ApprovalCategory[] = [
  'external-comms', 'financial', 'deployment', 'data-deletion', 'config-change',
];

export interface ApprovalPolicy {
  always_ask: string[];
  never_ask: string[];
}

export interface ActionGateConfig {
  mode: 'off' | 'shadow' | 'enforce';
  enforce: ApprovalCategory[];
  /**
   * Trusted owner Telegram chat ids (control-channel exemption anchor).
   * `undefined` ⇒ owner-ness is UNDETERMINABLE (no owners configured) ⇒ telegram
   * sends classify ALLOW (never freeze the owner channel). NEVER `[]` — an empty
   * array would mean "every send is non-owner", freezing the operator path on an
   * unconfigured org (the exact prod-edge that would bite at enforce flip).
   */
  ownerChatIds?: string[];
}

function readJson(path: string): Record<string, unknown> {
  // Throws on parse failure — deliberate (see module header). Missing file is a
  // clean empty object (a not-yet-configured org is "no gating", not "corrupt").
  if (!existsSync(path)) return {};
  return JSON.parse(stripBom(readFileSync(path, 'utf-8')));
}

/**
 * Resolve the approval policy (always_ask / never_ask) for an agent.
 * org `context.json` default_approval_categories → agent `config.json`
 * approval_rules (agent wins). Mirrors src/cli/get-config.ts resolution, but
 * THROWS on corrupt config so the gate fails safe rather than permissive.
 */
export function resolveApprovalPolicy(
  frameworkRoot: string,
  org: string,
  agentName?: string,
): ApprovalPolicy {
  const orgCtx = readJson(join(frameworkRoot, 'orgs', org, 'context.json'));
  const defaults = Array.isArray(orgCtx.default_approval_categories)
    ? (orgCtx.default_approval_categories as string[])
    : DEFAULT_GATED_CATEGORIES;

  if (agentName) {
    const agentCfg = readJson(join(frameworkRoot, 'orgs', org, 'agents', agentName, 'config.json'));
    const rules = agentCfg.approval_rules as { always_ask?: unknown; never_ask?: unknown } | undefined;
    if (rules && Array.isArray(rules.always_ask)) {
      return {
        always_ask: rules.always_ask as string[],
        never_ask: Array.isArray(rules.never_ask) ? (rules.never_ask as string[]) : [],
      };
    }
  }
  return { always_ask: defaults, never_ask: [] };
}

/**
 * Resolve the action-gate enforcement config from the TRUSTED org context.
 * Throws on a corrupt context.json → evaluateGate error path (owner list then
 * unresolved ⇒ owner channel never frozen). A MISSING context is a clean
 * "unconfigured ⇒ shadow / no owners", not an error.
 */
export function resolveActionGateConfig(frameworkRoot: string, org: string): ActionGateConfig {
  const ctx = readJson(join(frameworkRoot, 'orgs', org, 'context.json'));
  const rawMode = ctx.action_gate_mode;
  const mode: ActionGateConfig['mode'] =
    rawMode === 'off' || rawMode === 'enforce' ? rawMode : 'shadow';
  const rawEnforce = Array.isArray(ctx.action_gate_enforce)
    ? (ctx.action_gate_enforce as ApprovalCategory[])
    : [];
  // The #1↔#8 interlock requires config-change to be enforced whenever ANY
  // category is enforced — otherwise an agent could trip a block, then resolve
  // its own approval through an UN-enforced config-change (the approval resolver
  // would be the one unprotected category). Force it in when enforcing.
  const enforce = mode === 'enforce'
    ? Array.from(new Set<ApprovalCategory>([...rawEnforce, 'config-change']))
    : rawEnforce;
  // Unconfigured/empty owner list ⇒ undefined (undeterminable ⇒ never freeze),
  // NEVER [] (which would make every send a non-owner send → freeze at enforce).
  const ownerChatIds = Array.isArray(ctx.owner_telegram_chat_ids) && ctx.owner_telegram_chat_ids.length > 0
    ? (ctx.owner_telegram_chat_ids as unknown[]).map(String)
    : undefined;
  return { mode, enforce, ownerChatIds };
}
