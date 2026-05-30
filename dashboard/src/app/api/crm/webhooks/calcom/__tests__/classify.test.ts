import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';
import { classifyCalcomWebhook } from '../classify';

/**
 * Source-based test isolation at ingestion (#5).
 *
 * A Cal.com webhook is classified by WHICH secret signed it:
 *   - signed with the prod secret  → { valid: true,  isTest: false }
 *   - signed with the test secret  → { valid: true,  isTest: true  }
 *   - signed with neither / no sig → { valid: false, isTest: false }
 *
 * The test secret is optional: when CALCOM_TEST_WEBHOOK_SECRET is unset, only
 * the prod secret is accepted and isTest is always false. Comparison is
 * constant-time and the prod secret is checked first, so a real booking is
 * never misclassified as a test.
 */
function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

const PROD = 'prod-secret-aaaaaaaaaaaaaaaaaaaa';
const TEST = 'test-secret-bbbbbbbbbbbbbbbbbbbb';
const body = JSON.stringify({ triggerEvent: 'BOOKING_CREATED', payload: { bookingId: '1' } });

describe('classifyCalcomWebhook', () => {
  it('accepts a prod-signed request as a real (non-test) webhook', () => {
    expect(classifyCalcomWebhook(body, sign(body, PROD), PROD, TEST)).toEqual({ valid: true, isTest: false });
  });

  it('accepts a test-signed request and flags it as test', () => {
    expect(classifyCalcomWebhook(body, sign(body, TEST), PROD, TEST)).toEqual({ valid: true, isTest: true });
  });

  it('rejects a request signed with an unknown secret', () => {
    expect(classifyCalcomWebhook(body, sign(body, 'wrong'), PROD, TEST)).toEqual({ valid: false, isTest: false });
  });

  it('rejects a request with no signature', () => {
    expect(classifyCalcomWebhook(body, null, PROD, TEST)).toEqual({ valid: false, isTest: false });
  });

  it('accepts prod signature when no test secret is configured', () => {
    expect(classifyCalcomWebhook(body, sign(body, PROD), PROD, undefined)).toEqual({ valid: true, isTest: false });
  });

  it('never treats a prod-signed request as test even if it equals the test path', () => {
    // prod checked first; a body validly prod-signed is real.
    expect(classifyCalcomWebhook(body, sign(body, PROD), PROD, TEST).isTest).toBe(false);
  });

  it('does not throw on a signature whose length differs from the digest', () => {
    expect(classifyCalcomWebhook(body, 'abc', PROD, TEST)).toEqual({ valid: false, isTest: false });
  });
});
