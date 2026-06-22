'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AreaChart } from '@/components/charts/area-chart';
import { BarChart } from '@/components/charts/bar-chart';
import { CHART_GOLD, CHART_COLORS } from '@/components/charts/chart-theme';
import type { NcDailyPoint } from '@/lib/data/nc-ads';

interface NcCampaign {
  name: string;
  conv: number;
  all_conv: number;
  cost: number;
  clicks: number;
}

interface NcAdsPerformanceProps {
  history: Array<NcDailyPoint & { cpl: number | null; ctr: number }>;
  rolling7: { conv: number; all_conv: number; cost: number; clicks: number; impressions: number };
  campaigns: NcCampaign[];
  lastUpdated: string | null;
}

function KpiCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card>
      <CardContent className="pt-5 pb-4">
        <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">{label}</p>
        <p className="text-2xl font-semibold tabular-nums">{value}</p>
        {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
      </CardContent>
    </Card>
  );
}

export function NcAdsPerformance({ history, rolling7, campaigns, lastUpdated }: NcAdsPerformanceProps) {
  const cpa = rolling7.conv > 0 ? Math.round(rolling7.cost / rolling7.conv) : null;
  const cpl = rolling7.all_conv > 0 ? Math.round(rolling7.cost / rolling7.all_conv) : null;
  const ctr = rolling7.impressions > 0
    ? Math.round((rolling7.clicks / rolling7.impressions) * 1000) / 10
    : 0;

  // Chart data: label dates as DD.MM for readability
  const chartData = history.map(pt => ({
    ...pt,
    day: `${pt.date.slice(8, 10)}.${pt.date.slice(5, 7)}`,
  }));

  const hasConversions = history.some(pt => pt.all_conv > 0);
  const hasCpl = history.some(pt => pt.cpl !== null);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">NC FlyttMob — Ad Performance</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Google Ads konto 9587360317 · siste 7 dager
            {lastUpdated && ` · oppdatert ${lastUpdated.slice(0, 10)}`}
          </p>
        </div>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <KpiCard
          label="Spend (7d)"
          value={`${Math.round(rolling7.cost).toLocaleString('nb-NO')} kr`}
        />
        <KpiCard
          label="Leads (7d)"
          value={rolling7.all_conv.toFixed(0)}
          sub={cpl ? `CPL: ${cpl.toLocaleString('nb-NO')} kr` : 'CPL: n/a'}
        />
        <KpiCard
          label="Konv (7d)"
          value={rolling7.conv.toFixed(0)}
          sub={cpa ? `CPA: ${cpa.toLocaleString('nb-NO')} kr` : 'CPA: n/a'}
        />
        <KpiCard
          label="Klikk (7d)"
          value={rolling7.clicks.toLocaleString('nb-NO')}
          sub={`CTR: ${ctr}%`}
        />
      </div>

      {/* Spend over time */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
            Spend per dag (kr)
          </CardTitle>
        </CardHeader>
        <CardContent>
          {chartData.length > 0 ? (
            <AreaChart
              data={chartData}
              xKey="day"
              yKeys={['cost']}
              height={200}
              colors={[CHART_GOLD]}
            />
          ) : (
            <p className="text-sm text-muted-foreground py-8 text-center">Ingen data ennå</p>
          )}
        </CardContent>
      </Card>

      {/* Clicks over time */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
            Klikk per dag
          </CardTitle>
        </CardHeader>
        <CardContent>
          {chartData.length > 0 ? (
            <BarChart
              data={chartData}
              xKey="day"
              yKeys={['clicks']}
              height={180}
              colors={[CHART_COLORS[1]]}
            />
          ) : (
            <p className="text-sm text-muted-foreground py-8 text-center">Ingen data ennå</p>
          )}
        </CardContent>
      </Card>

      {/* Conversions / leads over time */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
            Konverteringer og leads per dag
          </CardTitle>
        </CardHeader>
        <CardContent>
          {hasConversions ? (
            <AreaChart
              data={chartData}
              xKey="day"
              yKeys={['all_conv', 'conv']}
              height={180}
              colors={[CHART_COLORS[4], CHART_GOLD]}
              showLegend
            />
          ) : (
            <p className="text-sm text-muted-foreground py-8 text-center">
              Ingen konverteringer ennå i dette tidsrommet
            </p>
          )}
        </CardContent>
      </Card>

      {/* CPL over time — only if any CPL data exists */}
      {hasCpl && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
              CPL per dag (kr / lead)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <BarChart
              data={chartData.map(pt => ({ ...pt, cpl: pt.cpl ?? 0 }))}
              xKey="day"
              yKeys={['cpl']}
              height={180}
              colors={[CHART_COLORS[3]]}
            />
          </CardContent>
        </Card>
      )}

      {/* Campaign breakdown table */}
      {campaigns.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
              Kampanjer (siste 7 dager)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-muted-foreground text-xs uppercase tracking-wider">
                    <th className="text-left py-2 pr-4 font-medium">Kampanje</th>
                    <th className="text-right py-2 px-3 font-medium">Spend</th>
                    <th className="text-right py-2 px-3 font-medium">Klikk</th>
                    <th className="text-right py-2 px-3 font-medium">Leads</th>
                    <th className="text-right py-2 pl-3 font-medium">Konv</th>
                  </tr>
                </thead>
                <tbody>
                  {campaigns.map(c => (
                    <tr key={c.name} className="border-b last:border-0">
                      <td className="py-2.5 pr-4 font-medium max-w-[200px] truncate">{c.name}</td>
                      <td className="py-2.5 px-3 text-right tabular-nums">
                        {Math.round(c.cost).toLocaleString('nb-NO')} kr
                      </td>
                      <td className="py-2.5 px-3 text-right tabular-nums">{c.clicks}</td>
                      <td className="py-2.5 px-3 text-right tabular-nums">{c.all_conv.toFixed(0)}</td>
                      <td className="py-2.5 pl-3 text-right tabular-nums">{c.conv.toFixed(0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
