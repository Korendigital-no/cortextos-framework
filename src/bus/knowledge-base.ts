import { execFileSync, spawn } from 'child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import type { BusPaths } from '../types/index.js';
import { atomicWriteSync } from '../utils/atomic.js';
import { normalizeOrgName } from '../utils/org.js';

/**
 * Knowledge base integration — calls mmrag.py directly (cross-platform,
 * no bash dependency).  Previously wrapped kb-*.sh bash scripts.
 */

/**
 * Resolve the Python interpreter inside the knowledge-base venv,
 * accounting for Windows vs Unix layout.
 */
function getVenvPython(frameworkRoot: string): string {
  const isWin = process.platform === 'win32';
  const venvBin = isWin ? 'Scripts' : 'bin';
  const pythonExe = isWin ? 'python.exe' : 'python3';
  return join(frameworkRoot, 'knowledge-base', 'venv', venvBin, pythonExe);
}

/**
 * Load .env and secrets.env files the same way the bash scripts did
 * (`set -o allexport && source …`).  Returns a flat key→value map.
 */
function loadSecretsEnv(frameworkRoot: string, org: string): Record<string, string> {
  const secretsPath = join(frameworkRoot, 'orgs', org, 'secrets.env');
  const dotenvPath = join(frameworkRoot, '.env');
  const vars: Record<string, string> = {};
  for (const p of [dotenvPath, secretsPath]) {
    if (existsSync(p)) {
      for (const line of readFileSync(p, 'utf-8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf('=');
        if (idx > 0) {
          let val = trimmed.slice(idx + 1);
          // Strip surrounding quotes (single or double) that some .env files use
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          vars[trimmed.slice(0, idx)] = val;
        }
      }
    }
  }
  return vars;
}

/**
 * Check whether the knowledge base config file exists for a given env.
 *
 * The Python MMRAG tool loads its config from env.MMRAG_CONFIG
 * (`knowledge-base/config.json` under the org's state dir) and exits with
 * "Config not found. Run setup first" if the file is absent. When that
 * happens, execFileSync throws a non-zero-exit error which — if not caught
 * — produces a user-facing unhandled-throw stack dump on top of the
 * already-printed Python error. This helper lets callers detect the
 * missing-config state UP FRONT and respond gracefully (warn + return)
 * instead of relying on brittle stderr string matching after the throw.
 */
function kbConfigured(env: Record<string, string>): boolean {
  return existsSync(env.MMRAG_CONFIG);
}

/**
 * Build the full env object needed by mmrag.py calls.
 */
function buildKBEnv(
  frameworkRoot: string,
  org: string,
  instanceId: string,
  agent?: string,
): Record<string, string> {
  // Normalize org to its canonical filesystem casing BEFORE touching any
  // paths. Without this, a lowercase --org arg produces a ghost state dir
  // (~/.cortextos/<instance>/orgs/<lowercase>/knowledge-base/) with its own
  // MMRAG config.json, splitting KB state across two directories and
  // polluting dashboard sync with hits against a non-existent org.
  const canonicalOrg = normalizeOrgName(frameworkRoot, org);
  const kbRoot = join(homedir(), '.cortextos', instanceId, 'orgs', canonicalOrg, 'knowledge-base');
  const secrets = loadSecretsEnv(frameworkRoot, canonicalOrg);
  return {
    ...process.env as Record<string, string>,
    ...secrets,
    CTX_ORG: canonicalOrg,
    CTX_AGENT_NAME: agent || '',
    CTX_INSTANCE_ID: instanceId,
    CTX_FRAMEWORK_ROOT: frameworkRoot,
    MMRAG_DIR: kbRoot,
    MMRAG_CHROMADB_DIR: join(kbRoot, 'chromadb'),
    MMRAG_CONFIG: join(kbRoot, 'config.json'),
  };
}

// ---------------------------------------------------------------------------
// Mtime-guard helpers
// ---------------------------------------------------------------------------

/**
 * Per-file ingest timestamps. Key format: `<abs-path>::<collection>` so
 * different org/agent/scope combinations never collide (guardrail #3).
 */
interface IngestStamps {
  [key: string]: number; // mtime in ms at last successful ingest
}

function stampKey(absPath: string, collection: string): string {
  return `${absPath}::${collection}`;
}

function loadStamps(stampFile: string): IngestStamps {
  try {
    return JSON.parse(readFileSync(stampFile, 'utf-8')) as IngestStamps;
  } catch {
    return {};
  }
}

function saveStamps(stampFile: string, stamps: IngestStamps): void {
  // Use framework atomicWriteSync (src/utils/atomic.ts) per CLAUDE.md.
  // Writes to a random-hex temp file in the same dir, then rename(2) — atomic
  // on POSIX, cleans up temp on failure, sets 0o600 permissions.
  atomicWriteSync(stampFile, JSON.stringify(stamps, null, 2));
}

// ---------------------------------------------------------------------------

export interface KBQueryResult {
  content: string;
  source_file: string;
  agent_name?: string;
  org: string;
  score: number;
  doc_type: string;
}

export interface KBQueryResponse {
  results: KBQueryResult[];
  total: number;
  query: string;
  collection: string;
}

/**
 * Query the knowledge base.
 * Returns parsed JSON results when --json is used internally.
 */
export function queryKnowledgeBase(
  paths: BusPaths,
  question: string,
  options: {
    org: string;
    agent?: string;
    scope?: 'shared' | 'private' | 'all';
    topK?: number;
    threshold?: number;
    frameworkRoot: string;
    instanceId: string;
  },
): KBQueryResponse {
  const { agent, scope = 'all', topK = 5, threshold = 0.5, frameworkRoot, instanceId } = options;
  // Normalize once at the top so every downstream path join, env var, and
  // ChromaDB collection name uses the canonical filesystem casing. Without
  // this, `shared-acmecorp` and `shared-AcmeCorp` become two
  // distinct ChromaDB collections and a case-drifted query silently hits
  // the wrong one.
  const org = normalizeOrgName(frameworkRoot, options.org);

  const env = buildKBEnv(frameworkRoot, org, instanceId, agent);

  // UX safety net: if the KB is not configured for this org (no config.json
  // on disk yet), skip the python probe entirely and return empty results
  // with a visible warning. Previously the inner runQuery() try/catch would
  // swallow the Config-not-found error silently and the operator would see
  // "0 results" with no hint about WHY — indistinguishable from a legitimate
  // empty query against a configured KB. The warn-and-empty shape makes the
  // distinction obvious and actionable.
  if (!kbConfigured(env)) {
    console.warn(
      `[kb] Knowledge base not configured for org ${org}. Returning empty results — run setup to enable.`,
    );
    return { results: [], total: 0, query: question, collection: `shared-${org}` };
  }

  const pythonPath = getVenvPython(frameworkRoot);
  const mmragPath = join(frameworkRoot, 'knowledge-base', 'scripts', 'mmrag.py');

  // Determine which collections to query based on scope
  const collections: string[] = [];
  switch (scope) {
    case 'shared':
      collections.push(`shared-${org}`);
      break;
    case 'private':
      collections.push(agent ? `agent-${agent}` : `shared-${org}`);
      break;
    case 'all':
      collections.push(`shared-${org}`);
      if (agent) collections.push(`agent-${agent}`);
      break;
  }

  const runQuery = (col: string): string | null => {
    try {
      return execFileSync(pythonPath, [
        mmragPath, 'query', question,
        '--collection', col,
        '--top-k', String(topK),
        '--threshold', String(threshold),
        '--json',
      ], {
        encoding: 'utf-8',
        timeout: 30000,
        env,
      });
    } catch {
      return null;
    }
  };

  const parseOutput = (output: string | null): KBQueryResult[] => {
    if (!output) return [];
    // mmrag.py --json outputs pretty-printed JSON; find and parse the JSON block
    const trimmed = output.trim();
    const jsonStart = trimmed.indexOf('{');
    if (jsonStart === -1) return [];
    try {
      const raw = JSON.parse(trimmed.slice(jsonStart)) as {
        results?: Array<{ content?: string; result?: string; similarity?: number; source?: string; type?: string }>;
        result_count?: number;
        query?: string;
        collection?: string;
      };
      return (raw.results || []).map((r) => ({
        content: r.content || r.result || '',
        source_file: r.source || '',
        org,
        agent_name: agent,
        score: r.similarity ?? 0,
        doc_type: r.type || 'markdown',
      }));
    } catch {
      return [];
    }
  };

  try {
    let allResults: KBQueryResult[] = [];
    let lastCollection = `shared-${org}`;
    for (const col of collections) {
      const output = runQuery(col);
      allResults = allResults.concat(parseOutput(output));
      lastCollection = col;
    }

    if (allResults.length > 0) {
      return {
        results: allResults,
        total: allResults.length,
        query: question,
        collection: collections.length === 1 ? lastCollection : `shared-${org}`,
      };
    }
  } catch {
    // Failed — return empty
  }

  return { results: [], total: 0, query: question, collection: `shared-${org}` };
}

/**
 * Ingest files into the knowledge base.
 *
 * New options (additive — existing callers unaffected, guardrail #2):
 *   mtimeGuard — skip files unchanged since last ingest; force-reingest only
 *                changed files. Bypassed when `force` is explicitly set.
 *   detach     — spawn Python in background (fire-and-forget); returns
 *                immediately. Errors logged to `ingest-bg.log` in the KB
 *                root (never silently swallowed, guardrail #1).
 */
export function ingestKnowledgeBase(
  paths: string[],
  options: {
    org: string;
    agent?: string;
    scope?: 'shared' | 'private';
    force?: boolean;
    mtimeGuard?: boolean;
    detach?: boolean;
    frameworkRoot: string;
    instanceId: string;
  },
): void {
  const { agent, scope = 'shared', force, mtimeGuard, detach, frameworkRoot, instanceId } = options;
  // Normalize once (see queryKnowledgeBase for rationale).
  const org = normalizeOrgName(frameworkRoot, options.org);

  const env = buildKBEnv(frameworkRoot, org, instanceId, agent);

  // Correctness fix: if the KB is not configured for this org, the underlying
  // python MMRAG tool exits with "Config not found. Run setup first" and
  // execFileSync (below, stdio: inherit) throws a non-zero-exit error. That
  // throw used to bubble up through the CLI action handler as an unhandled
  // exception, dumping a full Node stack trace on top of the python error
  // message — ugly and alarming for operators who were just running ingest
  // without setting up the KB first. Detect the missing-config state
  // up-front and warn-and-skip instead of letting execFileSync crash.
  if (!kbConfigured(env)) {
    console.warn(
      `[kb] Knowledge base not configured for org ${org}. Skipping ingest — ` +
      `run setup to enable (see HEARTBEAT.md step 10 for the config path).`,
    );
    return;
  }

  const pythonPath = getVenvPython(frameworkRoot);
  const mmragPath = join(frameworkRoot, 'knowledge-base', 'scripts', 'mmrag.py');

  // Determine collection name (same logic as kb-ingest.sh)
  let collection: string;
  if (scope === 'private') {
    if (!agent) throw new Error('--agent or CTX_AGENT_NAME required for --scope private');
    collection = `agent-${agent}`;
  } else {
    collection = `shared-${org}`;
  }

  // Ensure chromadb dir exists
  const kbRoot = join(homedir(), '.cortextos', instanceId, 'orgs', org, 'knowledge-base');
  const chromaDir = join(kbRoot, 'chromadb');
  if (!existsSync(chromaDir)) {
    mkdirSync(chromaDir, { recursive: true });
  }

  const stampFile = join(kbRoot, 'ingest-stamps.json');

  // --- Mtime-guard ---
  // When mtimeGuard is on AND --force is NOT set, filter to only files whose
  // mtime has advanced since the last successful ingest for this collection.
  // Changed files get --force passed to mmrag.py so stale chunks are evicted.
  // Guard is bypassed entirely when --force is explicitly set (guardrail #2).
  let pathsToIngest = paths.map(p => resolve(p));
  let forceForPython = force;

  if (mtimeGuard && !force) {
    const stamps = loadStamps(stampFile);
    const changed: string[] = [];
    const unchanged: string[] = [];

    for (const absPath of pathsToIngest) {
      try {
        const stat = statSync(absPath);
        // Warn on directories: parent dir mtime does NOT reflect edits inside —
        // files nested under a directory argument will always be treated as changed.
        // Pass individual file paths to --mtime-guard for correct behaviour.
        if (stat.isDirectory()) {
          console.warn(`[kb] mtime-guard: WARNING: "${absPath}" is a directory — ` +
            `directory mtime does not reflect internal changes; treating as changed`);
          changed.push(absPath);
          continue;
        }
        const key = stampKey(absPath, collection);
        // Strict equality: any mtime change (including backwards, e.g. restored backup)
        // counts as changed. Equal mtime = unchanged (P1-4 fix: was >=).
        if (stamps[key] !== undefined && stamps[key] === stat.mtimeMs) {
          unchanged.push(absPath);
        } else {
          changed.push(absPath);
        }
      } catch {
        // File unreadable or missing — pass through so mmrag.py surfaces a clear error
        changed.push(absPath);
      }
    }

    if (unchanged.length > 0) {
      console.log(`[kb] mtime-guard: skipping ${unchanged.length} unchanged file(s)`);
      for (const p of unchanged) console.log(`  Unchanged: ${p}`);
    }

    pathsToIngest = changed;
    if (changed.length > 0) forceForPython = true;
  }

  if (pathsToIngest.length === 0) {
    console.log('[kb] mtime-guard: all files up to date, nothing to ingest');
    return;
  }

  console.log(`Ingesting into collection: ${collection}`);
  for (const p of pathsToIngest) console.log(`  Source: ${p}`);

  const args = [mmragPath, 'ingest', ...pathsToIngest, '--collection', collection];
  if (forceForPython) args.push('--force');

  // Multimodal PDF ingestion via Gemini Flash routinely takes 2–5 min for
  // documents over ~10 pages with images/tables. Two minutes was too low and
  // produced ETIMEDOUT mid-Gemini-call. Default 10 min, override via env,
  // floored at 60s so nobody accidentally sets it to 0 or a value smaller
  // than a single Gemini call needs.
  const KB_INGEST_TIMEOUT_FLOOR_MS = 60_000;
  const KB_INGEST_TIMEOUT_DEFAULT_MS = 600_000;
  const requestedTimeout = Number(process.env.KB_INGEST_TIMEOUT_MS);
  const ingestTimeoutMs = Math.max(
    KB_INGEST_TIMEOUT_FLOOR_MS,
    Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? requestedTimeout
      : KB_INGEST_TIMEOUT_DEFAULT_MS,
  );

  if (detach) {
    // --- Detach mode: fire-and-forget, errors logged to file (guardrail #1 — FAIL-LOUD) ---
    const logFile = join(kbRoot, 'ingest-bg.log');
    const logFd = openSync(logFile, 'a');

    // P0-1 fix: do NOT write stamps before spawn. A failed background ingest
    // (API outage, SIGKILL, Python error) must not permanently mark files as
    // successfully ingested and silently skip them on future guarded runs.
    // The next heartbeat will re-check mtime and re-dispatch if still changed.

    const child = spawn(pythonPath, args, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env,
    });

    // P2-9 fix: close parent-side fd immediately after spawn — the child
    // inherited its own copy; the parent does not need it open.
    closeSync(logFd);

    // P1-7 fix (strengthened): keep child referenced until we know if it
    // launched successfully. 'spawn' fires on success → unref immediately.
    // 'error' fires on launch failure (e.g. ENOENT — pythonPath missing or
    // not executable) → log to file synchronously, then unref.
    // Calling child.unref() unconditionally here would let the process exit
    // before the 'error' event fires, silently swallowing the failure.
    child.once('spawn', () => { child.unref(); });
    child.once('error', (err: Error) => {
      try {
        writeFileSync(logFile, `[${new Date().toISOString()}] kb-ingest spawn error: ${err.message}\n`, { flag: 'a' });
      } catch { /* ignore if log write itself fails */ }
      child.unref();
    });
    console.log(`[kb] Detached ingest started (pid ${child.pid ?? 'unknown'}) → log: ${logFile}`);
    return;
  }

  // --- Blocking mode (default) ---

  // P1-8 fix: capture mtime BEFORE ingest. If the file is edited while
  // mmrag.py runs, we stamp the pre-ingest mtime so that the newer version
  // is NOT incorrectly marked as ingested on the next guarded run.
  const preMtimes: Record<string, number> = {};
  if (mtimeGuard && !force) {
    for (const absPath of pathsToIngest) {
      try { preMtimes[absPath] = statSync(absPath).mtimeMs; } catch { /* skip */ }
    }
  }

  execFileSync(pythonPath, args, {
    encoding: 'utf-8',
    timeout: ingestTimeoutMs,
    env,
    stdio: 'inherit',
  });

  // Stamp with pre-ingest mtime values (captured above) after confirmed success.
  if (mtimeGuard && !force) {
    const stamps = loadStamps(stampFile);
    for (const absPath of pathsToIngest) {
      const mtime = preMtimes[absPath];
      if (mtime !== undefined) stamps[stampKey(absPath, collection)] = mtime;
    }
    saveStamps(stampFile, stamps);
  }

  console.log(`\nIngest complete → collection: ${collection}`);
}

/**
 * Ensure the knowledge base directories exist for an org.
 *
 * `frameworkRoot` is required so the org name can be normalized to its
 * canonical filesystem casing — without that, a caller passing a drifted
 * name (e.g. "acmecorp") would create a ghost state dir identical
 * to the one this module was written to prevent.
 */
export function ensureKBDirs(instanceId: string, frameworkRoot: string, org: string): void {
  const canonicalOrg = normalizeOrgName(frameworkRoot, org);
  const kbRoot = join(homedir(), '.cortextos', instanceId, 'orgs', canonicalOrg, 'knowledge-base');
  const chromaDir = join(kbRoot, 'chromadb');
  if (!existsSync(chromaDir)) {
    mkdirSync(chromaDir, { recursive: true });
  }
}
