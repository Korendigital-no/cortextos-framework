/**
 * Approval-gate scaffold (WS1 finding #4). Pins the classification + satisfaction
 * logic a future PreToolUse hook would enforce. NOT wired — see
 * deliverables/core-hardening-design-2026-06-10.md.
 */

import { describe, it, expect } from 'vitest';
import { classifyCommand, isApprovalSatisfied } from '../../../src/bus/approval-gate';
import type { Approval } from '../../../src/types/index';

describe('classifyCommand', () => {
  it('classifies gated high-blast-radius actions', () => {
    expect(classifyCommand('cortextos bus send-telegram 123 "hi"')).toBe('external-comms');
    expect(classifyCommand('git push origin main')).toBe('deployment');
    expect(classifyCommand('vercel deploy --prod')).toBe('deployment');
    expect(classifyCommand('rm -rf /some/dir')).toBe('data-deletion');
    expect(classifyCommand('psql -c "DROP TABLE leads"')).toBe('data-deletion');
    expect(classifyCommand('stripe charge create --amount 5000')).toBe('financial');
  });

  it('is CONSERVATIVE — unrecognized commands are not gated (no fleet-freeze)', () => {
    expect(classifyCommand('cortextos bus send-message builder normal "hi"')).toBeNull();
    expect(classifyCommand('git push origin feat/my-branch')).toBeNull(); // not main
    expect(classifyCommand('ls -la')).toBeNull();
    expect(classifyCommand('npm test')).toBeNull();
    expect(classifyCommand('cat secrets.env')).toBeNull();
  });
});

describe('isApprovalSatisfied', () => {
  const now = Date.parse('2026-06-10T12:00:00Z');
  const base: Approval = {
    id: 'a1', title: 't', requesting_agent: 'builder2', org: 'korendigital',
    category: 'external-comms', status: 'approved', description: 'd',
    created_at: '2026-06-10T11:30:00Z', updated_at: '2026-06-10T11:45:00Z',
    resolved_at: '2026-06-10T11:45:00Z', resolved_by: 'vilhelm',
  };

  it('accepts a fresh, approved, matching approval', () => {
    expect(isApprovalSatisfied('external-comms', 'builder2', [base], now)).toBe(true);
  });

  it('rejects wrong category / agent / status', () => {
    expect(isApprovalSatisfied('financial', 'builder2', [base], now)).toBe(false);
    expect(isApprovalSatisfied('external-comms', 'mike', [base], now)).toBe(false);
    expect(isApprovalSatisfied('external-comms', 'builder2', [{ ...base, status: 'pending' }], now)).toBe(false);
    expect(isApprovalSatisfied('external-comms', 'builder2', [{ ...base, status: 'rejected' }], now)).toBe(false);
  });

  it('rejects a stale approval beyond the freshness window (no replay)', () => {
    const stale = { ...base, resolved_at: '2026-06-10T10:00:00Z' }; // 2h old
    expect(isApprovalSatisfied('external-comms', 'builder2', [stale], now)).toBe(false);
  });

  it('rejects an unresolved (null resolved_at) or unparseable timestamp', () => {
    expect(isApprovalSatisfied('external-comms', 'builder2', [{ ...base, resolved_at: null }], now)).toBe(false);
    expect(isApprovalSatisfied('external-comms', 'builder2', [{ ...base, resolved_at: 'not-a-date' }], now)).toBe(false);
  });
});
