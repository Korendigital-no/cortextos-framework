'use client';

import { useEffect, useState, useCallback } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { IconReceipt, IconTrendingUp, IconTrendingDown, IconCash, IconPlus, IconTrash } from '@tabler/icons-react';

interface PeriodSummary {
  period: string;
  revenue_nok: number; costs_nok: number; profit_nok: number; vat_balance_nok: number;
  invoices_count: number; expenses_count: number;
}

interface SummaryResp { current_month: PeriodSummary; ytd: PeriodSummary; }

interface Invoice {
  id: string; invoiceNumber: string; customer_name: string;
  issueDate: string; dueDate: string | null;
  net_nok: number; vat_nok: number; gross_nok: number; settled: boolean; notes: string | null;
}

interface Expense {
  id: string; supplier_name: string; description: string | null; date: string;
  net_nok: number; vat_nok: number; gross_nok: number; paid: boolean; account: string | null;
}

interface VatStatus {
  period: string; vat_collected_nok: number; vat_paid_nok: number; balance_nok: number;
  direction: 'owed' | 'refundable' | 'zero'; start_date: string; end_date: string;
}

function formatNOK(value: number): string {
  return new Intl.NumberFormat('nb-NO', { style: 'currency', currency: 'NOK', maximumFractionDigits: 0 }).format(value);
}

function formatDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const local = new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
  return local.toLocaleDateString('nb-NO', { day: 'numeric', month: 'short', year: 'numeric' });
}

function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function AccountingPage() {
  const [summary, setSummary] = useState<SummaryResp | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [vat, setVat] = useState<VatStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const [showAddInvoice, setShowAddInvoice] = useState(false);
  const [invForm, setInvForm] = useState({ invoice_number: '', customer_name: '', issue_date: todayLocal(), due_date: '', net_nok: '', vat_nok: '', settled: false });

  const [showAddExpense, setShowAddExpense] = useState(false);
  const [expForm, setExpForm] = useState({ supplier_name: '', description: '', date: todayLocal(), net_nok: '', vat_nok: '', account: '', paid: true });

  const fetchAll = useCallback(async () => {
    try {
      const [sRes, iRes, eRes, vRes] = await Promise.all([
        fetch('/api/accounting/summary'), fetch('/api/accounting/invoices'),
        fetch('/api/accounting/expenses'), fetch('/api/accounting/vat'),
      ]);
      if (sRes.ok) setSummary(await sRes.json());
      if (iRes.ok) setInvoices((await iRes.json()).invoices);
      if (eRes.ok) setExpenses((await eRes.json()).expenses);
      if (vRes.ok) setVat(await vRes.json());
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  async function handleAddInvoice() {
    if (!invForm.invoice_number || !invForm.customer_name || !invForm.net_nok) return;
    await fetch('/api/accounting/invoices', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        invoice_number: invForm.invoice_number, customer_name: invForm.customer_name,
        issue_date: invForm.issue_date, due_date: invForm.due_date || undefined,
        net_nok: parseFloat(invForm.net_nok), vat_nok: invForm.vat_nok ? parseFloat(invForm.vat_nok) : 0,
        settled: invForm.settled,
      }),
    });
    setInvForm({ invoice_number: '', customer_name: '', issue_date: todayLocal(), due_date: '', net_nok: '', vat_nok: '', settled: false });
    setShowAddInvoice(false);
    fetchAll();
  }

  async function handleAddExpense() {
    if (!expForm.supplier_name || !expForm.net_nok) return;
    await fetch('/api/accounting/expenses', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        supplier_name: expForm.supplier_name, description: expForm.description || undefined,
        date: expForm.date, net_nok: parseFloat(expForm.net_nok),
        vat_nok: expForm.vat_nok ? parseFloat(expForm.vat_nok) : 0,
        account: expForm.account || undefined, paid: expForm.paid,
      }),
    });
    setExpForm({ supplier_name: '', description: '', date: todayLocal(), net_nok: '', vat_nok: '', account: '', paid: true });
    setShowAddExpense(false);
    fetchAll();
  }

  async function deleteInvoice(id: string) {
    if (!confirm('Delete invoice?')) return;
    await fetch(`/api/accounting/invoices?id=${id}`, { method: 'DELETE' });
    fetchAll();
  }

  async function deleteExpense(id: string) {
    if (!confirm('Delete expense?')) return;
    await fetch(`/api/accounting/expenses?id=${id}`, { method: 'DELETE' });
    fetchAll();
  }

  async function toggleInvoiceSettled(inv: Invoice) {
    await fetch('/api/accounting/invoices', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: inv.id, settled: !inv.settled }),
    });
    fetchAll();
  }

  async function toggleExpensePaid(exp: Expense) {
    await fetch('/api/accounting/expenses', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: exp.id, paid: !exp.paid }),
    });
    fetchAll();
  }

  if (loading) return <div className="space-y-6"><h1 className="text-2xl font-semibold">Accounting</h1><div className="grid grid-cols-2 gap-4 sm:grid-cols-4">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-24 rounded-xl bg-muted/30 animate-pulse" />)}</div></div>;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Accounting</h1>

      {summary && (
        <div>
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-2">This month</h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div className="rounded-xl border bg-card p-4"><div className="flex items-center justify-between mb-1"><p className="text-xs text-muted-foreground">Revenue</p><IconTrendingUp className="size-4 text-emerald-500" /></div><p className="text-2xl font-semibold text-emerald-600 dark:text-emerald-400">{formatNOK(summary.current_month.revenue_nok)}</p><p className="text-xs text-muted-foreground mt-1">{summary.current_month.invoices_count} invoices</p></div>
            <div className="rounded-xl border bg-card p-4"><div className="flex items-center justify-between mb-1"><p className="text-xs text-muted-foreground">Costs</p><IconTrendingDown className="size-4 text-red-500" /></div><p className="text-2xl font-semibold text-red-600 dark:text-red-400">{formatNOK(summary.current_month.costs_nok)}</p><p className="text-xs text-muted-foreground mt-1">{summary.current_month.expenses_count} expenses</p></div>
            <div className="rounded-xl border bg-card p-4"><div className="flex items-center justify-between mb-1"><p className="text-xs text-muted-foreground">Profit</p><IconCash className="size-4 text-muted-foreground" /></div><p className={`text-2xl font-semibold ${summary.current_month.profit_nok >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>{formatNOK(summary.current_month.profit_nok)}</p></div>
            <div className="rounded-xl border bg-card p-4"><div className="flex items-center justify-between mb-1"><p className="text-xs text-muted-foreground">VAT balance</p><IconReceipt className="size-4 text-muted-foreground" /></div><p className={`text-2xl font-semibold ${summary.current_month.vat_balance_nok > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}`}>{formatNOK(summary.current_month.vat_balance_nok)}</p></div>
          </div>
        </div>
      )}

      {summary && (
        <div>
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-2">Year to date</h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <div className="rounded-xl border bg-card p-4"><p className="text-xs text-muted-foreground">Revenue</p><p className="text-xl font-semibold text-emerald-600 dark:text-emerald-400">{formatNOK(summary.ytd.revenue_nok)}</p></div>
            <div className="rounded-xl border bg-card p-4"><p className="text-xs text-muted-foreground">Costs</p><p className="text-xl font-semibold text-red-600 dark:text-red-400">{formatNOK(summary.ytd.costs_nok)}</p></div>
            <div className="rounded-xl border bg-card p-4"><p className="text-xs text-muted-foreground">Profit</p><p className={`text-xl font-semibold ${summary.ytd.profit_nok >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>{formatNOK(summary.ytd.profit_nok)}</p></div>
          </div>
        </div>
      )}

      {vat && (
        <div>
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-2">VAT period — {vat.period}</h2>
          <div className="rounded-xl border bg-card p-4 grid grid-cols-3 gap-4">
            <div><p className="text-xs text-muted-foreground">Collected (utgående MVA)</p><p className="text-lg font-semibold">{formatNOK(vat.vat_collected_nok)}</p></div>
            <div><p className="text-xs text-muted-foreground">Paid (inngående MVA)</p><p className="text-lg font-semibold">{formatNOK(vat.vat_paid_nok)}</p></div>
            <div><p className="text-xs text-muted-foreground">Balance</p><p className={`text-lg font-semibold ${vat.direction === 'owed' ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}`}>{formatNOK(vat.balance_nok)} {vat.direction === 'owed' ? '(skyldig)' : vat.direction === 'refundable' ? '(til gode)' : ''}</p></div>
          </div>
        </div>
      )}

      <div>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Invoices</h2>
          <Button variant="outline" size="sm" onClick={() => setShowAddInvoice(!showAddInvoice)}><IconPlus className="size-4 mr-1" />Add invoice</Button>
        </div>
        {showAddInvoice && (
          <div className="rounded-lg border bg-card p-4 space-y-3 mb-3">
            <div className="grid grid-cols-2 gap-2">
              <input type="text" placeholder="Invoice number" value={invForm.invoice_number} onChange={e => setInvForm(f => ({ ...f, invoice_number: e.target.value }))} className="rounded-md border bg-background px-3 py-2 text-sm" autoFocus />
              <input type="text" placeholder="Customer" value={invForm.customer_name} onChange={e => setInvForm(f => ({ ...f, customer_name: e.target.value }))} className="rounded-md border bg-background px-3 py-2 text-sm" />
              <input type="date" value={invForm.issue_date} onChange={e => setInvForm(f => ({ ...f, issue_date: e.target.value }))} className="rounded-md border bg-background px-3 py-2 text-sm" />
              <input type="date" placeholder="Due date" value={invForm.due_date} onChange={e => setInvForm(f => ({ ...f, due_date: e.target.value }))} className="rounded-md border bg-background px-3 py-2 text-sm" />
              <input type="number" placeholder="Net NOK" value={invForm.net_nok} onChange={e => setInvForm(f => ({ ...f, net_nok: e.target.value }))} step="0.01" className="rounded-md border bg-background px-3 py-2 text-sm" />
              <input type="number" placeholder="VAT NOK" value={invForm.vat_nok} onChange={e => setInvForm(f => ({ ...f, vat_nok: e.target.value }))} step="0.01" className="rounded-md border bg-background px-3 py-2 text-sm" />
            </div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={invForm.settled} onChange={e => setInvForm(f => ({ ...f, settled: e.target.checked }))} />Settled</label>
            <div className="flex gap-2 justify-end"><Button variant="ghost" size="sm" onClick={() => setShowAddInvoice(false)}>Cancel</Button><Button size="sm" onClick={handleAddInvoice}>Save</Button></div>
          </div>
        )}
        {invoices.length === 0 ? <p className="py-4 text-sm text-muted-foreground">No invoices yet.</p> : (
          <div className="rounded-lg border divide-y">
            {invoices.map(inv => (
              <div key={inv.id} className="flex items-center justify-between px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{inv.invoiceNumber} — {inv.customer_name}</p>
                  <p className="text-xs text-muted-foreground">{formatDate(inv.issueDate)}{inv.dueDate ? ` · due ${formatDate(inv.dueDate)}` : ''}</p>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-sm font-medium">{formatNOK(inv.gross_nok)}</span>
                  <button onClick={() => toggleInvoiceSettled(inv)}>
                    <Badge variant="secondary" className={inv.settled ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 cursor-pointer' : 'bg-amber-500/10 text-amber-700 dark:text-amber-400 cursor-pointer'}>{inv.settled ? 'Settled' : 'Open'}</Badge>
                  </button>
                  <button onClick={() => deleteInvoice(inv.id)} className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"><IconTrash className="size-3.5" /></button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Expenses</h2>
          <Button variant="outline" size="sm" onClick={() => setShowAddExpense(!showAddExpense)}><IconPlus className="size-4 mr-1" />Add expense</Button>
        </div>
        {showAddExpense && (
          <div className="rounded-lg border bg-card p-4 space-y-3 mb-3">
            <div className="grid grid-cols-2 gap-2">
              <input type="text" placeholder="Supplier" value={expForm.supplier_name} onChange={e => setExpForm(f => ({ ...f, supplier_name: e.target.value }))} className="rounded-md border bg-background px-3 py-2 text-sm" autoFocus />
              <input type="date" value={expForm.date} onChange={e => setExpForm(f => ({ ...f, date: e.target.value }))} className="rounded-md border bg-background px-3 py-2 text-sm" />
              <input type="text" placeholder="Description (optional)" value={expForm.description} onChange={e => setExpForm(f => ({ ...f, description: e.target.value }))} className="rounded-md border bg-background px-3 py-2 text-sm col-span-2" />
              <input type="number" placeholder="Net NOK" value={expForm.net_nok} onChange={e => setExpForm(f => ({ ...f, net_nok: e.target.value }))} step="0.01" className="rounded-md border bg-background px-3 py-2 text-sm" />
              <input type="number" placeholder="VAT NOK" value={expForm.vat_nok} onChange={e => setExpForm(f => ({ ...f, vat_nok: e.target.value }))} step="0.01" className="rounded-md border bg-background px-3 py-2 text-sm" />
              <input type="text" placeholder="Account (e.g. 6540)" value={expForm.account} onChange={e => setExpForm(f => ({ ...f, account: e.target.value }))} className="rounded-md border bg-background px-3 py-2 text-sm" />
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={expForm.paid} onChange={e => setExpForm(f => ({ ...f, paid: e.target.checked }))} />Paid</label>
            </div>
            <div className="flex gap-2 justify-end"><Button variant="ghost" size="sm" onClick={() => setShowAddExpense(false)}>Cancel</Button><Button size="sm" onClick={handleAddExpense}>Save</Button></div>
          </div>
        )}
        {expenses.length === 0 ? <p className="py-4 text-sm text-muted-foreground">No expenses yet.</p> : (
          <div className="rounded-lg border divide-y">
            {expenses.map(e => (
              <div key={e.id} className="flex items-center justify-between px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{e.supplier_name}{e.description ? ` — ${e.description}` : ''}</p>
                  <p className="text-xs text-muted-foreground">{formatDate(e.date)}{e.account ? ` · ${e.account}` : ''}</p>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-sm font-medium">{formatNOK(e.gross_nok)}</span>
                  <button onClick={() => toggleExpensePaid(e)}>
                    <Badge variant="secondary" className={e.paid ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 cursor-pointer' : 'bg-amber-500/10 text-amber-700 dark:text-amber-400 cursor-pointer'}>{e.paid ? 'Paid' : 'Unpaid'}</Badge>
                  </button>
                  <button onClick={() => deleteExpense(e.id)} className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"><IconTrash className="size-3.5" /></button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
