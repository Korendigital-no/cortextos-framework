// Norwegian VAT helpers. Stored in DB as net + vat; the brutto/netto toggle in
// the UI is convenience only. Math runs in NOK (not øre) since the rest of the
// accounting module already uses REAL — that's the source of truth for now.

export const NORWEGIAN_VAT_RATES = [
  { value: 25, label: '25% (standard)' },
  { value: 15, label: '15% (mat)' },
  { value: 12, label: '12% (transport / hotell)' },
  { value: 0, label: '0% (visse tjenester / unntak)' },
] as const;

export type NorwegianVatRate = (typeof NORWEGIAN_VAT_RATES)[number]['value'];

/**
 * Split a gross amount into net + VAT for a given rate.
 *
 * Both outputs are rounded to 2 decimals. The rounding scheme guarantees
 * net + vat === gross exactly (so totals reconcile): we round net first,
 * then derive vat = gross - net. The trade-off is that vat is the field
 * that absorbs the rounding residual, which matches typical Norwegian
 * accounting practice (net is the primary figure).
 */
export function netFromGross(
  gross: number,
  ratePct: number,
): { net_nok: number; vat_nok: number } {
  if (!isFinite(gross) || gross < 0) {
    return { net_nok: 0, vat_nok: 0 };
  }
  if (ratePct === 0) {
    const r = round2(gross);
    return { net_nok: r, vat_nok: 0 };
  }
  const net = round2(gross / (1 + ratePct / 100));
  const vat = round2(gross - net);
  return { net_nok: net, vat_nok: vat };
}

function round2(n: number): number {
  // Use string-via-toFixed to avoid IEEE-754 banker's-rounding surprises on
  // values like 1.005 → 1.00. toFixed(2) does half-away-from-zero on most JS
  // engines, which is what NOK accounting expects.
  return Number(n.toFixed(2));
}
