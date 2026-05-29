import { describe, it, expect } from 'vitest';
import {
  validateMeasurementMeta,
  aggregateMeasurements,
  formatMeasurementReport,
  GUARANTEE_WEEKLY_HOURS,
  type MeasurementMeta,
} from '../../../src/bus/measurement';

function ev(overrides: Partial<MeasurementMeta> = {}): MeasurementMeta {
  return {
    client_id: '912345678',
    agent_id: 'booking-agent',
    task_type: 'booking',
    completed_at: '2026-05-25T09:00:00Z',
    human_touch_required: false,
    human_touch_seconds: 0,
    baseline_seconds_per_task: 600, // 10 min baseline
    outcome: 'completed',
    ...overrides,
  };
}

describe('validateMeasurementMeta', () => {
  it('accepts a well-formed event', () => {
    expect(() => validateMeasurementMeta(ev())).not.toThrow();
  });

  it('rejects missing client_id', () => {
    expect(() => validateMeasurementMeta(ev({ client_id: '' }))).toThrow(/client_id/);
  });

  it('rejects a bad outcome', () => {
    expect(() => validateMeasurementMeta(ev({ outcome: 'maybe' as never }))).toThrow(/outcome/);
  });

  it('rejects negative human_touch_seconds (would inflate savings)', () => {
    expect(() => validateMeasurementMeta(ev({ human_touch_seconds: -10 }))).toThrow(/human_touch_seconds/);
  });

  it('rejects negative baseline', () => {
    expect(() => validateMeasurementMeta(ev({ baseline_seconds_per_task: -1 }))).toThrow(/baseline_seconds_per_task/);
  });

  it('rejects non-boolean human_touch_required', () => {
    expect(() => validateMeasurementMeta(ev({ human_touch_required: 'yes' as never }))).toThrow(/human_touch_required/);
  });

  it('rejects an invalid baseline_confidence', () => {
    expect(() => validateMeasurementMeta(ev({ baseline_confidence: 'guess' as never }))).toThrow(/baseline_confidence/);
  });

  it('rejects a path-traversal agent_id (agent_id becomes a filesystem path)', () => {
    // log-measurement --agent flows into analyticsDir/events/{agent_id}/...;
    // a traversal value must be rejected before it can escape the tree.
    expect(() => validateMeasurementMeta(ev({ agent_id: '../../../../tmp/evil' }))).toThrow();
    expect(() => validateMeasurementMeta(ev({ agent_id: 'has spaces' }))).toThrow();
    expect(() => validateMeasurementMeta(ev({ agent_id: 'UPPER' }))).toThrow();
  });

  it('accepts a normal agent_id', () => {
    expect(() => validateMeasurementMeta(ev({ agent_id: 'booking-agent_1' }))).not.toThrow();
  });
});

describe('aggregateMeasurements', () => {
  const win = { client_id: '912345678', window_start: '2026-05-25', window_end: '2026-05-31' };

  it('computes net time saved = gross baseline − human touch', () => {
    // 20 completed tasks, 10 min baseline each = 200 min gross; 2 min human each on 5 of them.
    const events: MeasurementMeta[] = [
      ...Array.from({ length: 15 }, () => ev()),
      ...Array.from({ length: 5 }, () => ev({ human_touch_required: true, human_touch_seconds: 120 })),
    ];
    const r = aggregateMeasurements(events, win);
    expect(r.tasks_completed).toBe(20);
    expect(r.gross_baseline_seconds).toBe(20 * 600); // 12000
    expect(r.human_touch_seconds).toBe(5 * 120); // 600
    expect(r.time_saved_seconds).toBe(12000 - 600); // 11400
    // All within one ISO week → per-week == window total.
    expect(r.weeks).toBe(1);
    expect(r.time_saved_per_week_hours).toBeCloseTo(11400 / 3600, 5); // ~3.17 h
    expect(r.guarantee_met).toBe(true); // > 2.0
  });

  it('only completed tasks count; escalated/failed are tracked separately', () => {
    const events: MeasurementMeta[] = [
      ev(),
      ev({ outcome: 'escalated_to_human' }),
      ev({ outcome: 'failed' }),
    ];
    const r = aggregateMeasurements(events, win);
    expect(r.tasks_completed).toBe(1);
    expect(r.tasks_escalated).toBe(1);
    expect(r.tasks_failed).toBe(1);
    expect(r.gross_baseline_seconds).toBe(600); // only the completed one
  });

  it('flags guarantee NOT met when under 2 t/uke', () => {
    // 5 tasks × 10 min = 50 min saved < 2 h.
    const r = aggregateMeasurements(Array.from({ length: 5 }, () => ev()), win);
    expect(r.time_saved_per_week_hours).toBeLessThan(GUARANTEE_WEEKLY_HOURS);
    expect(r.guarantee_met).toBe(false);
  });

  it('scales per-week by REQUESTED window duration, not events touched', () => {
    // A true two-week window (14 days) → per-week is the window total / 2.
    const events: MeasurementMeta[] = [
      ...Array.from({ length: 20 }, () => ev({ completed_at: '2026-05-25T09:00:00Z' })),
      ...Array.from({ length: 20 }, () => ev({ completed_at: '2026-06-02T09:00:00Z' })),
    ];
    const r = aggregateMeasurements(events, { client_id: win.client_id, window_start: '2026-05-25', window_end: '2026-06-08' });
    expect(r.weeks).toBe(2);
    expect(r.tasks_completed).toBe(40);
    // 40 × 10 min = 400 min total = 6.667 h over 2 weeks → 3.33 h/week.
    expect(r.time_saved_per_week_hours).toBeCloseTo(40 * 600 / 3600 / 2, 5);
  });

  it('a 7-day window straddling an ISO week boundary counts as ONE week (regression)', () => {
    // Thu 2026-05-28 → Thu 2026-06-04 is exactly 7 days but crosses the Mon
    // 2026-06-01 ISO boundary. It must NOT be treated as 2 weeks (which would
    // halve the figure and falsely fail the 2 t/uke guarantee).
    const events: MeasurementMeta[] = [
      ...Array.from({ length: 7 }, () => ev({ completed_at: '2026-05-29T09:00:00Z' })), // before boundary
      ...Array.from({ length: 7 }, () => ev({ completed_at: '2026-06-03T09:00:00Z' })), // after boundary
    ];
    const r = aggregateMeasurements(events, { client_id: win.client_id, window_start: '2026-05-28', window_end: '2026-06-04' });
    expect(r.weeks).toBe(1);
    // 14 × 10 min = 140 min = 2.333 h, all attributed to the single week.
    expect(r.time_saved_per_week_hours).toBeCloseTo(14 * 600 / 3600, 5);
    expect(r.guarantee_met).toBe(true); // 2.33 ≥ 2.0 — would be FALSE (1.17) under the ISO-week bug
  });

  it('does not extrapolate a sub-week window upward (floored at 1 week)', () => {
    // 3-day window with 1.5 h saved → reported as 1.5 h/week, not 3.5 h/week.
    const events = Array.from({ length: 9 }, () => ev()); // 9 × 10 min = 90 min = 1.5 h
    const r = aggregateMeasurements(events, { client_id: win.client_id, window_start: '2026-05-25', window_end: '2026-05-28' });
    expect(r.weeks).toBe(1);
    expect(r.time_saved_per_week_hours).toBeCloseTo(1.5, 5);
    expect(r.guarantee_met).toBe(false);
  });

  it('reports the confidence FLOOR, not the average', () => {
    const events: MeasurementMeta[] = [
      ev({ baseline_confidence: 'high' }),
      ev({ baseline_confidence: 'low' }),
      ev({ baseline_confidence: 'high' }),
    ];
    expect(aggregateMeasurements(events, win).confidence).toBe('low');
  });

  it('defaults baseline confidence to medium when unset', () => {
    expect(aggregateMeasurements([ev()], win).confidence).toBe('medium');
  });

  it('handles an empty window without dividing by zero', () => {
    const r = aggregateMeasurements([], win);
    expect(r.tasks_completed).toBe(0);
    expect(r.time_saved_per_task_seconds).toBe(0);
    expect(r.time_saved_per_week_hours).toBe(0);
    expect(r.guarantee_met).toBe(false);
    expect(r.confidence).toBe('low');
  });

  it('subtracts human touch so an agent that escalates everything saves ~nothing', () => {
    // Completed but each took as long as baseline in human review → net 0.
    const events = Array.from({ length: 10 }, () => ev({ human_touch_required: true, human_touch_seconds: 600 }));
    const r = aggregateMeasurements(events, win);
    expect(r.time_saved_seconds).toBe(0);
    expect(r.guarantee_met).toBe(false);
  });
});

describe('formatMeasurementReport', () => {
  it('renders MET and NOT MET verdicts', () => {
    const win = { client_id: '912345678', window_start: '2026-05-25', window_end: '2026-05-31' };
    const met = formatMeasurementReport(aggregateMeasurements(Array.from({ length: 20 }, () => ev()), win));
    expect(met).toContain('MET');
    expect(met).toContain('912345678');
    const notMet = formatMeasurementReport(aggregateMeasurements([ev()], win));
    expect(notMet).toContain('NOT MET');
  });
});
