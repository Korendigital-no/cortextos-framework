// Single source of truth for agent liveness classification.
//
// Pure + dependency-free (only the HealthStatus type) so BOTH heartbeats.ts and
// reports.ts can share it — reports.ts deliberately avoids importing from
// modules that pull @/lib/config (turbopack chunk issues), so the classifier
// lives here, not in heartbeats.ts.
//
// HONEST STATE (standby-heartbeat root-fix): an idle standby agent emits no
// agent-originated beats between turns, but the daemon idle-watchdog
// (fast-checker) writes a '[watchdog]' heartbeat every 50 min — proof the
// PROCESS is alive even when the agent is resting. The previous binary
// healthy/stale classifiers ignored that signal, so healthy standby agents read
// as STALE (4-6 false tags/day). This distinguishes alive-but-resting ('idle')
// from genuinely hung/dead ('stale').

import type { HealthStatus } from '@/lib/types';

/** A recent AGENT-originated beat within this window = actively working. */
export const ACTIVE_WINDOW_MIN = 15;
/** Any beat within this window = process alive (watchdog beats every 50 min);
 *  beyond it, even the watchdog has stopped → hung/dead. 3 missed watchdog beats. */
export const IDLE_WINDOW_MIN = 150;

/** True for daemon idle-watchdog beats — process-alive proof, not agent activity. */
export function isWatchdogStatus(status: string | undefined | null): boolean {
  return typeof status === 'string' && status.startsWith('[watchdog]');
}

/**
 * Classify agent liveness from its latest heartbeat:
 *   - 'down'    : never beat (no last_heartbeat).
 *   - 'stale'   : a beat exists but older than IDLE_WINDOW — even the 50-min
 *                 watchdog stopped, so the process is hung/dead.
 *   - 'healthy' : a recent agent-originated beat (≤ ACTIVE_WINDOW) = working.
 *   - 'idle'    : alive (a beat within IDLE_WINDOW) but resting — the beat is
 *                 old or a '[watchdog]' beat. The NORMAL standby state, not a fault.
 * `now` is injected (ms epoch) for deterministic testing.
 */
export function agentLiveness(
  heartbeat: { last_heartbeat?: string | null; status?: string | null },
  now: number = Date.now(),
): HealthStatus {
  if (!heartbeat.last_heartbeat) return 'down';
  const ageMin = (now - new Date(heartbeat.last_heartbeat).getTime()) / 60000;
  if (!Number.isFinite(ageMin) || ageMin > IDLE_WINDOW_MIN) return 'stale';
  if (ageMin <= ACTIVE_WINDOW_MIN && !isWatchdogStatus(heartbeat.status)) return 'healthy';
  return 'idle';
}
