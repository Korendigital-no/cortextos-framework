/**
 * hook-egress-monitor.ts — PostToolUse hook for read-side exfiltration monitoring.
 *
 * MONITORING-ONLY: never emits permissionDecision, never blocks. Complements
 * hook-action-gate (PreToolUse, side-effect authorization) by covering the read
 * surface: credential-file reads and Bash upload/pipe-to-network patterns that
 * carry no outbound API side-effect on their own but are data-egress vectors.
 *
 * Signal map (logged to the event feed; severity-keyed):
 *   egress_secret_read    — Read tool on a credential/key/env path        (warning)
 *   egress_upload_pattern — Bash curl/wget upload (-d / -F / -T / etc.)   (warning)
 *   egress_pipe_to_net    — Bash pipe-to-network (cat|curl, base64|curl)  (warning)
 *   egress_novel_host     — Bash curl/wget to a host not in known-safe list (info)
 *
 * High-severity hits (any of the above + is_upload_to_novel_host = true) also
 * spawn a detached Telegram alert, mirroring the hook-action-gate notify pattern.
 *
 * SEC-INJECTION-v1 §9: tool_input is UNTRUSTED DATA. We pattern-match only; we
 * NEVER eval/interpolate. Meta payloads carry classification labels, never raw
 * paths, commands, or file contents.
 *
 * Fail-OPEN invariant: any parse or env error exits 0 (allow). A crashing or
 * misconfigured monitor MUST NOT block the fleet.
 */

import { writeSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { readStdin, parseHookInput } from './index.js';
import { resolveEnv } from '../utils/env.js';
import { resolvePaths } from '../utils/paths.js';
import { logEvent } from '../bus/event.js';

// --- Sensitive-path patterns -------------------------------------------------

/**
 * Paths that indicate credential / secret reads. Matched against the FULL path
 * string (not just the basename), so ~/.aws/config and /home/x/.env both match.
 * Pattern list is best-effort — obfuscated paths (env-var indirection) are the
 * documented Phase-2 limit.
 */
export const SENSITIVE_PATH_PATTERNS: RegExp[] = [
  /\.env($|\.)/i,                         // .env, .env.local, .env.production …
  /secrets?\.env$/i,                      // secrets.env
  /\.(pem|key|crt|p12|pfx|jks|keystore)$/i,
  /credentials?(\.json)?$/i,
  /(id_rsa|id_ed25519|id_ecdsa|id_dsa)$/i,
  /[/~](\.ssh)[/\\]/,                     // ~/.ssh/* (any file under .ssh/)
  /[/~](\.aws)[/\\](credentials|config)$/i,
  /\.npmrc$/i,                            // may contain _authToken
  /\.netrc$/i,
  /\.pgpass$/i,
  /api[_-]?key(\.[a-z]+)?$/i,
  /secret[_-]?key(\.[a-z]+)?$/i,
  /service[_-]account(\.[a-z]+)?$/i,     // GCP service account JSON
  /keyfile(\.[a-z]+)?$/i,
];

/**
 * Bash sub-command patterns that indicate data being POSTed or uploaded to an
 * external endpoint. We match against EACH sub-command (split on |/;/&&) to
 * avoid false-positives from unrelated adjacent commands.
 */
export const BASH_UPLOAD_PATTERNS: RegExp[] = [
  /\bcurl\b[^|;&]*(-X\s+(?:POST|PUT)|--request\s+(?:POST|PUT))/i,
  /\bcurl\b[^|;&]*(-d\s+|--data(?:-(?:binary|raw|urlencode))?[= ])/i,
  /\bcurl\b[^|;&]*(-F\s+|--form[= ])/i,
  /\bcurl\b[^|;&]*(-T\s+|--upload-file[= ])/i,
  /\bwget\b[^|;&]*(--post-data|--post-file)/i,
];

/**
 * Bash patterns indicating data piped INTO a network tool. The left side of the
 * pipe is the source; we detect when it connects to curl/wget/nc/socat, which
 * means any data (including secrets from a prior cat/.env read) could leave.
 */
export const PIPE_TO_NET_PATTERNS: RegExp[] = [
  /\|\s*curl\b/i,
  /\|\s*wget\b/i,
  /\|\s*(nc|netcat|socat|ncat)\b/i,
];

/**
 * Known-safe external hosts that are already gated by hook-action-gate's
 * SEND_ENDPOINT_HOSTS deny-list. Seeing these in a curl call is already
 * covered upstream; we skip the egress_novel_host signal for them to avoid
 * duplicate noise.
 */
export const KNOWN_GATED_HOSTS = new Set([
  'api.telegram.org',
  'api.resend.com',
  'api.sendgrid.com',
  'api.mailgun.net',
  'api.twilio.com',
  'graph.facebook.com',
  'api.linkedin.com',
  'slack.com',
  'discord.com',
  'api.openai.com',
  'api.stripe.com',
]);

// --- Signal classification ---------------------------------------------------

export interface EgressSignal {
  /** Canonical event name for logEvent(). */
  eventName: 'egress_secret_read' | 'egress_upload_pattern' | 'egress_pipe_to_net' | 'egress_novel_host';
  /** Free-form label for the matched pattern. NEVER the raw path/command. */
  label: string;
  /** True when both an upload pattern AND a novel host are present (highest risk). */
  highSeverity: boolean;
}

/**
 * Check whether a file_path matches a sensitive credential pattern.
 * Returns a signal or null. PURE + NO-THROW.
 */
export function classifyRead(filePath: unknown): EgressSignal | null {
  if (typeof filePath !== 'string' || !filePath) return null;
  for (const re of SENSITIVE_PATH_PATTERNS) {
    if (re.test(filePath)) {
      return { eventName: 'egress_secret_read', label: 'sensitive-path-read', highSeverity: false };
    }
  }
  return null;
}

/**
 * Extract the host from a URL string, or null if unparseable.
 * Uses the URL API (no regex) — CodeQL js/incomplete-hostname-regexp safe.
 */
function extractHost(token: string): string | null {
  if (!/^https?:\/\//i.test(token)) return null;
  try {
    return new URL(token).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Classify a single Bash command string (may be a full pipeline / chained
 * command). Emits at most ONE signal per call — highest severity wins.
 * PURE + NO-THROW.
 */
export function classifyBashEgress(command: unknown): EgressSignal | null {
  if (typeof command !== 'string' || !command) return null;

  // Pipe-to-net: highest priority — any data could leave.
  for (const re of PIPE_TO_NET_PATTERNS) {
    if (re.test(command)) {
      return { eventName: 'egress_pipe_to_net', label: 'pipe-to-network', highSeverity: true };
    }
  }

  // Sub-command level upload check (split on pipeline/chain boundaries).
  const subs = command.split(/\n|;|&&|\|\||[|]/g).map(s => s.trim()).filter(Boolean);

  let hasUpload = false;
  let hasNovelHost = false;
  let uploadLabel = '';

  for (const sub of subs) {
    if (!hasUpload) {
      for (const re of BASH_UPLOAD_PATTERNS) {
        if (re.test(sub)) { hasUpload = true; uploadLabel = re.source.slice(0, 40); break; }
      }
    }

    // Novel-host detection: curl/wget present + URL present + host not in known-gated set.
    if (/\b(curl|wget)\b/i.test(sub)) {
      for (const token of sub.split(/\s+/)) {
        const host = extractHost(token);
        if (host && !KNOWN_GATED_HOSTS.has(host) && !host.startsWith('127.') && host !== 'localhost') {
          hasNovelHost = true;
        }
      }
    }
  }

  if (hasUpload) {
    return {
      eventName: 'egress_upload_pattern',
      label: 'bash-upload',
      highSeverity: hasNovelHost,
    };
  }
  // egress_novel_host only fires when a curl/wget has an explicit body-carrying
  // flag OTHER than -X POST (which is in BASH_UPLOAD_PATTERNS). A bare GET to an
  // unknown host is not data egress; flagging it would create massive noise.
  // Novel-host signal stands alone only when combined with data-exfil flags that
  // are not yet in BASH_UPLOAD_PATTERNS. For now: no standalone novel-host signal.
  return null;
}

// --- Hook I/O ----------------------------------------------------------------

/** dist/hooks/hook-egress-monitor.js → dist/cli.js (the bus CLI entry). */
function cliJsPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');
}

/**
 * Fire a Telegram alert out-of-band for high-severity egress signals.
 * Mirrors hook-action-gate's spawnDetachedNotify pattern: detached + unref'd
 * so the hook answers well within its timeout. Best-effort — never throws.
 */
function spawnDetachedAlert(agent: string, org: string, eventName: string, label: string): void {
  try {
    const child = spawn(
      process.execPath,
      [cliJsPath(), 'bus', 'egress-alert', agent, org, eventName, label],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
  } catch {
    /* best-effort */
  }
}

/** Always-allow exit (monitoring hook never blocks). */
function allow(): never {
  process.exit(0);
}

async function main(): Promise<void> {
  // 1) Parse hook input — fail-OPEN on any parse error.
  let toolName = '';
  let toolInput: Record<string, unknown> = {};
  try {
    const parsed = parseHookInput(await readStdin());
    toolName = parsed.tool_name;
    toolInput = (parsed.tool_input ?? {}) as Record<string, unknown>;
  } catch {
    return allow();
  }

  // 2) Classify signal — fail-OPEN if classification throws.
  let signal: EgressSignal | null = null;
  try {
    if (toolName === 'Read') {
      signal = classifyRead(toolInput.file_path);
    } else if (toolName === 'Bash') {
      signal = classifyBashEgress(toolInput.command);
    }
  } catch {
    return allow();
  }

  if (!signal) return allow(); // no signal → fast-path allow

  // 3) Resolve env + log. Fail-OPEN on env/path errors — a monitor with a bad
  //    env must never wedge the fleet.
  try {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org, env.ctxRoot);

    const severity = signal.highSeverity ? 'warning' : 'info';
    logEvent(paths, env.agentName, env.org, 'action', signal.eventName, severity,
      JSON.stringify({ tool: toolName, signal: signal.label, high_severity: signal.highSeverity }));

    // 4) High-severity: also fire a Telegram alert (detached, never awaited).
    if (signal.highSeverity) {
      spawnDetachedAlert(env.agentName, env.org, signal.eventName, signal.label);
    }
  } catch {
    /* best-effort telemetry — monitoring failures must not block the fleet */
  }

  return allow();
}

const entry = process.argv[1] ?? '';
if (/hook-egress-monitor(\.[cm]?[jt]s)?$/.test(entry)) {
  main().catch(() => process.exit(0));
}
