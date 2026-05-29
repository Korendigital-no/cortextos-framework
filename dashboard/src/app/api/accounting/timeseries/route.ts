import { NextRequest } from 'next/server';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

const YM = /^\d{4}-\d{2}$/;

function defaultRange(): { from: string; to: string } {
  const now = new Date();
  const to = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const fromD = new Date(now.getFullYear(), now.getMonth() - 5, 1);
  const from = `${fromD.getFullYear()}-${String(fromD.getMonth() + 1).padStart(2, '0')}`;
  return { from, to };
}

function ymRange(from: string, to: string): string[] {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  const out: string[] = [];
  let y = fy, m = fm;
  // Safety: cap at 5 years (60 months) to prevent runaway loops on bad input
  for (let i = 0; i < 60; i++) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    if (y === ty && m === tm) break;
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const defaults = defaultRange();
  const from = searchParams.get('from') ?? defaults.from;
  const to = searchParams.get('to') ?? defaults.to;

  if (!YM.test(from) || !YM.test(to)) {
    return Response.json({ error: 'from and to must be YYYY-MM' }, { status: 400 });
  }
  if (from > to) {
    return Response.json({ error: 'from must be <= to' }, { status: 400 });
  }

  const months = ymRange(from, to);

  // Bucket invoices by issue_date YYYY-MM
  const invRows = db.prepare(`
    SELECT substr(issue_date, 1, 7) as ym, COALESCE(SUM(net_nok), 0) as net
    FROM accounting_invoices
    WHERE issue_date >= ? AND issue_date < ?
    GROUP BY substr(issue_date, 1, 7)
  `).all(`${from}-01`, nextMonthFloor(to)) as Array<{ ym: string; net: number }>;

  const expRows = db.prepare(`
    SELECT substr(date, 1, 7) as ym, COALESCE(SUM(net_nok), 0) as net
    FROM accounting_expenses
    WHERE date >= ? AND date < ?
    GROUP BY substr(date, 1, 7)
  `).all(`${from}-01`, nextMonthFloor(to)) as Array<{ ym: string; net: number }>;

  const invMap = new Map(invRows.map(r => [r.ym, r.net]));
  const expMap = new Map(expRows.map(r => [r.ym, r.net]));

  const series = months.map(month => {
    const revenue = invMap.get(month) ?? 0;
    const cost = expMap.get(month) ?? 0;
    return { month, revenue_nok: revenue, cost_nok: cost, profit_nok: revenue - cost };
  });

  return Response.json({ from, to, series });
}

/** Returns YYYY-MM-DD for the first day of the month AFTER the given YYYY-MM. */
function nextMonthFloor(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-01`;
}
