// cortextOS Dashboard - Heartbeat data fetcher
// Reads directly from filesystem (heartbeats change frequently; SQLite may lag).

import fs from 'fs/promises';
import path from 'path';
import { CTX_ROOT, getHeartbeatPath, getAllAgents } from '@/lib/config';
import type { Heartbeat, HealthStatus, AgentHealth, HealthSummary } from '@/lib/types';
import { agentLiveness } from '@/lib/agent-liveness';

// agentLiveness (the unified active/idle/stale/down classifier) lives in the
// dependency-free @/lib/agent-liveness so reports.ts can share it without
// pulling @/lib/config. Re-exported here for existing import sites.
export { agentLiveness, isWatchdogStatus } from '@/lib/agent-liveness';

/**
 * Get heartbeat for a single agent. Returns null if not found.
 */
export async function getHeartbeat(agentName: string): Promise<Heartbeat | null> {
  const hbPath = getHeartbeatPath(agentName);
  try {
    const raw = await fs.readFile(hbPath, 'utf-8');
    const data = JSON.parse(raw);
    return {
      agent: agentName,
      org: data.org ?? '',
      status: data.status ?? 'unknown',
      current_task: data.current_task ?? undefined,
      mode: data.mode ?? undefined,
      last_heartbeat: data.last_heartbeat ?? data.timestamp ?? undefined,
      loop_interval: data.loop_interval ?? undefined,
      uptime_seconds: data.uptime_seconds ?? undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Get all heartbeats by scanning the state directory.
 */
export async function getAllHeartbeats(): Promise<Heartbeat[]> {
  const stateDir = path.join(CTX_ROOT, 'state');
  const heartbeats: Heartbeat[] = [];

  try {
    const entries = await fs.readdir(stateDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory());

    const results = await Promise.allSettled(
      dirs.map((d) => getHeartbeat(d.name))
    );

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        heartbeats.push(result.value);
      }
    }
  } catch {
    // state dir doesn't exist yet - return empty
  }

  return heartbeats;
}

/**
 * Get heartbeats filtered by org. If no org, returns all.
 */
export async function getHeartbeats(org?: string): Promise<Heartbeat[]> {
  const all = await getAllHeartbeats();
  if (!org) return all;
  // Include agents with matching org OR empty org (agents may not write org to heartbeat)
  return all.filter((hb) => hb.org === org || !hb.org);
}

/**
 * Compute health status from a heartbeat. Thin wrapper over agentLiveness;
 * thresholdMinutes is accepted for backward-compat but the unified classifier
 * owns the windows.
 */
export function computeHealth(
  heartbeat: Heartbeat,
  _thresholdMinutes?: number
): HealthStatus {
  return agentLiveness(heartbeat);
}

/**
 * Check whether an agent's process is alive (healthy OR idle) — i.e. NOT stale
 * or down. An idle standby agent is alive, so it is "healthy" by this predicate.
 */
export function isAgentHealthy(
  heartbeat: Heartbeat,
  _thresholdMinutes?: number
): boolean {
  const s = agentLiveness(heartbeat);
  return s === 'healthy' || s === 'idle';
}

/** Detailed health status — unified through agentLiveness (healthy/idle/stale/down). */
export function getHealthStatus(heartbeat: Heartbeat): HealthStatus {
  return agentLiveness(heartbeat);
}

/**
 * Get agents with stale or down heartbeats.
 */
export async function getStaleAgents(): Promise<Heartbeat[]> {
  const all = await getAllHeartbeats();
  return all.filter((hb) => !isAgentHealthy(hb));
}

/**
 * Get a health summary across all agents (optionally filtered by org).
 */
export async function getHealthSummary(org?: string): Promise<HealthSummary> {
  // Only count REGISTERED agents (enabled-agents.json + org agent dirs). Stray
  // state dirs for non-agent services (e.g. dashboard/oauth/usage) leave heartbeat
  // dirs but never beat — without this filter they show as perpetual "down" and
  // inflate "actions needed" / System Health with false alarms.
  const roster = new Set(getAllAgents().map((a) => a.name));
  const heartbeats = (await getHeartbeats(org)).filter((hb) => roster.has(hb.agent));

  const summary: HealthSummary = {
    healthy: 0,
    stale: 0,
    down: 0,
    agents: [],
  };

  for (const hb of heartbeats) {
    const health = getHealthStatus(hb);

    // 'idle' is alive (resting) — fold it into the healthy/alive count for this
    // high-level summary so a standby agent never inflates stale/down. The
    // per-agent view (agents-grid) surfaces idle as its own state.
    if (health === 'healthy' || health === 'idle') summary.healthy++;
    else if (health === 'stale') summary.stale++;
    else summary.down++;

    summary.agents.push({
      agent: hb.agent,
      org: hb.org,
      health,
      lastHeartbeat: hb.last_heartbeat,
      currentTask: hb.current_task,
    });
  }

  return summary;
}
