/**
 * Tests for the per-project billable resolution (src/lib/billable.ts).
 * Pins the inherit/override rule: project carries the default, each entry may
 * override with 0/1, NULL inherits.
 */

import { describe, it, expect } from 'vitest';
import { effectiveBillable, splitBillableHours, normalizeBillable, type HoursEntry } from '@/lib/billable';

describe('normalizeBillable — wire value -> stored override', () => {
  it('maps truthy billable signals to 1', () => {
    expect(normalizeBillable(1)).toBe(1);
    expect(normalizeBillable(true)).toBe(1);
  });
  it('maps falsy billable signals to 0', () => {
    expect(normalizeBillable(0)).toBe(0);
    expect(normalizeBillable(false)).toBe(0);
  });
  it('maps anything else to null (inherit)', () => {
    expect(normalizeBillable(null)).toBe(null);
    expect(normalizeBillable(undefined)).toBe(null);
    expect(normalizeBillable('yes')).toBe(null);
    expect(normalizeBillable(2)).toBe(null);
  });
});

describe('effectiveBillable — entry override on top of project default', () => {
  it('inherits the project default when the entry has no override (null)', () => {
    expect(effectiveBillable(null, 1)).toBe(true);
    expect(effectiveBillable(null, 0)).toBe(false);
  });

  it('inherits when override is undefined', () => {
    expect(effectiveBillable(undefined, 1)).toBe(true);
    expect(effectiveBillable(undefined, 0)).toBe(false);
  });

  it('entry override wins over the project default', () => {
    expect(effectiveBillable(0, 1)).toBe(false); // billable project, non-billable entry
    expect(effectiveBillable(1, 0)).toBe(true); // non-billable project, billable entry
  });

  it('defaults to billable for a client-level entry with unset project default', () => {
    expect(effectiveBillable(null, null)).toBe(true);
    expect(effectiveBillable(null, undefined)).toBe(true);
  });
});

describe('splitBillableHours — totals split for a project', () => {
  it('splits entries by effective billability using the project default', () => {
    const entries: HoursEntry[] = [
      { hours: 2, billable: null },   // inherit -> billable
      { hours: 3, billable: 0 },      // override -> non-billable
      { hours: 1.5, billable: 1 },    // override -> billable
    ];
    const split = splitBillableHours(entries, 1);
    expect(split.billableHours).toBe(3.5);
    expect(split.nonBillableHours).toBe(3);
    expect(split.totalHours).toBe(6.5);
  });

  it('a non-billable project makes inherited entries non-billable', () => {
    const entries: HoursEntry[] = [
      { hours: 4, billable: null },   // inherit -> non-billable
      { hours: 2, billable: 1 },      // override -> billable
    ];
    const split = splitBillableHours(entries, 0);
    expect(split.billableHours).toBe(2);
    expect(split.nonBillableHours).toBe(4);
  });

  it('rounds away float dust', () => {
    const split = splitBillableHours([{ hours: 0.1 }, { hours: 0.2 }], 1);
    expect(split.billableHours).toBe(0.3);
  });

  it('handles an empty list', () => {
    expect(splitBillableHours([], 1)).toEqual({ billableHours: 0, nonBillableHours: 0, totalHours: 0 });
  });
});
