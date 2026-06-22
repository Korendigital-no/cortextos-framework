import { getNcDailyHistory, getNcAdState, enrichHistory, getRolling7 } from '@/lib/data/nc-ads';
import { NcAdsPerformance } from '@/components/analytics/nc-ads-performance';

export const dynamic = 'force-dynamic';

export default function AdEnginePage() {
  const raw = getNcDailyHistory();
  const state = getNcAdState();

  const history = enrichHistory(raw);
  const rolling7 = getRolling7(raw);
  const campaigns = state?.campaigns ?? [];
  const lastUpdated = state?.ts ?? null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">NC Ads</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Google Ads performance — NC lead funnel
        </p>
      </div>
      <NcAdsPerformance
        history={history}
        rolling7={rolling7}
        campaigns={campaigns}
        lastUpdated={lastUpdated}
      />
    </div>
  );
}
