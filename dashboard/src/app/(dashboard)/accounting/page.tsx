'use client';

import { useEffect, useState, useCallback } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { IconReceipt, IconTrendingUp, IconTrendingDown, IconCash, IconPlus, IconTrash, IconBuildingBank, IconRepeat, IconPlayerPlay } from '@tabler/icons-react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts';

interface PeriodSummary {
  period: string;
  revenue_nok: number; costs_nok: number; profit_nok: number; vat_balance_nok: number;
  invoices_count: number; expenses_count: number;
}
interface SummaryResp { current_month: PeriodSummary; ytd: PeriodSummary; }

interface Account {
  id: string; name: string; type: string;
  starting_balance_nok: number; balance_nok: number;
  settled_invoices_nok: number; paid_expenses_nok: number;
}

interface Recurring {
  id: string; name: string; account_id: string; account_name: string | null;
  amount_nok: number; day_of_month: number; apply_on_last_day: boolean;
  active: boolean; last_applied_ym: string | null;
}

interface Invoice {
  id: string; invoiceNumber: string; customer_name: string;
  issueDate: string; dueDate: string | null;
  net_nok: number; vat_nok: number; gross_nok: number; settled: boolean; notes: string | null;
  account_id: string | null; account_name: string | null;
}

interface Expense {
  id: string; supplier_name: string; description: string | null; date: string;
  net_nok: number; vat_nok: number; gross_nok: number; paid: boolean; account: string | null;
  account_id: string | null; account_name: string | null; recurring_id: string | null;
}

interface VatStatus {
  period: string; vat_collected_nok: number; vat_paid_nok: number; balance_nok: number;
  direction: 'owed' | 'refundable' | 'zero'; start_date: string; end_date: string;
}

interface TimeseriesPoint { month: string; revenue_nok: number; cost_nok: number; profit_nok: number; }

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

function currentYm(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function sixMonthsAgoYm(): string {
  const d = new Date();
  const back = new Date(d.getFullYear(), d.getMonth() - 5, 1);
  return `${back.getFullYear()}-${String(back.getMonth() + 1).padStart(2, '0')}`;
}

export default function AccountingPage() {
  const [summary, setSummary] = useState<SummaryResp | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [recurring, setRecurring] = useState<Recurring[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [vat, setVat] = useState<VatStatus | null>(null);
  const [timeseries, setTimeseries] = useState<TimeseriesPoint[]>([]);
  const [tsFrom, setTsFrom] = useState(sixMonthsAgoYm());
  const [tsTo, setTsTo] = useState(currentYm());
  const [loading, setLoading] = useState(true);

  const [showAddInvoice, setShowAddInvoice] = useState(false);
  const [invForm, setInvForm] = useState({ invoice_number: '', customer_name: '', issue_date: todayLocal(), due_date: '', net_nok: '', vat_nok: '', settled: false, account_id: '' });

  const [showAddExpense, setShowAddExpense] = useState(false);
  const [expForm, setExpForm] = useState({ supplier_name: '', description: '', date: todayLocal(), net_nok: '', vat_nok: '', account: '', paid: true, account_id: '' });

  const [showAddRecurring, setShowAddRecurring] = useState(false);
  const [recForm, setRecForm] = useState({ name: '', account_id: '', amount_nok: '', day_of_month: '1', apply_on_last_day: false });

  const fetchAll = useCallback(async () => {
    try {
      const [aRes, sRes, iRes, eRes, vRes, rRes, tsRes] = await Promise.all([
        fetch('/api/accounting/accounts'),
        fetch('/api/accounting/summary'),
        fetch('/api/accounting/invoices'),
        fetch('/api/accounting/expenses'),
        fetch('/api/accounting/vat'),
        fetch('/api/accounting/recurring'),
        fetch(`/api/accounting/timeseries?from=${tsFrom}&to=${tsTo}`),
      ]);
      if (aRes.ok) setAccounts((await aRes.json()).accounts);
      if (sRes.ok) setSummary(await sRes.json());
      if (iRes.ok) setInvoices((await iRes.json()).invoices);
      if (eRes.ok) setExpenses((await eRes.json()).expenses);
      if (vRes.ok) setVat(await vRes.json());
      if (rRes.ok) setRecurring((await rRes.json()).recurring);
      if (tsRes.ok) setTimeseries((await tsRes.json()).series);
    } finally { setLoading(false); }
  }, [tsFrom, tsTo]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  async function handleAddInvoice() {
    if (!invForm.invoice_number || !invForm.customer_name || !invForm.net_nok) return;
    await fetch('/api/accounting/invoices', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        invoice_number: invForm.invoice_number, customer_name: invForm.customer_name,
        issue_date: invForm.issue_date, due_date: invForm.due_date || undefined,
        net_nok: parseFloat(invForm.net_nok), vat_nok: invForm.vat_nok ? parseFloat(invForm.vat_nok) : 0,
        settled: invForm.settled, account_id: invForm.account_id || undefined,
      }),
    });
    setInvForm({ invoice_number: '', customer_name: '', issue_date: todayLocal(), due_date: '', net_nok: '', vat_nok: '', settled: false, account_id: '' });
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
        account_id: expForm.account_id || undefined,
      }),
    });
    setExpForm({ supplier_name: '', description: '', date: todayLocal(), net_nok: '', vat_nok: '', account: '', paid: true, account_id: '' });
    setShowAddExpense(false);
    fetchAll();
  }

  async function handleAddRecurring() {
    if (!recForm.name || !recForm.account_id || !recForm.amount_nok) return;
    await fetch('/api/accounting/recurring', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: recForm.name, account_id: recForm.account_id, amount_nok: parseFloat(recForm.amount_nok),
        day_of_month: recForm.apply_on_last_day ? 1 : parseInt(recForm.day_of_month, 10),
        apply_on_last_day: recForm.apply_on_last_day,
      }),
    });
    setRecForm({ name: '', account_id: '', amount_nok: '', day_of_month: '1', apply_on_last_day: false });
    setShowAddRecurring(false);
    fetchAll();
  }

  async function applyRecurringNow() {
    await fetch('/api/accounting/recurring/apply', { method: 'POST' });
    fetchAll();
  }

  async function toggleRecurringActive(r: Recurring) {
    await fetch('/api/accounting/recurring', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: r.id, active: !r.active }),
    });
    fetchAll();
  }

  async function deleteRecurring(id: string) {
    if (!confirm('Delete recurring deduction?')) return;
    await fetch(`/api/accounting/recurring?id=${id}`, { method: 'DELETE' });
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

  if (loading) return <div className="space-y-6"><h1 className="text-2xl font-semibold">Accounting</h1><div className="grid grid-cols-1 gap-4 sm:grid-cols-3">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-24 rounded-xl bg-muted/30 animate-pulse" />)}</div></div>;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Accounting</h1>

      {accounts.length > 0 && (
        <div>
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-2"><IconBuildingBank className="size-4" />Accounts</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {accounts.map(a => (
              <div key={a.id} className="rounded-xl border bg-card p-4">
                <p className="text-xs text-muted-foreground">{a.name}</p>
                <p className={`text-2xl font-semibold ${a.balance_nok < 0 ? 'text-red-600 dark:text-red-400' : 'text-foreground'}`}>{formatNOK(a.balance_nok)}</p>
                <p className="text-xs text-muted-foreground mt-1">Start: {formatNOK(a.starting_balance_nok)} · +{formatNOK(a.settled_invoices_nok)} · -{formatNOK(a.paid_expenses_nok)}</p>
              </div>
            ))}
          </div>
        </div>
      )}

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

      <div>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Trends</h2>
          <div className="flex gap-2 items-center">
            <input type="month" value={tsFrom} onChange={e => setTsFrom(e.target.value)} className="rounded-md border bg-background px-2 py-1 text-xs" />
            <span className="text-xs text-muted-foreground">to</span>
            <input type="month" value={tsTo} onChange={e => setTsTo(e.target.value)} className="rounded-md border bg-background px-2 py-1 text-xs" />
          </div>
        </div>
        <div className="rounded-xl border bg-card p-4">
          {timeseries.length === 0 ? <p className="py-12 text-center text-sm text-muted-foreground">No data in range.</p> : (
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={timeseries} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="month" stroke="hsl(var(--muted-foreground))" fontSize={11} />
                <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickFormatter={(v: number) => v >= 1000 ? `${(v/1000).toFixed(0)}k` : v.toString()} />
                <Tooltip contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8 }} formatter={(v) => typeof v === 'number' ? formatNOK(v) : String(v)} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="revenue_nok" name="Revenue" stroke="rgb(16,185,129)" strokeWidth={2} dot={{ r: 3 }} />
                <Line type="monotone" dataKey="cost_nok" name="Cost" stroke="rgb(239,68,68)" strokeWidth={2} dot={{ r: 3 }} />
                <Line type="monotone" dataKey="profit_nok" name="Profit" stroke="rgb(148,163,184)" strokeWidth={2} dot={{ r: 3 }} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

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
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-2"><IconRepeat className="size-4" />Recurring</h2>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={applyRecurringNow} title="Apply all eligible recurring entries now"><IconPlayerPlay className="size-4 mr-1" />Apply now</Button>
            <Button variant="outline" size="sm" onClick={() => setShowAddRecurring(!showAddRecurring)}><IconPlus className="size-4 mr-1" />Add recurring</Button>
          </div>
        </div>
        {showAddRecurring && (
          <div className="rounded-lg border bg-card p-4 space-y-3 mb-3">
            <div className="grid grid-cols-2 gap-2">
              <input type="text" placeholder="Name (e.g. Office rent)" value={recForm.name} onChange={e => setRecForm(f => ({ ...f, name: e.target.value }))} className="rounded-md border bg-background px-3 py-2 text-sm" autoFocus />
              <select value={recForm.account_id} onChange={e => setRecForm(f => ({ ...f, account_id: e.target.value }))} className="rounded-md border bg-background px-3 py-2 text-sm">
                <option value="">Select account…</option>
                {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
              <input type="number" placeholder="Amount NOK" value={recForm.amount_nok} onChange={e => setRecForm(f => ({ ...f, amount_nok: e.target.value }))} step="0.01" className="rounded-md border bg-background px-3 py-2 text-sm" />
              <input type="number" placeholder="Day of month (1-28)" value={recForm.day_of_month} onChange={e => setRecForm(f => ({ ...f, day_of_month: e.target.value }))} min="1" max="28" disabled={recForm.apply_on_last_day} className="rounded-md border bg-background px-3 py-2 text-sm disabled:opacity-50" />
            </div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={recForm.apply_on_last_day} onChange={e => setRecForm(f => ({ ...f, apply_on_last_day: e.target.checked }))} />Apply on last day of month</label>
            <div className="flex gap-2 justify-end"><Button variant="ghost" size="sm" onClick={() => setShowAddRecurring(false)}>Cancel</Button><Button size="sm" onClick={handleAddRecurring}>Save</Button></div>
          </div>
        )}
        {recurring.length === 0 ? <p className="py-4 text-sm text-muted-foreground">No recurring deductions yet.</p> : (
          <div className="rounded-lg border divide-y">
            {recurring.map(r => (
              <div key={r.id} className="flex items-center justify-between px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{r.name}</p>
                  <p className="text-xs text-muted-foreground">{r.account_name ?? 'no account'} · {r.apply_on_last_day ? 'last day of month' : `day ${r.day_of_month}`}{r.last_applied_ym ? ` · last applied ${r.last_applied_ym}` : ''}</p>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-sm font-medium">{formatNOK(r.amount_nok)}</span>
                  <button onClick={() => toggleRecurringActive(r)}>
                    <Badge variant="secondary" className={r.active ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 cursor-pointer' : 'bg-muted text-muted-foreground cursor-pointer'}>{r.active ? 'Active' : 'Paused'}</Badge>
                  </button>
                  <button onClick={() => deleteRecurring(r.id)} className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"><IconTrash className="size-3.5" /></button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

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
              <select value={invForm.account_id} onChange={e => setInvForm(f => ({ ...f, account_id: e.target.value }))} className="rounded-md border bg-background px-3 py-2 text-sm col-span-2">
                <option value="">No account</option>
                {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
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
                  <p className="text-xs text-muted-foreground">{formatDate(inv.issueDate)}{inv.dueDate ? ` · due ${formatDate(inv.dueDate)}` : ''}{inv.account_name ? ` · ${inv.account_name}` : ''}</p>
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
              <input type="text" placeholder="Account no (e.g. 6540)" value={expForm.account} onChange={e => setExpForm(f => ({ ...f, account: e.target.value }))} className="rounded-md border bg-background px-3 py-2 text-sm" />
              <select value={expForm.account_id} onChange={e => setExpForm(f => ({ ...f, account_id: e.target.value }))} className="rounded-md border bg-background px-3 py-2 text-sm">
                <option value="">No account</option>
                {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
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
                  <p className="text-sm font-medium truncate flex items-center gap-1.5">{e.supplier_name}{e.description ? ` — ${e.description}` : ''}{e.recurring_id ? <IconRepeat className="size-3 inline text-muted-foreground" /> : null}</p>
                  <p className="text-xs text-muted-foreground">{formatDate(e.date)}{e.account ? ` · ${e.account}` : ''}{e.account_name ? ` · ${e.account_name}` : ''}</p>
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
