/**
 * action-patterns.ts — the versioned deny-list for the approval action-gate.
 *
 * SEC-INJECTION-v1 §3: this is a DENY-LIST of *known-dangerous* actions, never an
 * allow-list of safe ones. **Unknown ⇒ null ⇒ allow + log** (fleet-liveness /
 * failure-mode-B avoidance: a classifier that blocked the unknown would wedge the
 * whole fleet on the first unrecognised command).
 *
 * Honest limit (Doc 3 §7): this is best-effort, defense-in-depth string matching,
 * NOT a sandbox. A cleverly obfuscated `rm` (env-var indirection, base64-pipe,
 * `bash -c "$(...)"`) can evade a shallow match. The real containment is Phase-2
 * process isolation; here we lean on shadow-mode telemetry to find evasions and
 * grow the deny-list by PR (each new pattern with a test) — monotonically, without
 * ever defaulting-closed.
 *
 * `catastrophic` marks the irreversible subset that fails CLOSED on a gate-internal
 * error/timeout (mike 2026-06-13): irreversible delete (mass/non-scratch + prod
 * data), money transfer, and external-send to a NON-owner. Everything else, and all
 * unknowns, fail OPEN. (external-comms is catastrophic only for non-owner sends —
 * the owner control channel is exempt entirely; see action-gate classifyAction.)
 */

import type { ApprovalCategory } from '../types/index.js';

export interface ClassifyResult {
  /** The gated category, or null for "safe / unknown ⇒ allow + log". */
  category: ApprovalCategory | null;
  /** When true, fail CLOSED on a gate-internal error (irreversible subset). */
  catastrophic: boolean;
  /** Human-readable label of the matched pattern (for telemetry; never the payload). */
  label?: string;
}

export const ALLOW: ClassifyResult = { category: null, catastrophic: false };

/**
 * Default scratch path prefixes that `rm` is allowed to delete without gating.
 * A delete confined to one of these is `null` (allow); anything else is
 * data-deletion. Kept deliberately small and unambiguous.
 */
export const DEFAULT_SCRATCH_PREFIXES = ['/tmp/', '/private/tmp/', '/var/folders/', './tmp/', 'tmp/'];

/**
 * Path globs (substring/suffix tests) that mark a Write/Edit target as a
 * `config-change` — the SEC-INJECTION-v1 §3 persistence + privilege-escalation
 * vector AND the gate's own trust anchors (so an agent cannot degrade its own
 * policy / forge an approval row / repoint the owner-chat anchor without tripping
 * this gate — the #1↔#8 interlock). Ordinary code writes on a feature branch are
 * NOT here → they classify null (allow).
 */
export function isConfigChangePath(targetPath: string): boolean {
  const p = targetPath.replace(/\\/g, '/');
  const base = p.split('/').pop() || '';
  // Secrets / env
  if (base === '.env' || base.startsWith('.env.') || base === 'secrets.env') return true;
  // Claude Code settings (auto-approved within an agent's own .claude/ by
  // hook-permission-telegram — exactly why settings writes must be gated here).
  if (/\.claude\/settings[^/]*\.json$/.test(p)) return true;
  // Agent runtime config / crons / bootstrap identity & policy files
  if (base === 'config.json' || base === 'crons.json' || base === 'context.json') return true;
  if (base === 'enabled-agents.json') return true;
  // Bootstrap / identity / policy markdown an injection would target to escalate
  if (/(^|\/)(GUARDRAILS|IDENTITY|SOUL|GOALS|SYSTEM|USER|AGENTS)\.md$/.test(p)) return true;
  // The gate's own approval rows (forging a resolved/approved row = manufacture).
  if (/\/approvals\/(pending|resolved)\//.test(p)) return true;
  return false;
}

/** True if a path is confined to an allowlisted scratch prefix (delete is safe). */
export function isScratchPath(targetPath: string, scratchPrefixes: string[] = DEFAULT_SCRATCH_PREFIXES): boolean {
  const p = targetPath.trim();
  return scratchPrefixes.some(prefix => p === prefix || p.startsWith(prefix));
}

/**
 * Known external *send* endpoints (exfiltration / external-comms vector). A POST
 * of data to one of these is external-comms. Telegram is handled specially by the
 * caller (owner chat-id → exempt); the others are unconditionally external.
 */
const SEND_ENDPOINT_HOSTS = [
  'api.resend.com',
  'api.sendgrid.com',
  'api.mailgun.net',
  'api.twilio.com',
  'graph.facebook.com',
  'api.linkedin.com',
  'slack.com/api',
  'hooks.slack.com',
  'discord.com/api',
  'api.openai.com', // data egress to a third party
];

/** Telegram Bot API host — owner vs non-owner decided by the caller from chat_id. */
export const TELEGRAM_API_HOST = 'api.telegram.org';

/** Money-moving / spend-incurring endpoints (financial). */
const FINANCIAL_HOSTS = [
  'api.stripe.com',
  'connect.stripe.com',
];

/**
 * Split a Bash command line into shallow sub-commands on `;`, `&&`, `||`, `|`, and
 * newlines. Per SEC-INJECTION-v1 §6 the command string is UNTRUSTED data — we only
 * pattern-match it, never eval or interpolate it. This is intentionally shallow
 * (argv[0] + flags per segment); see the module header on the honest limit.
 */
export function splitBashSubcommands(command: string): string[] {
  return command
    .split(/\n|;|&&|\|\||\|/g)
    .map(s => s.trim())
    .filter(Boolean);
}

/** Extract a Telegram chat_id from a curl/wget command, if present. */
export function extractTelegramChatId(sub: string): string | null {
  // chat_id=<id>  (query / form) or "chat_id":"<id>" / "chat_id": <id> (json)
  const m = sub.match(/chat_id["']?\s*[:=]\s*["']?(-?\d+)/);
  return m ? m[1] : null;
}

export interface BashClassifyOptions {
  scratchPrefixes?: string[];
  /** Owner Telegram chat ids — a telegram-API curl to one of these is exempt
   * (null). `undefined` ⇒ owner-ness undeterminable ⇒ allow (never freeze). */
  ownerChatIds?: string[];
}

/** Strip one surrounding layer of single/double quotes from a shell token. */
function stripQuotes(token: string): string {
  return token.replace(/^["']/, '').replace(/["']$/, '');
}

/**
 * Classify a SINGLE Bash sub-command. Returns the gated category (with catastrophic
 * flag) or ALLOW. First-principles: only KNOWN-dangerous verbs match; everything
 * else is ALLOW.
 */
export function classifyBashSubcommand(sub: string, opts: BashClassifyOptions = {}): ClassifyResult {
  const s = sub.trim();
  if (!s) return ALLOW;
  const lower = s.toLowerCase();

  // --- data-deletion (catastrophic: irreversible) ---
  // rm with a recursive/force flag — short (-rf/-r/-f/-R/-d, in any combination)
  // OR long (--recursive/--force/--dir) — against a NON-scratch operand. Operand
  // quoting is stripped before the scratch check (`rm -rf "config.json"` evades a
  // naive matcher otherwise).
  const rmm = s.match(/\brm\b\s+(.*)$/i);
  if (rmm) {
    const tokens = rmm[1].split(/\s+/).filter(Boolean);
    const destructive = tokens.some(t =>
      /^-[a-zA-Z]*[rRfd]/.test(t) || t === '--recursive' || t === '--force' || t === '--dir');
    if (destructive) {
      const operands = tokens.filter(t => !t.startsWith('-')).map(stripQuotes);
      const allScratch = operands.length > 0 && operands.every(op => isScratchPath(op, opts.scratchPrefixes));
      if (!allScratch) return { category: 'data-deletion', catastrophic: true, label: 'rm-recursive-nonscratch' };
      return ALLOW; // scratch-only delete
    }
  }
  if (/\bgit\s+push\b/.test(lower) && /(--force\b|--force-with-lease|-f\b)/.test(lower)) {
    return { category: 'data-deletion', catastrophic: true, label: 'git-push-force' };
  }
  if (/\bdrop\s+(table|database|schema)\b/i.test(s)) {
    return { category: 'data-deletion', catastrophic: true, label: 'sql-drop' };
  }
  if (/\bdelete\s+from\b/i.test(s) && !/\bwhere\b/i.test(s)) {
    return { category: 'data-deletion', catastrophic: true, label: 'sql-delete-no-where' };
  }
  if (/\btruncate\s+(table\b|\w)/i.test(s)) {
    return { category: 'data-deletion', catastrophic: true, label: 'sql-truncate' };
  }

  // --- external-comms / financial (host checks are CASE-INSENSITIVE — hosts are
  // lowercase, so an UPPERCASE url like API.STRIPE.COM must not evade) ---
  if (/\b(curl|wget|http|https|fetch)\b/.test(lower)) {
    if (lower.includes(TELEGRAM_API_HOST)) {
      const chatId = extractTelegramChatId(s);
      const owners = opts.ownerChatIds;
      // Owner-ness undeterminable (no owner list) → ALLOW (never freeze the owner
      // channel on an unresolvable owner list; see action-gate owner carve-out).
      if (owners === undefined) return ALLOW;
      if (chatId !== null && owners.includes(chatId)) return ALLOW; // owner — exempt
      return { category: 'external-comms', catastrophic: true, label: 'telegram-nonowner' };
    }
    if (FINANCIAL_HOSTS.some(h => lower.includes(h))) {
      return { category: 'financial', catastrophic: true, label: 'financial-endpoint' };
    }
    if (SEND_ENDPOINT_HOSTS.some(h => lower.includes(h))) {
      return { category: 'external-comms', catastrophic: true, label: 'external-send-endpoint' };
    }
  }

  // --- our own CLI: `cortextos bus send-telegram <chat> …` to a NON-owner ---
  const stMatch = s.match(/\bbus\s+send-telegram\s+(-?\d+)/);
  if (stMatch) {
    const owners = opts.ownerChatIds;
    if (owners === undefined) return ALLOW;          // undeterminable ⇒ never freeze
    if (owners.includes(stMatch[1])) return ALLOW;   // owner — exempt
    return { category: 'external-comms', catastrophic: true, label: 'cli-send-telegram-nonowner' };
  }

  // --- deployment (NOT catastrophic — reversible-ish; fails open on gate error) ---
  if (/\bgh\s+pr\s+merge\b/.test(lower)) {
    return { category: 'deployment', catastrophic: false, label: 'gh-pr-merge' };
  }
  if (/\bgit\s+push\b/.test(lower) && /\b(origin\s+)?(main|master|develop)\b/.test(lower)) {
    return { category: 'deployment', catastrophic: false, label: 'git-push-protected' };
  }
  if (/\bvercel\s+(deploy|--prod|deploy\s+--prod)\b/.test(lower) || /\bvercel\s+deploy/.test(lower)) {
    return { category: 'deployment', catastrophic: false, label: 'vercel-deploy' };
  }
  if (/\blaunchctl\s+bootstrap\b/.test(lower) || /\bnpm\s+run\s+build:prod\b/.test(lower)) {
    return { category: 'deployment', catastrophic: false, label: 'dashboard-deploy' };
  }
  if (/\bpm2\s+(restart|reload|delete)\b/.test(lower)) {
    return { category: 'deployment', catastrophic: false, label: 'pm2-restart' };
  }

  // --- config-change (CATASTROPHIC — trust-anchor writes fail-CLOSED on gate
  // error so a corrupt config can't become a fail-open manufacture bypass, the
  // #1↔#8 interlock). Writing secrets/settings via shell redirection or tee; the
  // redirect target's quotes are stripped (`> "config.json"` must not evade). ---
  const redirectMatch = s.match(/(?:>>?|\btee\b\s+(?:-a\s+)?)\s*([^\s|;&]+)/);
  if (redirectMatch && isConfigChangePath(stripQuotes(redirectMatch[1]))) {
    return { category: 'config-change', catastrophic: true, label: 'shell-write-config' };
  }

  // --- self-CLI subversion: an agent shelling a GATED bus subcommand directly ---
  // (e.g. `CTX_AGENT_NAME=dashboard cortextos bus update-approval X approved` to
  // forge an authority identity, or `cortextos bus crm-contacts delete X`).
  // Catching it in the shared bash classifier closes the spoof on the tool-call
  // surface (Doc 3). update-approval is config-change (catastrophic): resolving an
  // approval on a gate error must fail closed, never let a manufacture slip.
  if (/\bbus\s+update-approval\b/.test(lower)) {
    return { category: 'config-change', catastrophic: true, label: 'cli-update-approval' };
  }
  if (/\bbus\s+crm-\w+\s+delete\b/.test(lower)) {
    return { category: 'data-deletion', catastrophic: true, label: 'cli-crm-delete' };
  }

  return ALLOW;
}

/**
 * Classify a full Bash command (possibly several sub-commands). Returns the
 * highest-severity match: any catastrophic match wins; else the first gated match;
 * else ALLOW.
 */
export function classifyBash(command: string, opts: BashClassifyOptions = {}): ClassifyResult {
  const subs = splitBashSubcommands(command);
  let firstGated: ClassifyResult | null = null;
  for (const sub of subs) {
    const r = classifyBashSubcommand(sub, opts);
    if (r.category) {
      if (r.catastrophic) return r; // catastrophic wins immediately
      if (!firstGated) firstGated = r;
    }
  }
  return firstGated ?? ALLOW;
}
