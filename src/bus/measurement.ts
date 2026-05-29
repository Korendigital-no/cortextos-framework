/**
 * Måle-garanti instrumentation — the measurement backbone behind Koren's
 * "2 timer/uke spart eller gratis justering" guarantee.
 *
 * Spec: orgs/korendigital/agents/research/research/maale-garanti-instrumentation-spec.md
 *
 * Model (§1): Tid_spart = (oppgaver × baseline_sek_per_oppgave) − menneske_tid_gjenstående.
 * Each completed agent task emits a `measurement`/`task_handled` event carrying
 * the per-task baseline (captured in uke-0) and the residual human-touch time.
 * The weekly aggregate computes net time saved — the honest number that holds
 * up in a renewal or a dispute — and the guarantee verdict (≥ 2.0 t/uke).
 */

import { validateAgentName } from '../utils/validate.js';

export type MeasurementOutcome = 'completed' | 'escalated_to_human' | 'failed';
export type BaselineConfidence = 'high' | 'medium' | 'low';

/** Structured metadata for a `measurement`/`task_handled` event (spec §3). */
export interface MeasurementMeta {
  /** Client org number (orgnr) — the guarantee is per client. */
  client_id: string;
  /** Agent that handled the task. */
  agent_id: string;
  /** Task category, e.g. booking | doc_review | nav_oppgjor | no_show_chase. */
  task_type: string;
  /** ISO timestamp the task completed. */
  completed_at: string;
  /** Whether a human had to touch this task at all. */
  human_touch_required: boolean;
  /** Residual human time on this task (review/approval/exception), seconds. */
  human_touch_seconds: number;
  /** Baseline manual time for this task, captured signed in uke-0, seconds. */
  baseline_seconds_per_task: number;
  /** Confidence in the baseline source (spec §4). Defaults to 'medium'. */
  baseline_confidence?: BaselineConfidence;
  /** Outcome — only `completed` counts toward time saved. */
  outcome: MeasurementOutcome;
}

const VALID_OUTCOMES: MeasurementOutcome[] = ['completed', 'escalated_to_human', 'failed'];
const VALID_CONFIDENCE: BaselineConfidence[] = ['high', 'medium', 'low'];

/**
 * Validate a measurement event's metadata. Throws on anything that would make
 * the aggregate dishonest (negative times, missing client, bad outcome) — we
 * would rather reject a malformed event than silently skew a guarantee number.
 */
export function validateMeasurementMeta(meta: Partial<MeasurementMeta>): void {
  const required: Array<keyof MeasurementMeta> = ['client_id', 'agent_id', 'task_type', 'completed_at'];
  for (const field of required) {
    const v = meta[field];
    if (typeof v !== 'string' || v.trim() === '') {
      throw new Error(`measurement: '${field}' is required and must be a non-empty string`);
    }
  }
  // agent_id becomes a filesystem path component in logEvent
  // (analyticsDir/events/{agent_id}/...). Enforce the same agent-name regex
  // every other agent-name→path flow uses, so a value like '../../tmp/evil'
  // can never escape the per-agent events directory (path traversal).
  validateAgentName(meta.agent_id as string);
  if (!VALID_OUTCOMES.includes(meta.outcome as MeasurementOutcome)) {
    throw new Error(`measurement: 'outcome' must be one of: ${VALID_OUTCOMES.join(', ')}`);
  }
  if (typeof meta.baseline_seconds_per_task !== 'number' || !Number.isFinite(meta.baseline_seconds_per_task) || meta.baseline_seconds_per_task < 0) {
    throw new Error("measurement: 'baseline_seconds_per_task' must be a non-negative number");
  }
  if (typeof meta.human_touch_seconds !== 'number' || !Number.isFinite(meta.human_touch_seconds) || meta.human_touch_seconds < 0) {
    throw new Error("measurement: 'human_touch_seconds' must be a non-negative number");
  }
  if (typeof meta.human_touch_required !== 'boolean') {
    throw new Error("measurement: 'human_touch_required' must be a boolean");
  }
  if (meta.baseline_confidence !== undefined && !VALID_CONFIDENCE.includes(meta.baseline_confidence)) {
    throw new Error(`measurement: 'baseline_confidence' must be one of: ${VALID_CONFIDENCE.join(', ')}`);
  }
}

/** Guarantee threshold: 2.0 hours/week (spec §1, §5). */
export const GUARANTEE_WEEKLY_HOURS = 2.0;
const SECONDS_PER_HOUR = 3600;

export interface MeasurementReport {
  client_id: string;
  window_start: string;
  window_end: string;
  /** Number of distinct ISO weeks the window spans (≥ 1), for per-week scaling. */
  weeks: number;
  tasks_completed: number;
  tasks_escalated: number;
  tasks_failed: number;
  /** Gross baseline time over completed tasks, seconds. */
  gross_baseline_seconds: number;
  /** Residual human time over completed tasks, seconds. */
  human_touch_seconds: number;
  /** Net time saved over the whole window, seconds (gross − human). */
  time_saved_seconds: number;
  /** Net time saved per completed task, seconds (volume-independent, spec §4). */
  time_saved_per_task_seconds: number;
  /** Net time saved per week, hours (volume-dependent — the guarantee number). */
  time_saved_per_week_hours: number;
  /** Lowest baseline confidence seen — we report the floor, not the average. */
  confidence: BaselineConfidence;
  /** True when per-week saved time meets the 2.0 t/uke guarantee. */
  guarantee_met: boolean;
}

const CONFIDENCE_RANK: Record<BaselineConfidence, number> = { high: 3, medium: 2, low: 1 };
const MS_PER_WEEK = 7 * 86400000;

/**
 * Number of weeks in the REQUESTED report window — used to convert the
 * window-total saved time into a per-week figure. We scale by the window the
 * user asked for, not by how many ISO calendar weeks the events happen to
 * touch: a normal 7-day window that straddles a Mon boundary is still one
 * week of work, and counting it as two would wrongly halve the figure and
 * falsely fail the 2 t/uke guarantee.
 *
 * Floored at 1.0 so a sub-week window never EXTRAPOLATES the per-week number
 * upward (which could falsely PASS the guarantee). A short window just reports
 * its own total as the weekly figure — the conservative direction. Returns 1
 * if the window is unparseable.
 */
function windowWeeks(windowStart: string, windowEnd: string): number {
  const start = new Date(windowStart).getTime();
  const end = new Date(windowEnd).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return 1;
  return Math.max(1, (end - start) / MS_PER_WEEK);
}

/**
 * Aggregate measurement events for one client over a window into a guarantee
 * report. Only `completed` tasks contribute to time saved; escalated/failed
 * are counted separately so the hidden-work / honesty discipline (spec §4)
 * is visible rather than buried. `events` should already be filtered to the
 * client and window by the caller.
 */
export function aggregateMeasurements(
  events: MeasurementMeta[],
  opts: { client_id: string; window_start: string; window_end: string },
): MeasurementReport {
  let tasksCompleted = 0;
  let tasksEscalated = 0;
  let tasksFailed = 0;
  let grossBaseline = 0;
  let humanTouch = 0;
  let confidenceFloor: BaselineConfidence = 'high';

  for (const e of events) {
    if (e.outcome === 'completed') {
      tasksCompleted++;
      grossBaseline += e.baseline_seconds_per_task;
      humanTouch += e.human_touch_seconds;
      const conf = e.baseline_confidence ?? 'medium';
      if (CONFIDENCE_RANK[conf] < CONFIDENCE_RANK[confidenceFloor]) confidenceFloor = conf;
    } else if (e.outcome === 'escalated_to_human') {
      tasksEscalated++;
    } else if (e.outcome === 'failed') {
      tasksFailed++;
    }
  }

  const timeSaved = grossBaseline - humanTouch;
  const weeks = windowWeeks(opts.window_start, opts.window_end);
  const perWeekHours = timeSaved / SECONDS_PER_HOUR / weeks;

  return {
    client_id: opts.client_id,
    window_start: opts.window_start,
    window_end: opts.window_end,
    weeks,
    tasks_completed: tasksCompleted,
    tasks_escalated: tasksEscalated,
    tasks_failed: tasksFailed,
    gross_baseline_seconds: grossBaseline,
    human_touch_seconds: humanTouch,
    time_saved_seconds: timeSaved,
    time_saved_per_task_seconds: tasksCompleted > 0 ? timeSaved / tasksCompleted : 0,
    time_saved_per_week_hours: perWeekHours,
    confidence: tasksCompleted > 0 ? confidenceFloor : 'low',
    guarantee_met: perWeekHours >= GUARANTEE_WEEKLY_HOURS,
  };
}

/** Render a measurement report as a human-readable text block (CLI output). */
export function formatMeasurementReport(r: MeasurementReport): string {
  const h = (s: number) => (s / SECONDS_PER_HOUR).toFixed(2);
  const weeksLabel = Number.isInteger(r.weeks) ? String(r.weeks) : r.weeks.toFixed(1);
  const lines = [
    `Måle-garanti report — client ${r.client_id}`,
    `Window: ${r.window_start.slice(0, 10)} → ${r.window_end.slice(0, 10)} (${weeksLabel} week${r.weeks === 1 ? '' : 's'})`,
    `Tasks: ${r.tasks_completed} completed, ${r.tasks_escalated} escalated, ${r.tasks_failed} failed`,
    `Gross baseline: ${h(r.gross_baseline_seconds)} h | Human-touch residual: ${h(r.human_touch_seconds)} h`,
    `Time saved (window): ${h(r.time_saved_seconds)} h | per task: ${(r.time_saved_per_task_seconds / 60).toFixed(1)} min`,
    `Time saved per week: ${r.time_saved_per_week_hours.toFixed(2)} h  (threshold ${GUARANTEE_WEEKLY_HOURS.toFixed(1)} h)`,
    `Baseline confidence: ${r.confidence}`,
    `Guarantee: ${r.guarantee_met ? '✅ MET (≥ 2 t/uke)' : '⚠️  NOT MET — gratis-justering trigger'}`,
  ];
  return lines.join('\n');
}
