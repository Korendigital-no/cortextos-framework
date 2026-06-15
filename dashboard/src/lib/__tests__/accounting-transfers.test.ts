/**
 * Internal account transfers + owner's draw (privatuttak), against a REAL in-memory
 * dashboard schema (initializeSchema) — proves the financial invariants on the
 * actual DDL, not a hand-written stub:
 *  - net-zero: a transfer moves money between accounts without creating or
 *    destroying it (the sum of balances across accounts is unchanged).
 *  - owner's draw: a transfer to the tag-only 'personal' account subtracts from
 *    the source; personal's balance stays force-zeroed.
 *  - P&L stays clean: transfers never touch invoices/expenses, so revenue/costs
 *    are unaffected (a transfer is neither income nor cost).
 *  - schema guards: amount must be > 0, from <> to, both accounts must exist (FK).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../schema';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initializeSchema(db);
});

const NOW = '2026-06-01T00:00:00Z';

function seedAccount(id: string, type: string, name: string, start = 0): void {
  db.prepare(
    'INSERT INTO accounting_accounts (id, name, type, starting_balance_nok, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, name, type, start, NOW, NOW);
}

function recordTransfer(from: string, to: string, amount: number, kind = 'transfer'): void {
  const id = 't-' + Math.random().toString(36).slice(2);
  db.prepare(
    'INSERT INTO accounting_transfers (id, from_account_id, to_account_id, amount_nok, date, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, from, to, amount, '2026-06-01', kind, NOW, NOW);
}

// Mirror of the balance formula in /api/accounting/accounts/route.ts (GET) — MUST
// match it: 'personal' is force-zeroed; every other account is starting + settled
// invoices - paid expenses + transfers in - transfers out.
function balanceOf(id: string): number {
  const a = db.prepare('SELECT type, starting_balance_nok FROM accounting_accounts WHERE id = ?').get(id) as {
    type: string;
    starting_balance_nok: number;
  };
  if (a.type === 'personal') return 0;
  const n = (sql: string) => (db.prepare(sql).get(id) as { v: number }).v;
  const settled = n("SELECT COALESCE(SUM(net_nok+vat_nok),0) v FROM accounting_invoices WHERE account_id = ? AND settled = 1");
  const paid = n("SELECT COALESCE(SUM(net_nok+vat_nok),0) v FROM accounting_expenses WHERE account_id = ? AND paid = 1");
  const tin = n('SELECT COALESCE(SUM(amount_nok),0) v FROM accounting_transfers WHERE to_account_id = ?');
  const tout = n('SELECT COALESCE(SUM(amount_nok),0) v FROM accounting_transfers WHERE from_account_id = ?');
  return a.starting_balance_nok + settled - paid + tin - tout;
}

describe('accounting transfers — balance invariants', () => {
  it('a transfer moves money net-zero across accounts', () => {
    seedAccount('op', 'operating', 'Bedriftskonto', 1000);
    seedAccount('tax', 'tax', 'Skattekonto', 500);
    const totalBefore = balanceOf('op') + balanceOf('tax');
    recordTransfer('op', 'tax', 300);
    expect(balanceOf('op')).toBe(700);
    expect(balanceOf('tax')).toBe(800);
    expect(balanceOf('op') + balanceOf('tax')).toBe(totalBefore); // money conserved
  });

  it('an owner draw subtracts from the source; personal stays zero', () => {
    seedAccount('op', 'operating', 'Bedriftskonto', 1000);
    seedAccount('priv', 'personal', 'Privat', 0);
    recordTransfer('op', 'priv', 200, 'owner_draw');
    expect(balanceOf('op')).toBe(800);
    expect(balanceOf('priv')).toBe(0); // tag-only, force-zeroed
  });

  it('transfers never touch the P&L (revenue and costs unchanged)', () => {
    seedAccount('op', 'operating', 'Bedriftskonto', 1000);
    seedAccount('tax', 'tax', 'Skattekonto', 0);
    const revenue = () => (db.prepare('SELECT COALESCE(SUM(net_nok),0) v FROM accounting_invoices').get() as { v: number }).v;
    const costs = () => (db.prepare('SELECT COALESCE(SUM(net_nok),0) v FROM accounting_expenses').get() as { v: number }).v;
    const rBefore = revenue();
    const cBefore = costs();
    recordTransfer('op', 'tax', 500);
    recordTransfer('op', 'tax', 100, 'owner_draw');
    expect(revenue()).toBe(rBefore); // a transfer is not income
    expect(costs()).toBe(cBefore); // ...and not a cost
  });

  it('rejects a zero or negative amount (CHECK amount_nok > 0)', () => {
    seedAccount('op', 'operating', 'Bedriftskonto', 1000);
    seedAccount('tax', 'tax', 'Skattekonto', 0);
    expect(() => recordTransfer('op', 'tax', 0)).toThrow();
    expect(() => recordTransfer('op', 'tax', -50)).toThrow();
  });

  it('rejects a self-transfer (CHECK from <> to)', () => {
    seedAccount('op', 'operating', 'Bedriftskonto', 1000);
    expect(() => recordTransfer('op', 'op', 100)).toThrow();
  });

  it('rejects a transfer referencing a non-existent account (FK)', () => {
    seedAccount('op', 'operating', 'Bedriftskonto', 1000);
    expect(() => recordTransfer('op', 'ghost', 100)).toThrow();
  });

  // Boundary: the balance formula force-zeroes 'personal', so a PLAIN transfer
  // touching it would NOT conserve the total — the source is debited but the
  // force-zeroed personal side is never credited. This is exactly why the API
  // route rejects kind='transfer' to/from a personal account (money only reaches
  // 'personal' via an owner_draw, which intentionally represents money leaving
  // the business). This test pins that the unguarded SQL movement is non-conserving.
  it('a plain transfer into the personal account does NOT conserve total (why the route restricts personal)', () => {
    seedAccount('op', 'operating', 'Bedriftskonto', 1000);
    seedAccount('priv', 'personal', 'Privat', 0);
    const totalBefore = balanceOf('op') + balanceOf('priv');
    recordTransfer('op', 'priv', 300, 'transfer'); // schema-legal, accounting-invalid
    expect(balanceOf('op')).toBe(700);
    expect(balanceOf('priv')).toBe(0); // force-zeroed → the 300 vanishes from the total
    expect(balanceOf('op') + balanceOf('priv')).not.toBe(totalBefore);
  });
});
