// Realistic stub data for development when FIKEN_API_TOKEN is not set.
// Mirrors actual Fiken API shape so the UI works end-to-end without the real token.

import type { FikenInvoice, FikenPurchase } from './types';

const today = new Date();
const daysAgo = (n: number): string => {
  const d = new Date(today);
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
};

export const STUB_INVOICES: FikenInvoice[] = [
  { invoiceId: 1001, invoiceNumber: '2026-001', issueDate: daysAgo(45), dueDate: daysAgo(15), net: 4400000, vat: 1100000, gross: 5500000, settled: true, currency: 'NOK', customer: { name: 'Vidda Solutions AS' } },
  { invoiceId: 1002, invoiceNumber: '2026-002', issueDate: daysAgo(30), dueDate: daysAgo(0), net: 3300000, vat: 825000, gross: 4125000, settled: true, currency: 'NOK', customer: { name: 'TCRhomedesign' } },
  { invoiceId: 1003, invoiceNumber: '2026-003', issueDate: daysAgo(20), dueDate: daysAgo(-10), net: 5500000, vat: 1375000, gross: 6875000, settled: false, currency: 'NOK', customer: { name: 'Vidda Solutions AS' } },
  { invoiceId: 1004, invoiceNumber: '2026-004', issueDate: daysAgo(5), dueDate: daysAgo(-25), net: 2200000, vat: 550000, gross: 2750000, settled: false, currency: 'NOK', customer: { name: 'Alpha Økonomi' } },
];

export const STUB_PURCHASES: FikenPurchase[] = [
  { transactionId: 2001, date: daysAgo(40), kind: 'INVOICE', paid: true, supplier: { name: 'Anthropic' }, lines: [{ account: '6540', vatType: 'OUTSIDE', net: 25000, vat: 0, gross: 25000, description: 'Claude API' }] },
  { transactionId: 2002, date: daysAgo(35), kind: 'RECEIPT', paid: true, supplier: { name: 'OpenAI' }, lines: [{ account: '6540', vatType: 'OUTSIDE', net: 20000, vat: 0, gross: 20000, description: 'ChatGPT Plus' }] },
  { transactionId: 2003, date: daysAgo(15), kind: 'INVOICE', paid: true, supplier: { name: 'Vercel' }, lines: [{ account: '6540', vatType: 'OUTSIDE', net: 20000, vat: 0, gross: 20000, description: 'Hosting' }] },
  { transactionId: 2004, date: daysAgo(10), kind: 'INVOICE', paid: false, supplier: { name: 'Fiken AS' }, lines: [{ account: '6700', vatType: 'HIGH', net: 39900, vat: 9975, gross: 49875, description: 'Fiken abonnement' }] },
  { transactionId: 2005, date: daysAgo(2), kind: 'RECEIPT', paid: true, supplier: { name: 'Cloudflare' }, lines: [{ account: '6540', vatType: 'OUTSIDE', net: 20000, vat: 0, gross: 20000, description: 'Cloudflare Tunnel' }] },
];
