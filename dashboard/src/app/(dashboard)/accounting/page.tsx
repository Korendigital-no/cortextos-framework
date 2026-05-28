'use client';

import { useEffect, useState, useCallback } from 'react';
import { Badge } from '@/components/ui/badge';
import { IconReceipt, IconTrendingUp, IconTrendingDown, IconCash } from '@tabler/icons-react';

interface PeriodSummary {
  period: string;
  revenue_nok: number;
  costs_nok: number;
  profit_nok: number;
  vat_balance_nok: number;
  invoices_count: number;
  expenses_count: number;
  source: 'fiken' | 'stub';
}

interface SummaryResp {
  current_month: PeriodSummary;
  ytd: PeriodSummary;
}

interface Invoice {
  invoiceId: number;
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  net_nok: number;
  vat_nok: number;
  gross_nok: number;
  settled: boolean;
  customer_name: string | null;
}

interface Expense {
  transactionId: number;
  date: string;
  supplier_name: string | null;
  description: string | null;
  net_nok: number;
  vat_nok: number;
  gross_nok: number;
  paid: boolean;
}

interface VatStatus {
  period: string;
  vat_collected_nok: number;
  vat_paid_nok: number;
  balance_nok: number;
  direction: 'owed' | 'refundable' | 'zero';
  start_date: string;
  end_date: string;
  source: 'fiken' | 'stub';
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

export default function AccountingPage() {
  const [summary, setSummary] = useState<SummaryResp | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [vat, setVat] = useState<VatStatus | null>(null);
  const [source, setSource] = useState<'fiken' | 'stub'>('stub');
  const [loading, setLoading] = useState(true);

  const fetchAll = useCallback(async () => {
    try {
      const [sRes, iRes, eRes, vRes] = await Promise.all([
        fetch('/api/accounting/summary'),
        fetch('/api/accounting/invoices'),
        fetch('/api/accounting/expenses'),
        fetch('/api/accounting/vat'),
      ]);
      if (sRes.ok) {
        const data: SummaryResp = await sRes.json();
        setSummary(data);
        setSource(data.current_month.source);
      }
      if (iRes.ok) {
        const data = await iRes.json();
        setInvoices(data.invoices);
      }
      if (eRes.ok) {
        const data = await eRes.json();
        setExpenses(data.expenses);
      }
      if (vRes.ok) setVat(await vRes.json());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  if (loading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">Accounting</h1>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-24 rounded-xl bg-muted/30 animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Accounting</h1>
          <p className="text-sm text-muted-foreground">Powered by Fiken</p>
        </div>
        {source === 'stub' && (
          <Badge variant="secondary" className="bg-amber-500/10 text-amber-700 dark:text-amber-400">
            Stub data — add FIKEN_API_TOKEN to .env.local
          </Badge>
        )}
      </div>

      {/* Current month summary */}
      {summary && (
        <div>
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-2">This month</h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div className="rounded-xl border bg-card p-4">
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs text-muted-foreground">Revenue</p>
                <IconTrendingUp className="size-4 text-emerald-500" />
              </div>
              <p className="text-2xl font-semibold text-emerald-600 dark:text-emerald-400">{formatNOK(summary.current_month.revenue_nok)}</p>
              <p className="text-xs text-muted-foreground mt-1">{summary.current_month.invoices_count} invoices</p>
            </div>
            <div className="rounded-xl border bg-card p-4">
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs text-muted-foreground">Costs</p>
                <IconTrendingDown className="size-4 text-red-500" />
              </div>
              <p className="text-2xl font-semibold text-red-600 dark:text-red-400">{formatNOK(summary.current_month.costs_nok)}</p>
              <p className="text-xs text-muted-foreground mt-1">{summary.current_month.expenses_count} expenses</p>
            </div>
            <div className="rounded-xl border bg-card p-4">
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs text-muted-foreground">Profit</p>
                <IconCash className="size-4 text-muted-foreground" />
              </div>
              <p className={`text-2xl font-semibold ${summary.current_month.profit_nok >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                {formatNOK(summary.current_month.profit_nok)}
              </p>
            </div>
            <div className="rounded-xl border bg-card p-4">
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs text-muted-foreground">VAT balance</p>
                <IconReceipt className="size-4 text-muted-foreground" />
              </div>
              <p className={`text-2xl font-semibold ${summary.current_month.vat_balance_nok > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                {formatNOK(summary.current_month.vat_balance_nok)}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* YTD summary */}
      {summary && (
        <div>
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-2">Year to date</h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <div className="rounded-xl border bg-card p-4">
              <p className="text-xs text-muted-foreground">Revenue</p>
              <p className="text-xl font-semibold text-emerald-600 dark:text-emerald-400">{formatNOK(summary.ytd.revenue_nok)}</p>
            </div>
            <div className="rounded-xl border bg-card p-4">
              <p className="text-xs text-muted-foreground">Costs</p>
              <p className="text-xl font-semibold text-red-600 dark:text-red-400">{formatNOK(summary.ytd.costs_nok)}</p>
            </div>
            <div className="rounded-xl border bg-card p-4">
              <p className="text-xs text-muted-foreground">Profit</p>
              <p className={`text-xl font-semibold ${summary.ytd.profit_nok >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                {formatNOK(summary.ytd.profit_nok)}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* VAT period */}
      {vat && (
        <div>
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-2">VAT period — {vat.period}</h2>
          <div className="rounded-xl border bg-card p-4">
            <div className="grid grid-cols-3 gap-4">
              <div>
                <p className="text-xs text-muted-foreground">Collected (utgående MVA)</p>
                <p className="text-lg font-semibold">{formatNOK(vat.vat_collected_nok)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Paid (inngående MVA)</p>
                <p className="text-lg font-semibold">{formatNOK(vat.vat_paid_nok)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Balance</p>
                <p className={`text-lg font-semibold ${vat.direction === 'owed' ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                  {formatNOK(vat.balance_nok)} {vat.direction === 'owed' ? '(skyldig)' : vat.direction === 'refundable' ? '(til gode)' : ''}
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Recent invoices */}
      <div>
        <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-2">Recent invoices</h2>
        {invoices.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">No invoices.</p>
        ) : (
          <div className="rounded-lg border divide-y">
            {invoices.map(inv => (
              <div key={inv.invoiceId} className="flex items-center justify-between px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{inv.invoiceNumber} — {inv.customer_name ?? 'Unknown'}</p>
                  <p className="text-xs text-muted-foreground">{formatDate(inv.issueDate)} · due {formatDate(inv.dueDate)}</p>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-sm font-medium">{formatNOK(inv.gross_nok)}</span>
                  <Badge variant="secondary" className={inv.settled ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' : 'bg-amber-500/10 text-amber-700 dark:text-amber-400'}>
                    {inv.settled ? 'Settled' : 'Open'}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Recent expenses */}
      <div>
        <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-2">Recent expenses</h2>
        {expenses.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">No expenses.</p>
        ) : (
          <div className="rounded-lg border divide-y">
            {expenses.map(e => (
              <div key={e.transactionId} className="flex items-center justify-between px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{e.supplier_name ?? 'Unknown'}{e.description ? ` — ${e.description}` : ''}</p>
                  <p className="text-xs text-muted-foreground">{formatDate(e.date)}</p>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-sm font-medium">{formatNOK(e.gross_nok)}</span>
                  <Badge variant="secondary" className={e.paid ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' : 'bg-amber-500/10 text-amber-700 dark:text-amber-400'}>
                    {e.paid ? 'Paid' : 'Unpaid'}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
