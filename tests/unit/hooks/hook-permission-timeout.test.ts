/**
 * Regression: hook-permission-telegram timeout was 1800s (30 min), which
 * at 5-min cron cadence allows 6 injections to accumulate before the stale
 * detector's 45-min window closes — racing the detector into a false restart.
 *
 * Fix: reduce to 300s (1 cron cycle). This test is the canary so the 30-min
 * value cannot be accidentally restored.
 */
import { describe, it, expect } from 'vitest';
import { PERMISSION_TIMEOUT_MS } from '../../../src/hooks/hook-permission-telegram.js';

describe('hook-permission-telegram: approval timeout', () => {
  it('is at most 300s (1 cron cycle) to prevent stale-detector race', () => {
    expect(PERMISSION_TIMEOUT_MS).toBeLessThanOrEqual(300 * 1000);
  });

  it('is at least 60s (enough for user to see and respond on mobile)', () => {
    expect(PERMISSION_TIMEOUT_MS).toBeGreaterThanOrEqual(60 * 1000);
  });

  it('is exactly 300s (5 min — the canonical value from SEC-STALE-v1)', () => {
    expect(PERMISSION_TIMEOUT_MS).toBe(300 * 1000);
  });
});
