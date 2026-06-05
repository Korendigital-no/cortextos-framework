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
