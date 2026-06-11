/**
 * Agent liveness classifier (standby-heartbeat root-fix).
 *
 * Pins the honest active/idle/stale/down distinction: an idle standby agent
 * (alive via a recent daemon [watchdog] beat) must NOT read as stale — that
 * false-positive (4-6/day) is exactly what this fix removes.
 */

import { describe, it, expect } from 'vitest';
import {
  agentLiveness,
  isWatchdogStatus,
} from '../../../dashboard/src/lib/agent-liveness';

const now = Date.parse('2026-06-11T12:00:00Z');
const beat = (minAgo: number, status: string | null = 'standby') => ({
  last_heartbeat: new Date(now - minAgo * 60000).toISOString(),
  status,
});

describe('agentLiveness', () => {
  it('down when there is no heartbeat at all', () => {
    expect(agentLiveness({}, now)).toBe('down');
    expect(agentLiveness({ last_heartbeat: null }, now)).toBe('down');
  });

  it('healthy: a recent agent-originated beat = actively working', () => {
    expect(agentLiveness(beat(5, 'working on X'), now)).toBe('healthy');
    expect(agentLiveness(beat(15, 'standby'), now)).toBe('healthy'); // active-window boundary
  });

  it('idle: a recent [watchdog] beat is alive-but-resting, NOT active', () => {
    expect(agentLiveness(beat(5, '[watchdog] builder2 alive — idle session'), now)).toBe('idle');
  });

  it('idle: an agent beat older than the active window but within the idle window', () => {
    expect(agentLiveness(beat(60), now)).toBe('idle');
    expect(agentLiveness(beat(150), now)).toBe('idle'); // idle-window boundary
  });

  it('stale: no beat within the idle window — even the 50-min watchdog stopped', () => {
    expect(agentLiveness(beat(151, '[watchdog] alive'), now)).toBe('stale');
    expect(agentLiveness(beat(600), now)).toBe('stale');
  });

  it('stale: an unparseable timestamp', () => {
    expect(agentLiveness({ last_heartbeat: 'not-a-date' }, now)).toBe('stale');
  });

  it('THE FIX: a 50-min-old watchdog beat (daemon proving the process alive) is idle, not stale', () => {
    expect(agentLiveness(beat(50, '[watchdog] mike alive — idle session'), now)).toBe('idle');
  });
});

describe('isWatchdogStatus', () => {
  it('detects the daemon watchdog prefix', () => {
    expect(isWatchdogStatus('[watchdog] x alive')).toBe(true);
    expect(isWatchdogStatus('working on a task')).toBe(false);
    expect(isWatchdogStatus(undefined)).toBe(false);
    expect(isWatchdogStatus(null)).toBe(false);
    expect(isWatchdogStatus('')).toBe(false);
  });
});
