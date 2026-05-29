import { describe, expect, it } from 'vitest';
import { netFromGross, NORWEGIAN_VAT_RATES } from '@/lib/accounting/vat';

describe('netFromGross', () => {
  it('splits 125 @ 25% into 100 + 25', () => {
    expect(netFromGross(125, 25)).toEqual({ net_nok: 100, vat_nok: 25 });
  });

  it('splits 115 @ 15% into 100 + 15', () => {
    expect(netFromGross(115, 15)).toEqual({ net_nok: 100, vat_nok: 15 });
  });

  it('splits 112 @ 12% into 100 + 12', () => {
    expect(netFromGross(112, 12)).toEqual({ net_nok: 100, vat_nok: 12 });
  });

  it('treats 0% as pass-through (no VAT)', () => {
    expect(netFromGross(100, 0)).toEqual({ net_nok: 100, vat_nok: 0 });
    expect(netFromGross(99.99, 0)).toEqual({ net_nok: 99.99, vat_nok: 0 });
  });

  it('guarantees net + vat === gross for amounts that split cleanly', () => {
    for (const rate of NORWEGIAN_VAT_RATES) {
      for (const gross of [125, 1000, 25000, 0.01, 9999.99]) {
        const { net_nok, vat_nok } = netFromGross(gross, rate.value);
        expect(Math.abs(net_nok + vat_nok - gross)).toBeLessThan(0.011);
      }
    }
  });

  it('handles awkward decimals with consistent rounding', () => {
    // 119.99 / 1.25 = 95.992 → rounds to 95.99, vat = 24.00
    const result = netFromGross(119.99, 25);
    expect(result.net_nok + result.vat_nok).toBeCloseTo(119.99, 2);
  });

  it('returns zeros for invalid input', () => {
    expect(netFromGross(NaN, 25)).toEqual({ net_nok: 0, vat_nok: 0 });
    expect(netFromGross(-100, 25)).toEqual({ net_nok: 0, vat_nok: 0 });
    expect(netFromGross(Infinity, 25)).toEqual({ net_nok: 0, vat_nok: 0 });
  });

  it('rounds large amounts cleanly', () => {
    expect(netFromGross(12500, 25)).toEqual({ net_nok: 10000, vat_nok: 2500 });
    expect(netFromGross(11500, 15)).toEqual({ net_nok: 10000, vat_nok: 1500 });
  });
});
