import { describe, it, expect } from 'vitest';
import {
  isSelfInflictedStale, isWatchdogHeartbeat, shouldFireIdleWatchdog, staleThresholdsFromEnv,
  circuitAllowsRestart, recordCircuitRestart, formatStaleDetectorArmed,
  DEFAULT_STALE_THRESHOLDS, STALE_CIRCUIT_MAX, STALE_CIRCUIT_WINDOW_MS,
} from '../../../src/daemon/stale-detector.js';

/**
 * Self-inflicted-stale detector (malformed-tool-call hang — analyst writeup,
 * 3 recurrences). The defining signature: prompts keep going IN while no
 * AGENT-originated heartbeat comes OUT.
 */
describe('isSelfInflictedStale', () => {
  const T0 = 1_000_000_000_000;
  const MIN = 60_000;
  const base = { lastAgentBeatMs: T0, sessionStartMs: T0 - 120 * MIN };

  it('fires on the analyst signature: many dropped prompts + long silence', () => {
    expect(isSelfInflictedStale({
      ...base, injectionsSinceAgentBeat: 6, nowMs: T0 + 46 * MIN,
    })).toBe(true);
  });

  it('never fires on injections alone — a burst right after a real beat is healthy', () => {
    expect(isSelfInflictedStale({
      ...base, injectionsSinceAgentBeat: 20, nowMs: T0 + 10 * MIN,
    })).toBe(false);
  });

  it('never fires on silence alone — a quiet night with no prompts is not degradation', () => {
    expect(isSelfInflictedStale({
      ...base, injectionsSinceAgentBeat: 2, nowMs: T0 + 600 * MIN,
    })).toBe(false);
  });

  it('a fresh session gets its full window to boot before it can trip', () => {
    const sessionStart = T0 + 100 * MIN;
    expect(isSelfInflictedStale({
      injectionsSinceAgentBeat: 10,
      lastAgentBeatMs: 0,          // never beaten yet
      sessionStartMs: sessionStart,
      nowMs: sessionStart + 30 * MIN, // < 45 min window
    })).toBe(false);
    expect(isSelfInflictedStale({
      injectionsSinceAgentBeat: 10,
      lastAgentBeatMs: 0,
      sessionStartMs: sessionStart,
      nowMs: sessionStart + 46 * MIN,
    })).toBe(true);
  });
});

describe('isWatchdogHeartbeat', () => {
  it('daemon idle-watchdog beats never reset the detector', () => {
    expect(isWatchdogHeartbeat('[watchdog] analyst alive — idle session 2026-06-05T20:00:00Z')).toBe(true);
    expect(isWatchdogHeartbeat('working on PR #69')).toBe(false);
  });
});

describe('shouldFireIdleWatchdog', () => {
  const INTERVAL = 50 * 60 * 1000;
  const now = 1_000_000_000_000;
  const iso = (ms: number) => new Date(ms).toISOString();

  it('SKIPS when a fresh agent beat is within the window', () => {
    const hb = { status: 'working on PR #69', last_heartbeat: iso(now - 10 * 60 * 1000) };
    expect(shouldFireIdleWatchdog(hb, now, INTERVAL)).toBe(false);
  });

  it('FIRES when the latest agent beat is older than the window (genuine idle)', () => {
    const hb = { status: 'working on PR #69', last_heartbeat: iso(now - 60 * 60 * 1000) };
    expect(shouldFireIdleWatchdog(hb, now, INTERVAL)).toBe(true);
  });

  it('FIRES when the only recent beat is the daemon\'s own [watchdog] writer', () => {
    const hb = { status: '[watchdog] agent alive — idle session', last_heartbeat: iso(now - 1000) };
    expect(shouldFireIdleWatchdog(hb, now, INTERVAL)).toBe(true);
  });

  it('honors the legacy `timestamp` field when last_heartbeat is absent (skips on fresh legacy beat)', () => {
    const hb = { status: 'working', timestamp: iso(now - 5 * 60 * 1000) };
    expect(shouldFireIdleWatchdog(hb, now, INTERVAL)).toBe(false);
    const stale = { status: 'working', timestamp: iso(now - 60 * 60 * 1000) };
    expect(shouldFireIdleWatchdog(stale, now, INTERVAL)).toBe(true);
  });

  it('FIRES when there is no heartbeat record or it is unparseable', () => {
    expect(shouldFireIdleWatchdog(null, now, INTERVAL)).toBe(true);
    expect(shouldFireIdleWatchdog({ status: 'x', last_heartbeat: 'not-a-date' }, now, INTERVAL)).toBe(true);
    expect(shouldFireIdleWatchdog({}, now, INTERVAL)).toBe(true);
  });

  it('fires exactly at the interval boundary (>= interval)', () => {
    const hb = { status: 'busy', last_heartbeat: iso(now - INTERVAL) };
    expect(shouldFireIdleWatchdog(hb, now, INTERVAL)).toBe(true);
  });
});

describe('staleThresholdsFromEnv', () => {
  it('defaults without env; env overrides parse with guards', () => {
    expect(staleThresholdsFromEnv({})).toEqual(DEFAULT_STALE_THRESHOLDS);
    expect(staleThresholdsFromEnv({ CTX_STALE_MIN_INJECTIONS: '4', CTX_STALE_WINDOW_MIN: '30' }))
      .toEqual({ minInjections: 4, windowMs: 30 * 60_000 });
    expect(staleThresholdsFromEnv({ CTX_STALE_MIN_INJECTIONS: '-1', CTX_STALE_WINDOW_MIN: 'abc' }))
      .toEqual(DEFAULT_STALE_THRESHOLDS);
  });
});

describe('stale circuit breaker', () => {
  const T0 = 1_000_000_000_000;

  it('allows up to MAX restarts in the window, then opens', () => {
    let c = { restarts: [] as number[] };
    for (let i = 0; i < STALE_CIRCUIT_MAX; i++) {
      expect(circuitAllowsRestart(c, T0 + i)).toBe(true);
      c = recordCircuitRestart(c, T0 + i);
    }
    expect(circuitAllowsRestart(c, T0 + STALE_CIRCUIT_MAX)).toBe(false);
  });

  it('old restarts age out of the window', () => {
    let c = { restarts: [] as number[] };
    for (let i = 0; i < STALE_CIRCUIT_MAX; i++) c = recordCircuitRestart(c, T0);
    expect(circuitAllowsRestart(c, T0 + 1)).toBe(false);
    expect(circuitAllowsRestart(c, T0 + STALE_CIRCUIT_WINDOW_MS + 1)).toBe(true);
  });
});

describe('formatStaleDetectorArmed (greppable init line)', () => {
  it('is a single greppable line carrying the active thresholds', () => {
    const line = formatStaleDetectorArmed(DEFAULT_STALE_THRESHOLDS);
    expect(line).toContain('stale-detector armed');
    expect(line).toContain(`minInjections=${DEFAULT_STALE_THRESHOLDS.minInjections}`);
    expect(line).toContain(`window=${Math.round(DEFAULT_STALE_THRESHOLDS.windowMs / 60_000)}min`);
    expect(line).toContain(
      `circuit=${STALE_CIRCUIT_MAX} restarts/${Math.round(STALE_CIRCUIT_WINDOW_MS / 3_600_000)}h`,
    );
    expect(line.split('\n')).toHaveLength(1); // one line → one grep
  });

  it('reflects custom thresholds rather than hardcoding defaults', () => {
    const line = formatStaleDetectorArmed({ minInjections: 9, windowMs: 30 * 60_000 });
    expect(line).toContain('minInjections=9');
    expect(line).toContain('window=30min');
  });
});
