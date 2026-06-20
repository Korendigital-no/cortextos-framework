/**
 * Self-inflicted-stale detector (malformed-tool-call hang class).
 *
 * Failure mode (analyst, 3 recurrences 2026-05-31..06-05): a degraded session
 * starts emitting malformed tool-call wrappers that drop SILENTLY — the agent
 * "responds" but none of its calls (including update-heartbeat) land, so the
 * agent looks dead on the dashboard while the process is alive. Discipline
 * does not fix it (the failure is mechanical, not cognitive); a fresh session
 * does. This detector automates the analyst's triage rule: prompts keep going
 * IN while no agent-originated heartbeat comes OUT → force a fresh restart.
 *
 * The decision core is pure for testability; the fast-checker owns the I/O
 * (reading heartbeat.json, counting injections, firing hardRestart).
 *
 * IMPORTANT: the idle-session watchdog writes heartbeats from the FAST-CHECKER
 * process with a '[watchdog]' status prefix — those prove the daemon is alive,
 * not the session, and MUST NOT reset the detector.
 */

export interface StaleThresholds {
  /** Injections (cron/inbox/telegram prompts) without an agent heartbeat. */
  minInjections: number;
  /** Minimum silence window — guards against bursts right after a real beat. */
  windowMs: number;
}

export const DEFAULT_STALE_THRESHOLDS: StaleThresholds = {
  // 6 dropped turns ≈ 30 min of 5-min crons: early enough to save the night,
  // late enough that a single slow turn never trips it.
  minInjections: 6,
  windowMs: 45 * 60 * 1000,
};

export function staleThresholdsFromEnv(env: NodeJS.ProcessEnv = process.env): StaleThresholds {
  const num = (k: string, d: number) => {
    const n = Number(env[k]);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  return {
    minInjections: num('CTX_STALE_MIN_INJECTIONS', DEFAULT_STALE_THRESHOLDS.minInjections),
    windowMs: num('CTX_STALE_WINDOW_MIN', DEFAULT_STALE_THRESHOLDS.windowMs / 60_000) * 60_000,
  };
}

/** True for heartbeats written by the daemon's idle watchdog, not the agent. */
export function isWatchdogHeartbeat(status: string): boolean {
  return status.startsWith('[watchdog]');
}

/**
 * Whether the idle-session watchdog should write its `[watchdog]` heartbeat.
 *
 * Skip it when the agent has posted its OWN heartbeat within the watchdog window:
 * firing unconditionally overwrites a fresh agent beat with a "[watchdog] … idle"
 * status, so an actively-working but quiet agent shows idle until its next beat
 * (PR #100 codex P2). Fire (the liveness proof for genuine idle) when there is no
 * readable heartbeat, when the latest beat is the daemon's own `[watchdog]`
 * writer, or when the latest agent beat is older than the watchdog interval.
 */
export function shouldFireIdleWatchdog(
  hb: { status?: string; last_heartbeat?: string; timestamp?: string } | null | undefined,
  nowMs: number,
  intervalMs: number,
): boolean {
  if (!hb) return true;
  // `timestamp` is the legacy field name (Heartbeat type) — fall back to it as
  // other heartbeat readers do (e.g. bus/agents.ts), or a legacy record with only
  // `timestamp` would parse empty and fire over a fresh agent beat.
  const lastBeatMs = Date.parse(hb.last_heartbeat ?? hb.timestamp ?? '');
  if (!Number.isFinite(lastBeatMs)) return true;
  if (isWatchdogHeartbeat(hb.status ?? '')) return true;
  return nowMs - lastBeatMs >= intervalMs;
}

export interface StaleInput {
  /** Successful injections since the last agent-originated heartbeat. */
  injectionsSinceAgentBeat: number;
  /** ms timestamp of the last AGENT-originated heartbeat (0 = none seen). */
  lastAgentBeatMs: number;
  /** ms timestamp the current session started — the floor for the window. */
  sessionStartMs: number;
  nowMs: number;
}

/**
 * Pure decision: should the daemon force-restart this session as
 * self-inflicted stale? Both conditions must hold — enough dropped prompts
 * AND enough silence (measured from the later of last beat / session start,
 * so a fresh session always gets its full window to boot and beat).
 */
export function isSelfInflictedStale(input: StaleInput, t: StaleThresholds = DEFAULT_STALE_THRESHOLDS): boolean {
  if (input.injectionsSinceAgentBeat < t.minInjections) return false;
  const silenceFloor = Math.max(input.lastAgentBeatMs, input.sessionStartMs);
  return input.nowMs - silenceFloor >= t.windowMs;
}

/**
 * Restart circuit breaker: a session that re-degrades immediately after every
 * restart must not loop forever. At most `maxRestarts` detector-triggered
 * restarts inside `perWindowMs`; beyond that the detector goes alert-only.
 */
export interface StaleCircuit {
  restarts: number[]; // ms timestamps
}

export const STALE_CIRCUIT_MAX = 3;
export const STALE_CIRCUIT_WINDOW_MS = 6 * 60 * 60 * 1000;

export function circuitAllowsRestart(circuit: StaleCircuit, nowMs: number): boolean {
  const recent = circuit.restarts.filter(ts => nowMs - ts < STALE_CIRCUIT_WINDOW_MS);
  return recent.length < STALE_CIRCUIT_MAX;
}

export function recordCircuitRestart(circuit: StaleCircuit, nowMs: number): StaleCircuit {
  return { restarts: [...circuit.restarts.filter(ts => nowMs - ts < STALE_CIRCUIT_WINDOW_MS), nowMs] };
}

/**
 * Parse a simple interval shorthand ("4h", "30m", "2h30m", "1d") or a standard
 * cron expression of the form "* /N * * * *" (no space — asterisk-slash-N)
 * into milliseconds.  Returns null if unrecognised.
 * Exported for unit testing and for fast-checker's config-read path.
 */
export function parseIntervalToMs(interval: string): number | null {
  const s = interval.trim();

  // cron "*/N * * * *" → N minutes
  const cronMatch = s.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/);
  if (cronMatch) return parseInt(cronMatch[1], 10) * 60_000;

  // shorthand: digits followed by h/m/d, possibly repeated ("2h30m")
  const UNIT: Record<string, number> = { h: 3_600_000, m: 60_000, d: 86_400_000 };
  let total = 0;
  let matched = false;
  const remainder = s.replace(/(\d+)([hmd])/g, (_, n, unit) => {
    total += parseInt(n, 10) * UNIT[unit];
    matched = true;
    return '';
  });
  if (matched && remainder.trim() === '') return total > 0 ? total : null;

  return null;
}

/**
 * Compute cadence-aware stale thresholds for an agent whose heartbeat cron
 * fires every `heartbeatIntervalMs` milliseconds.
 *
 * The default 45-min silence window fires on perfectly healthy idle agents
 * (e.g. 4h heartbeat cron) because other crons accumulate 6+ injections
 * before the agent posts its next real beat.  Widening the window to 1.5×
 * the heartbeat interval gives the agent a full cycle to beat without
 * triggering a false self-inflicted-stale restart.
 */
export function staleThresholdsForCadence(
  heartbeatIntervalMs: number,
  base: StaleThresholds = DEFAULT_STALE_THRESHOLDS,
): StaleThresholds {
  return {
    ...base,
    windowMs: Math.max(base.windowMs, Math.round(heartbeatIntervalMs * 1.5)),
  };
}

/**
 * One-line, greppable arming summary the fast-checker logs when it activates the
 * detector. The detector deliberately did nothing observable at init, so proving
 * "is the self-inflicted-stale guard live on this build?" took a commit → dist
 * marker → process-start chain. This line makes it a single
 * `grep 'stale-detector armed'` of the fast-checker log. Verifiability is a
 * feature (task_1780797704445). Pure, so the exact format is unit-tested.
 */
export function formatStaleDetectorArmed(t: StaleThresholds = DEFAULT_STALE_THRESHOLDS): string {
  const windowMin = Math.round(t.windowMs / 60_000);
  const circuitWindowH = Math.round(STALE_CIRCUIT_WINDOW_MS / 3_600_000);
  return `stale-detector armed: minInjections=${t.minInjections}, window=${windowMin}min, circuit=${STALE_CIRCUIT_MAX} restarts/${circuitWindowH}h`;
}
