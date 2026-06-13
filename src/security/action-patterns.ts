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
/**
 * A cortextOS-sensitive location for the GENERIC-named anchors (config.json etc.,
 * which also appear in unrelated projects). A config.json in /tmp is NOT our trust
 * anchor; one under an agent/org/state tree IS. A bare basename (no dir) is treated
 * as sensitive because an agent's cwd is its own dir.
 */
function isSensitiveLocation(p: string): boolean {
  if (!p.includes('/')) return true;
  return /(^|\/)(agents|orgs|state|config|\.cortextos)(\/|$)/.test(p);
}

export function isConfigChangePath(targetPath: string): boolean {
  const p = targetPath.replace(/\\/g, '/');
  const base = p.split('/').pop() || '';
  // --- ALWAYS sensitive (secrets / settings / bootstrap / approval rows) anywhere ---
  if (base === '.env' || base.startsWith('.env.') || base === 'secrets.env') return true;
  // Claude Code settings (auto-approved within an agent's own .claude/ by
  // hook-permission-telegram — exactly why settings writes must be gated here).
  if (/\.claude\/settings[^/]*\.json$/.test(p)) return true;
  // Bootstrap / identity / policy markdown an injection would target to escalate.
  if (/(^|\/)(GUARDRAILS|IDENTITY|SOUL|GOALS|SYSTEM|USER|AGENTS)\.md$/.test(p)) return true;
  // The gate's own approval rows (forging a resolved/approved row = manufacture).
  // `(^|/)` so a bare RELATIVE path (cwd already in the org/root) is caught too.
  if (/(^|\/)approvals\/(pending|resolved)\//.test(p)) return true;
  // --- generic config names — only under a cortextOS-sensitive location, so a
  // config.json copied OUT to /tmp is not mis-flagged as a trust-anchor write ---
  if (['config.json', 'context.json', 'crons.json', 'enabled-agents.json'].includes(base)) {
    return isSensitiveLocation(p);
  }
  return false;
}

/** True if a path is confined to an allowlisted scratch prefix (delete is safe). */
export function isScratchPath(targetPath: string, scratchPrefixes: string[] = DEFAULT_SCRATCH_PREFIXES): boolean {
  const p = targetPath.trim();
  return scratchPrefixes.some(prefix => p === prefix || p.startsWith(prefix));
}

/**
 * True if a path is a trust-anchor DIRECTORY (a copy/move INTO it lands a file
 * under a trust anchor — e.g. `cp forged.json orgs/x/approvals/resolved`). The
 * file-form `isConfigChangePath` requires a trailing segment, so the bare-dir form
 * needs this companion check.
 */
export function isConfigChangeDir(targetPath: string): boolean {
  const p = targetPath.replace(/\\/g, '/').replace(/\/+$/, '');
  if (/(^|\/)approvals\/(pending|resolved)$/.test(p)) return true;
  if (/(^|\/)\.claude$/.test(p)) return true;
  return false;
}

/**
 * Collect every write-destination token in a single sub-command: redirects (incl.
 * multi-target), tee targets, cp/mv/install/rsync/ln destinations (incl. `-t <dir>`),
 * in-place editors (sed -i / perl -i / awk -i inplace), and `dd of=`.
 *
 * BEST-EFFORT BOUNDARY (Doc 3 §7): this enumerates COMMON write primitives — it is
 * not, and cannot be, exhaustive. A file write via an interpreter
 * (`python -c "open('config.json','w')…"`, `node -e …`) is the documented
 * string-classifier limit, closed only by Phase-2 isolation. The COMPLETE
 * config-change protection does not rely on parsing bash at all: the `Write`/`Edit`
 * TOOL calls carry a structured `path` that `classifyAction` classifies directly
 * (Doc 3's surface), and the bus/CLI surface gates by descriptor — both unbypassable
 * by shell-string tricks. This deny-list is the additional bash-surface layer.
 */
export function bashWriteTargets(sub: string): string[] {
  const targets: string[] = [];
  // all `>` / `>>` redirect targets (not just the first)
  for (const m of sub.matchAll(/(?:>>?)\s*([^\s|;&<>]+)/g)) targets.push(stripQuotes(m[1]));
  // `tee [-a] target...` — every non-flag operand is a write destination
  const tee = sub.match(/\btee\b\s+(.*)$/i);
  if (tee) {
    for (const t of tee[1].split(/[\s|;&]+/)) if (t && !t.startsWith('-')) targets.push(stripQuotes(t));
  }
  // cp/mv/install/rsync/ln — the DESTINATION only (sources are reads, not writes).
  // A directory destination preserves the SOURCE basename, so the effective write is
  // DEST/basename(SRC) — `cp /tmp/config.json orgs/x/agents/y/` writes config.json.
  // We add BOTH dest-as-file and dest/basename(src) (covering the ambiguous
  // no-trailing-slash case without a stat), plus the `-t <dir>` form.
  const cpm = sub.match(/\b(cp|mv|install|rsync|ln)\b\s+(.*)$/i);
  if (cpm) {
    const toks = cpm[2].split(/\s+/).filter(Boolean);
    const tIdx = toks.findIndex(t => t === '-t' || t === '--target-directory');
    let targetDir: string | undefined;
    if (tIdx >= 0 && toks[tIdx + 1]) targetDir = stripQuotes(toks[tIdx + 1]);
    if (!targetDir) { const eq = toks.find(t => t.startsWith('--target-directory=')); if (eq) targetDir = stripQuotes(eq.split('=').slice(1).join('=')); }
    const nonFlag = toks.filter((t, i) => !t.startsWith('-') && !(tIdx >= 0 && i === tIdx + 1)).map(stripQuotes);
    if (targetDir) {
      targets.push(targetDir);
      for (const src of nonFlag) targets.push(joinUnder(targetDir, pathBasename(src)));
    } else if (nonFlag.length >= 1) {
      const dest = nonFlag[nonFlag.length - 1];
      targets.push(dest); // rename form (dest is a file)
      for (const src of nonFlag.slice(0, -1)) targets.push(joinUnder(dest, pathBasename(src))); // dir form
    }
  }
  // In-place editors (sed -i, perl -i/-pi, awk -i inplace) modify a file directly
  // without a redirect. Every non-flag operand is a candidate file — a sed/awk
  // SCRIPT operand never matches a trust-anchor BASENAME, so scanning all operands
  // is safe (no false positive from the expression). `dd of=<file>` writes too.
  if (/\bsed\b[^|;&]*\s-i/.test(sub)
      || /\bperl\b[^|;&]*\s-[a-zA-Z]*i\b/.test(sub)
      || /\bawk\b[^|;&]*\s-i\s+inplace/.test(sub)) {
    for (const t of sub.split(/\s+/)) if (t && !t.startsWith('-')) targets.push(stripQuotes(t));
  }
  for (const m of sub.matchAll(/\bof=([^\s|;&]+)/g)) targets.push(stripQuotes(m[1]));
  // Downloader output. Explicit output-file flags (-o/-O/--output FILE) — but a URL
  // captured after `curl -O` is NOT a file (that's remote-name, handled below), so
  // skip http(s) captures. Over-matching -o on other tools is harmless — only a
  // trust-anchor target flags.
  for (const m of sub.matchAll(/(?:^|\s)-[a-zA-Z]*[oO](?:\s+|=)([^\s|;&]+)/g)) {
    if (!/^https?:\/\//i.test(m[1])) targets.push(stripQuotes(m[1]));
  }
  for (const m of sub.matchAll(/--output(?:-document)?[= ]([^\s|;&]+)/g)) {
    if (!/^https?:\/\//i.test(m[1])) targets.push(stripQuotes(m[1]));
  }
  // Remote-name basename writes into cwd: `curl -O URL` and `wget URL` (no output
  // flag) write basename(URL) into the current dir — a bare-cwd trust anchor if the
  // URL ends in e.g. /config.json or /.env.
  const curlRemoteName = /\bcurl\b/.test(sub) && /(?:^|\s)-[a-zA-Z]*O\b/.test(sub);
  const wgetDefault = /\bwget\b/.test(sub) && !/(?:^|\s)-O(?:\s|=)/.test(sub) && !/--output-document/.test(sub);
  if (curlRemoteName || wgetDefault) {
    for (const m of sub.matchAll(/\bhttps?:\/\/[^\s|;&'"]+/gi)) {
      const b = m[0].replace(/[?#].*$/, '').split('/').pop();
      if (b) targets.push(b); // bare cwd basename
    }
  }
  return targets;
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

/**
 * True if `command` contains a URL whose HOST is exactly `host`, matched at a proper
 * host boundary — NOT a bare substring (CodeQL js/incomplete-url-substring-sanitization).
 * The host must follow `scheme://` and terminate at a host/path/query boundary, so:
 *   - `https://api.telegram.org.evil.com/…`  → NO match (longer host; `.` after the org)
 *   - `https://evil.com/?x=api.telegram.org` → NO match (substring is in the query, not
 *     the authority)
 *   - `https://api.telegram.org/bot…`        → match
 * This matters MOST for the telegram owner-exemption (a POSITIVE allow): a substring
 * match would let `api.telegram.org.evil.com?chat_id=<owner>` be exempted. `host` may
 * carry a leading path segment (e.g. `slack.com/api`); the boundary is enforced after it.
 */
export function urlHasHost(command: string, host: string): boolean {
  // `host` may be "example.com" or "example.com/path-prefix" (e.g. slack.com/api).
  const slash = host.indexOf('/');
  const wantHost = (slash === -1 ? host : host.slice(0, slash)).toLowerCase();
  const wantPath = slash === -1 ? '' : host.slice(slash).toLowerCase();
  // Tokenize on whitespace + shell metacharacters, then PARSE each URL-looking token
  // with the URL API and compare the parsed authority. We deliberately do NOT regex-
  // match the hostname (CodeQL js/incomplete-hostname-regexp: host checks must use URL
  // parsing, not a hand-rolled regex). `api.telegram.org.evil.com` parses to that FULL
  // hostname so it can never equal `api.telegram.org`; a host appearing in a path/query
  // is never the parsed authority. A scheme is required (the authority is unambiguous).
  for (const token of command.split(/[\s'"`|;&<>()]+/)) {
    const lower = token.toLowerCase();
    if (!lower.startsWith('http://') && !lower.startsWith('https://')) continue;
    let parsed: URL;
    try {
      parsed = new URL(token);
    } catch {
      continue; // not a valid URL token
    }
    if (parsed.hostname.toLowerCase() !== wantHost) continue;
    if (wantPath && !parsed.pathname.toLowerCase().startsWith(wantPath)) continue;
    return true;
  }
  return false;
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

/** Last path segment of a token (the file the OS would name a copied file). */
function pathBasename(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || p;
}

/** Join a (possibly trailing-slashed) dir with a basename. */
function joinUnder(dir: string, base: string): string {
  return dir.replace(/\/+$/, '') + '/' + base;
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
    // Host checks are anchored to the URL authority (urlHasHost parses each URL token),
    // NOT a bare substring, so `api.telegram.org.evil.com` / `evil.com?x=api.telegram.org`
    // cannot match. Compute ALL endpoint classes up front: curl/wget accept MULTIPLE URLs
    // in one invocation and `-d` posts to every one, so the owner-telegram EXEMPTION (a
    // positive allow) must apply ONLY when telegram is the SOLE external target. A sub
    // that co-locates an owner-telegram URL with a send/financial endpoint exfiltrates to
    // the latter — the exfil/spend host wins, never the exemption (P2-1).
    const financial = FINANCIAL_HOSTS.some(h => urlHasHost(s, h));
    const send = SEND_ENDPOINT_HOSTS.some(h => urlHasHost(s, h));
    const telegram = urlHasHost(s, TELEGRAM_API_HOST);
    // Financial is the highest-severity external class → classify first; a co-located
    // telegram URL can never exempt a spend call.
    if (financial) {
      return { category: 'financial', catastrophic: true, label: 'financial-endpoint' };
    }
    if (telegram) {
      // Owner-exemption ONLY when telegram is the sole external target (no send host).
      if (!send) {
        const owners = opts.ownerChatIds;
        // Owner-ness undeterminable (no owner list) → ALLOW (never freeze the owner
        // control channel on an unresolvable owner list; see action-gate carve-out).
        if (owners === undefined) return ALLOW;
        const chatId = extractTelegramChatId(s);
        if (chatId !== null && owners.includes(chatId)) return ALLOW; // owner — exempt
      }
      // non-owner telegram, OR telegram co-located with an exfil endpoint → external-comms.
      return { category: 'external-comms', catastrophic: true, label: send ? 'telegram-colocated-send' : 'telegram-nonowner' };
    }
    if (send) {
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
  // Collect EVERY write destination (redirects incl. multi-target, tee multi-target,
  // cp/mv/install/rsync/ln dest incl. -t dir form) and flag if ANY is a trust anchor
  // (file OR directory). Covers `> a > b`, `tee a b`, `cp src approvals/resolved`,
  // `cp -t dir src` — the multi-target/dir-dest evasions of the single-target form.
  if (bashWriteTargets(s).some(t => isConfigChangePath(t) || isConfigChangeDir(t))) {
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
