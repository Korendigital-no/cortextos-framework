// cortextOS Dashboard - billable resolution (per-project v1)
//
// Billable model (confirmed by mike, pending Vilhelm's project-vs-entry sign-off):
//   - a PROJECT carries the default: crm_client_projects.billable (1 = billable)
//   - a TIME ENTRY carries a NULLABLE override: crm_time_entries.billable
//       NULL  -> inherit the project default
//       1     -> billable
//       0     -> non-billable
//
// SQLite stores booleans as 0/1 integers; project.billable is NOT NULL DEFAULT 1
// and entry.billable is nullable. Keep the resolution rule here so the API,
// totals, and UI all agree.

/** A time entry's stored billable override (0/1) or null to inherit. */
export type BillableOverride = 0 | 1 | null | undefined;

/**
 * Normalise a request value to a billable override for storage: 0, 1, or null.
 * Accepts 0/1 and true/false; anything else (including undefined) -> null,
 * meaning "inherit the project default". Shared by the POST and PATCH routes so
 * the wire contract is identical on both.
 */
export function normalizeBillable(v: unknown): 0 | 1 | null {
  if (v === 1 || v === true) return 1;
  if (v === 0 || v === false) return 0;
  return null;
}

/**
 * Resolve whether a single entry is billable, applying the per-entry override
 * on top of the project default. A client-level entry with no project still
 * resolves via its own override, defaulting to billable when unset.
 */
export function effectiveBillable(
  entryBillable: BillableOverride,
  projectBillable: 0 | 1 | null | undefined,
): boolean {
  if (entryBillable === 0 || entryBillable === 1) return entryBillable === 1;
  // No per-entry override -> inherit the project default (default to billable
  // when the project default is somehow unset, matching the column default).
  return projectBillable !== 0;
}

export interface HoursEntry {
  hours: number;
  billable?: BillableOverride;
}

export interface BillableSplit {
  billableHours: number;
  nonBillableHours: number;
  totalHours: number;
}

/**
 * Split a project's time entries into billable vs non-billable hours using the
 * project's default for entries that don't override it. Rounds to avoid binary
 * float dust (e.g. 0.1 + 0.2) leaking into the UI.
 */
export function splitBillableHours(
  entries: HoursEntry[],
  projectBillable: 0 | 1 | null | undefined,
): BillableSplit {
  let billableHours = 0;
  let nonBillableHours = 0;
  for (const e of entries) {
    const hours = typeof e.hours === 'number' && isFinite(e.hours) ? e.hours : 0;
    if (effectiveBillable(e.billable, projectBillable)) billableHours += hours;
    else nonBillableHours += hours;
  }
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    billableHours: round(billableHours),
    nonBillableHours: round(nonBillableHours),
    totalHours: round(billableHours + nonBillableHours),
  };
}
