import { createHmac, timingSafeEqual } from 'crypto';

function signatureMatches(body: string, signature: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

/**
 * Source-based test isolation (#5). Classify a Cal.com webhook by WHICH secret
 * signed it:
 *   - prod secret → { valid: true,  isTest: false }
 *   - test secret → { valid: true,  isTest: true  }
 *   - neither     → { valid: false, isTest: false }
 *
 * The prod secret is checked first so a real booking is never misclassified as
 * a test. The test secret is optional; when unset, only prod is accepted. A
 * test-signed booking is stamped crm_webhook_log.is_test=1; the framework queue
 * processor propagates that to the CRM rows it creates, suppresses the sales
 * notification, and prod cron surfaces filter it out — so E2E can exercise the
 * full webhook→CRM pipeline without polluting the live pipeline or sales inbox.
 *
 * Pure (crypto only, no Next/db imports) so it is unit-testable in isolation.
 */
export function classifyCalcomWebhook(
  body: string,
  signature: string | null,
  prodSecret: string,
  testSecret: string | undefined,
): { valid: boolean; isTest: boolean } {
  if (!signature) return { valid: false, isTest: false };
  if (signatureMatches(body, signature, prodSecret)) return { valid: true, isTest: false };
  if (testSecret && signatureMatches(body, signature, testSecret)) return { valid: true, isTest: true };
  return { valid: false, isTest: false };
}
