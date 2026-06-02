import { execSync, execFileSync } from 'child_process';
import { existsSync, readFileSync, statSync, appendFileSync, writeFileSync } from 'fs';
import { join, extname } from 'path';
import { readdirSync } from 'fs';
import { ensureDir } from '../utils/atomic.js';
import { TelegramAPI } from '../telegram/api.js';
import type { BusPaths } from '../types/index.js';

// --- Types ---

export interface AutoCommitReport {
  status: 'staged' | 'clean' | 'nothing_to_stage' | 'dry_run';
  staged: string[];
  blocked: string[];
  diff_stat?: string;
}

export interface AgentGoalStatus {
  agent: string;
  org: string;
  status: 'fresh' | 'stale' | 'missing' | 'no_timestamp' | 'parse_error';
  updated?: string;
  age_days?: number;
  stale: boolean;
  reason?: string;
}

export interface GoalStalenessReport {
  summary: { total: number; stale: number; fresh: number; threshold_days: number };
  agents: AgentGoalStatus[];
}

// --- Blocked file patterns ---

const BINARY_TEMP_EXTENSIONS = new Set([
  '.log', '.tmp', '.pid', '.pyc', '.pyo', '.class', '.o', '.so', '.dylib',
]);

const EXCLUDED_DIR_PREFIXES = [
  'telegram-images/',
  'node_modules/',
  '__pycache__/',
  '.venv/',
];

// High-confidence secret token formats. Length-bounded on purpose so that
// substrings inside package names (e.g. "queue-microtask-" matching "sk-") or
// base64 hashes (random "AKIA"/"key=" runs) do NOT trip the scanner. These are
// the shapes real leaked tokens actually take.
// Leading \b only: a trailing \b would reject tokens ending in base64 padding
// (e.g. AccountKey=...== ). Each branch is length-bounded so it cannot over-match.
const HIGH_CONFIDENCE_TOKEN =
  /\b(?:sk-ant-[A-Za-z0-9_-]{20,}|sk-proj-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36}|gho_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|AccountKey=[A-Za-z0-9+/=]{40,})/;

const SECRET_KEYWORD =
  '(?:api[_-]?key|secret|token|passwo?rd|access[_-]?key|client[_-]?secret|auth[_-]?token|private[_-]?key)';

// A secret keyword assigned a QUOTED string literal (JSON/YAML/code). The
// matching-quote backreference means only an actual hardcoded literal trips it.
// The value is any run of >=16 non-whitespace characters that are not the
// opening quote, so password specials (@ ! $ :) are covered while multi-word
// prose (which contains spaces) is not. Group 1 = quote, group 2 = value.
const QUOTED_ASSIGNMENT_SOURCE =
  SECRET_KEYWORD + '["\'`]?\\s*[:=]\\s*(["\'`])((?:(?!\\1)\\S){16,})\\1';

// A secret keyword assigned an UNQUOTED value (INI / properties / .env-style
// `password=value`). Applied ONLY to config-format files (see
// UNQUOTED_SCAN_EXTENSIONS), so the value can be captured broadly — any run of
// non-whitespace, non-quote characters, which includes password specials like
// @ ! $ : that real credentials use. Code files are never unquoted-scanned, so
// expressions such as `token = authHeader.slice(7)` cannot reach this. Group 1
// = value. Compiled fresh per call to avoid the global-regex `lastIndex` hazard.
const UNQUOTED_ASSIGNMENT_SOURCE =
  SECRET_KEYWORD + '\\s*[:=]\\s*([^\\s"\'`]{16,})';

// npm/yarn lockfile integrity hashes — base64 sha digests, never secrets.
const LOCKFILE_INTEGRITY_LINE =
  /^\s*"integrity":\s*"sha(?:256|384|512)-[A-Za-z0-9+/=]+"\s*,?\s*$/;

// Code / structured-data formats where a real secret is written as a QUOTED
// string literal. Unquoted-value scanning is skipped for these so that variable
// references and code expressions (`password = hashedValue`,
// `token = authHeader.slice(7)`) don't false-positive. Everything else —
// config formats (.ini/.conf/.yaml/.toml/…), extensionless credential files
// (`credentials`), and dotfiles (`.npmrc`, `.netrc`) — IS scanned for unquoted
// `key=value` secrets, matching the auto-commit blocker's original coverage.
const QUOTED_ONLY_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.json5',
  '.py', '.go', '.java', '.kt', '.kts', '.scala', '.rb', '.rs',
  '.c', '.cc', '.cpp', '.cxx', '.h', '.hpp', '.cs', '.php', '.swift',
  '.dart', '.lua', '.pl', '.pm', '.groovy', '.gradle', '.vue', '.svelte',
  '.md', '.markdown', '.html', '.htm',
]);

/** Shannon entropy in bits per character. */
function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const freq: Record<string, number> = {};
  for (const ch of value) freq[ch] = (freq[ch] || 0) + 1;
  let entropy = 0;
  for (const ch in freq) {
    const p = freq[ch] / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Whether a captured assignment value looks like a real secret rather than an
 * env-var reference, placeholder, or low-entropy filler. Length is already
 * guaranteed >= 16 by the capture group.
 */
function looksLikeSecretValue(value: string): boolean {
  // Env-var / template references are not literal secrets.
  if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(value)) return false;
  if (/^(?:process\.env|import\.meta\.env)\./.test(value)) return false;
  // Obvious placeholders.
  if (/^(?:your|example|placeholder|change[_-]?me|x{4,}|test|dummy|redacted|none|null|undefined|sample|fake)/i.test(value)) {
    return false;
  }
  // Real secrets mix character classes and carry entropy; long English-ish
  // prose with one class (e.g. a sentence) should not trip.
  return shannonEntropy(value) >= 3.0;
}

/**
 * Detect whether file content contains a leaked credential. Precise by design:
 * flags real token formats and secret-keyword assignments with high-entropy
 * literal values, while ignoring identifiers, cookie names, comments, and
 * lockfile integrity hashes that previously caused false positives.
 */
export function containsCredential(content: string, filename: string = ''): boolean {
  const isLockfile = /(?:^|[\\/])[^\\/]*-lock\.json$/.test(filename);
  const scanUnquoted = !QUOTED_ONLY_EXTENSIONS.has(extname(filename).toLowerCase());
  const quoted = new RegExp(QUOTED_ASSIGNMENT_SOURCE, 'gi');
  const unquoted = new RegExp(UNQUOTED_ASSIGNMENT_SOURCE, 'gi');
  for (const line of content.split('\n')) {
    if (isLockfile && LOCKFILE_INTEGRITY_LINE.test(line)) continue;
    if (HIGH_CONFIDENCE_TOKEN.test(line)) return true;
    let match: RegExpExecArray | null;
    quoted.lastIndex = 0;
    while ((match = quoted.exec(line)) !== null) {
      if (looksLikeSecretValue(match[2])) return true;
    }
    if (scanUnquoted) {
      unquoted.lastIndex = 0;
      while ((match = unquoted.exec(line)) !== null) {
        if (looksLikeSecretValue(match[1])) return true;
      }
    }
  }
  return false;
}

const SCRIPT_EXTENSIONS = new Set(['.sh', '.py', '.js']);

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

// --- Functions ---

/**
 * Plan a self-restart. Creates a marker file and logs the reason.
 * The daemon handles the actual restart via IPC.
 * Mirrors bash bus/self-restart.sh.
 */
export function selfRestart(paths: BusPaths, agentName: string, reason?: string): void {
  const resolvedReason = reason || 'no reason specified';

  // Create restart marker
  ensureDir(paths.stateDir);
  writeFileSync(join(paths.stateDir, '.restart-planned'), resolvedReason + '\n', 'utf-8');

  // Append to restarts.log
  ensureDir(paths.logDir);
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const logLine = `[${timestamp}] SELF-RESTART: ${resolvedReason}\n`;
  appendFileSync(join(paths.logDir, 'restarts.log'), logLine, 'utf-8');
}

/**
 * Plan a hard restart (fresh session, no --continue).
 * Creates .force-fresh marker file; daemon checks this on next restart.
 * Mirrors bash bus/hard-restart.sh.
 */
export function hardRestart(paths: BusPaths, agentName: string, reason?: string): void {
  const resolvedReason = reason || 'no reason specified';

  // Create force-fresh marker (agent-process.ts checks this on restart)
  ensureDir(paths.stateDir);
  writeFileSync(join(paths.stateDir, '.force-fresh'), resolvedReason + '\n', 'utf-8');

  // Also create restart marker so crash-alert knows it was planned
  writeFileSync(join(paths.stateDir, '.restart-planned'), resolvedReason + '\n', 'utf-8');

  // Append to restarts.log
  ensureDir(paths.logDir);
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const logLine = `[${timestamp}] HARD-RESTART: ${resolvedReason}\n`;
  appendFileSync(join(paths.logDir, 'restarts.log'), logLine, 'utf-8');
}

/**
 * Auto-commit safe files in a project directory.
 * Filters out dangerous files (credentials, env, large, binary).
 * Never pushes. Mirrors bash bus/auto-commit.sh.
 */
export function autoCommit(projectDir: string, dryRun: boolean = false): AutoCommitReport {
  // Check if git repo
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: projectDir, stdio: 'pipe' });
  } catch {
    return { status: 'clean', staged: [], blocked: [] };
  }

  // Get changed files
  let porcelainOutput: string;
  try {
    porcelainOutput = execSync('git status --porcelain', { cwd: projectDir, encoding: 'utf-8' });
  } catch {
    return { status: 'clean', staged: [], blocked: [] };
  }

  if (!porcelainOutput.trim()) {
    return { status: 'clean', staged: [], blocked: [] };
  }

  const changedFiles = porcelainOutput
    .split('\n')
    .filter(line => line.trim())
    .map(line => line.slice(3)); // cut from column 4 (0-indexed col 3)

  const staged: string[] = [];
  const blocked: string[] = [];

  for (const file of changedFiles) {
    if (!file) continue;

    // Block all dot-env files and variants regardless of directory depth:
    // the `.env` dotfile, suffixed variants (.env.local, .env.production,
    // .env.example, …), and `.env`-extension files (app.env, prod.env). These
    // are credential files and must never be auto-committed.
    const basename = file.split(/[\\/]/).pop() || file;
    if (basename === '.env' || basename.startsWith('.env.') || extname(basename) === '.env') {
      blocked.push(`${file}:contains_credentials`);
      continue;
    }

    // Block .cortextos-env
    if (file === '.cortextos-env' || file.endsWith('/.cortextos-env')) {
      blocked.push(`${file}:runtime_env`);
      continue;
    }

    // Block binary/temp extensions
    const ext = extname(file);
    if (BINARY_TEMP_EXTENSIONS.has(ext)) {
      blocked.push(`${file}:binary_or_temp`);
      continue;
    }

    // Block excluded directories
    if (EXCLUDED_DIR_PREFIXES.some(prefix => file.startsWith(prefix))) {
      blocked.push(`${file}:excluded_directory`);
      continue;
    }

    const fullPath = join(projectDir, file);

    // Block files over 10MB
    if (existsSync(fullPath)) {
      try {
        const stat = statSync(fullPath);
        if (stat.isFile() && stat.size > MAX_FILE_SIZE) {
          blocked.push(`${file}:over_10MB`);
          continue;
        }
      } catch {
        // If can't stat, still try to stage
      }
    }

    // Check credential patterns in non-script file content
    if (existsSync(fullPath) && !SCRIPT_EXTENSIONS.has(ext)) {
      try {
        const stat = statSync(fullPath);
        if (stat.isFile() && stat.size < MAX_FILE_SIZE) {
          const content = readFileSync(fullPath, 'utf-8');
          if (containsCredential(content, file)) {
            blocked.push(`${file}:credential_pattern_detected`);
            continue;
          }
        }
      } catch {
        // Binary files may throw on utf-8 read - skip credential check
      }
    }

    staged.push(file);
  }

  if (staged.length === 0) {
    return { status: 'nothing_to_stage', staged: [], blocked };
  }

  if (dryRun) {
    return { status: 'dry_run', staged, blocked };
  }

  // Stage safe files
  for (const file of staged) {
    try {
      execFileSync('git', ['add', file], { cwd: projectDir, stdio: 'pipe' });
    } catch {
      // Ignore individual add failures
    }
  }

  // Get diff stat
  let diffStat: string | undefined;
  try {
    const stat = execSync('git diff --cached --stat', { cwd: projectDir, encoding: 'utf-8' });
    const lines = stat.trim().split('\n');
    diffStat = lines[lines.length - 1]?.trim() || undefined;
  } catch {
    // Ignore
  }

  return { status: 'staged', staged, blocked, diff_stat: diffStat };
}

/**
 * Check goal staleness for all agents across all orgs.
 * Mirrors bash bus/check-goal-staleness.sh.
 */
export function checkGoalStaleness(
  projectRoot: string,
  thresholdDays: number = 7,
): GoalStalenessReport {
  const agents: AgentGoalStatus[] = [];
  const thresholdMs = thresholdDays * 86400 * 1000;
  const now = Date.now();

  const orgsDir = join(projectRoot, 'orgs');
  if (!existsSync(orgsDir)) {
    return {
      summary: { total: 0, stale: 0, fresh: 0, threshold_days: thresholdDays },
      agents: [],
    };
  }

  let orgNames: string[];
  try {
    orgNames = readdirSync(orgsDir).filter(name => {
      try {
        return statSync(join(orgsDir, name)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    orgNames = [];
  }

  for (const orgName of orgNames) {
    const agentsDir = join(orgsDir, orgName, 'agents');
    if (!existsSync(agentsDir)) continue;

    let agentNames: string[];
    try {
      agentNames = readdirSync(agentsDir).filter(name => {
        // Validate agent name (lowercase, numbers, hyphens, underscores)
        if (!/^[a-z0-9_-]+$/.test(name)) return false;
        try {
          return statSync(join(agentsDir, name)).isDirectory();
        } catch {
          return false;
        }
      });
    } catch {
      continue;
    }

    for (const agentName of agentNames) {
      const goalsFile = join(agentsDir, agentName, 'GOALS.md');

      if (!existsSync(goalsFile)) {
        agents.push({
          agent: agentName,
          org: orgName,
          status: 'missing',
          stale: true,
          reason: 'no GOALS.md file',
        });
        continue;
      }

      // Read and parse GOALS.md
      let content: string;
      try {
        content = readFileSync(goalsFile, 'utf-8');
      } catch {
        agents.push({
          agent: agentName,
          org: orgName,
          status: 'missing',
          stale: true,
          reason: 'could not read GOALS.md',
        });
        continue;
      }

      // Find "## Updated" section and get the next line
      const lines = content.split('\n');
      let updatedLine: string | null = null;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim().startsWith('## Updated')) {
          // Get next non-empty line
          for (let j = i + 1; j < lines.length; j++) {
            const trimmed = lines[j].trim();
            if (trimmed && !trimmed.startsWith('##')) {
              updatedLine = trimmed;
              break;
            }
          }
          break;
        }
      }

      if (!updatedLine) {
        agents.push({
          agent: agentName,
          org: orgName,
          status: 'no_timestamp',
          stale: true,
          reason: 'no Updated timestamp in GOALS.md',
        });
        continue;
      }

      // Parse ISO 8601 timestamp
      const parsedDate = new Date(updatedLine);
      if (isNaN(parsedDate.getTime())) {
        agents.push({
          agent: agentName,
          org: orgName,
          status: 'parse_error',
          updated: updatedLine,
          stale: true,
          reason: 'could not parse timestamp',
        });
        continue;
      }

      const ageMs = now - parsedDate.getTime();
      const ageDays = Math.floor(ageMs / 86400000);
      const isStale = ageMs > thresholdMs;

      agents.push({
        agent: agentName,
        org: orgName,
        status: isStale ? 'stale' : 'fresh',
        updated: updatedLine,
        age_days: ageDays,
        stale: isStale,
        reason: isStale
          ? `${ageDays} days since last update (threshold: ${thresholdDays})`
          : undefined,
      });
    }
  }

  const total = agents.length;
  const staleCount = agents.filter(a => a.stale).length;
  const freshCount = agents.filter(a => !a.stale).length;

  return {
    summary: {
      total,
      stale: staleCount,
      fresh: freshCount,
      threshold_days: thresholdDays,
    },
    agents,
  };
}

/**
 * Post a message to the org's Telegram activity channel.
 *
 * Returns false if not configured (silent fail — callers can ignore the
 * return value and treat activity-channel posting as best-effort).
 *
 * `replyMarkup` is an optional Telegram inline keyboard (or any reply
 * markup shape). When provided, the message ships with the keyboard
 * attached — used for interactive workflows like approval Approve/Deny
 * buttons posted alongside approval creation. Leaving it undefined
 * preserves the prior one-way notification shape exactly.
 *
 * Mirrors bash bus/post-activity.sh.
 */
export async function postActivity(
  orgDir: string,
  ctxRoot: string,
  org: string,
  message: string,
  replyMarkup?: object,
): Promise<boolean> {
  // Look for activity-channel.env
  const candidates = [
    join(orgDir, 'activity-channel.env'),
    join(ctxRoot, 'orgs', org, 'activity-channel.env'),
  ];

  let configPath: string | null = null;
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      configPath = candidate;
      break;
    }
  }

  if (!configPath) {
    return false;
  }

  // Parse the env file
  let botToken: string | undefined;
  let chatId: string | undefined;

  try {
    const content = readFileSync(configPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx <= 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (key === 'ACTIVITY_BOT_TOKEN') botToken = value;
      if (key === 'ACTIVITY_CHAT_ID') chatId = value;
    }
  } catch {
    return false;
  }

  if (!botToken || !chatId) {
    return false;
  }

  try {
    const api = new TelegramAPI(botToken);
    await api.sendMessage(chatId, message, replyMarkup);
    return true;
  } catch {
    return false;
  }
}
