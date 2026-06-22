import fs from 'fs';
import path from 'path';

const AD_ENGINE_DIR = process.env.NC_AD_ENGINE_DIR ?? '/Users/Shared/ad-engine';
const DAILY_FILE = path.join(AD_ENGINE_DIR, 'nc-conv-daily.json');
const STATE_FILE = path.join(AD_ENGINE_DIR, 'nc-conv-state.json');

export interface NcDailyPoint {
  date: string;
  conv: number;
  all_conv: number;
  cost: number;
  clicks: number;
  impressions: number;
}

export interface NcAdState {
  ts: string;
  acct: {
    conv: number;
    all_conv: number;
    value: number;
    cost: number;
    clicks: number;
    impressions: number;
  };
  campaigns: Array<{
    name: string;
    conv: number;
    all_conv: number;
    cost: number;
    clicks: number;
  }>;
}

export function getNcDailyHistory(): NcDailyPoint[] {
  try {
    const raw = fs.readFileSync(DAILY_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as NcDailyPoint[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function getNcAdState(): NcAdState | null {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    return JSON.parse(raw) as NcAdState;
  } catch {
    return null;
  }
}

/** Compute CPL (cost per lead = cost / all_conv) for a daily point, null if no leads. */
export function computeCpl(pt: NcDailyPoint): number | null {
  return pt.all_conv > 0 ? Math.round(pt.cost / pt.all_conv) : null;
}

/** Compute CTR percentage for a daily point. */
export function computeCtr(pt: NcDailyPoint): number {
  return pt.impressions > 0 ? Math.round((pt.clicks / pt.impressions) * 1000) / 10 : 0;
}

/** Enrich daily points with derived metrics for charting. */
export function enrichHistory(points: NcDailyPoint[]): Array<NcDailyPoint & { cpl: number | null; ctr: number }> {
  return points.map(pt => ({
    ...pt,
    cpl: computeCpl(pt),
    ctr: computeCtr(pt),
  }));
}

/** Rolling 7-day totals from the last 7 data points. */
export function getRolling7(points: NcDailyPoint[]): NcDailyPoint {
  const last7 = points.slice(-7);
  return last7.reduce(
    (acc, pt) => ({
      date: pt.date,
      conv: acc.conv + pt.conv,
      all_conv: acc.all_conv + pt.all_conv,
      cost: acc.cost + pt.cost,
      clicks: acc.clicks + pt.clicks,
      impressions: acc.impressions + pt.impressions,
    }),
    { date: '', conv: 0, all_conv: 0, cost: 0, clicks: 0, impressions: 0 },
  );
}
