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
//
// KNOWN LIMITATION (Codex P2, accepted at this dashboard-only scope): the
// watchdog overwrites the single heartbeat record every 50 min regardless of
// REPL state, and logEvent preserves that status. So an agent that is actively
// working but quiet (no explicit update-heartbeat) can read 'idle' from the
// moment a watchdog beat fires until its next agent-originated beat. This is
// benign — 'idle' is an alive state, not an alarm, and self-corrects on the next
// real beat — and far less harmful than the false-STALE this replaces. The
// proper root-fix (have the watchdog skip sessions with a recent agent beat
// instead of firing unconditionally) is a DAEMON change, out of this
// dashboard-side fix; tracked as a follow-up. The dashboard can only classify
// the latest signal the daemon left in the single heartbeat record.

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
