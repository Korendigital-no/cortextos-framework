import type Database from 'better-sqlite3';

/**
 * Soft-delete / restore for CRM time entries via a move between crm_time_entries
 * and its archive crm_time_entries_deleted.
 *
 * Why move-the-row instead of a deleted_at flag: crm_time_entries is read in ~10
 * places, 4 of them aggregations (total_hours, entry_count, last_activity,
 * project totals). A flag would require `deleted_at IS NULL` in every one — miss
 * one aggregation and soft-deleted hours leak silently into a billable total.
 * Moving the row out of the live table keeps all reads correct BY-CONSTRUCTION.
 */

/** Columns shared by crm_time_entries and crm_time_entries_deleted (the archive
 *  adds only deleted_at). A constant — never interpolate user input into SQL.
 *  The crm_time_entries_deleted mirror test pins this against the live schema. */
export const TIME_ENTRY_COLUMNS =
  'id, client_id, project_id, description, hours, date, billable, agent, created_at';

/**
 * Soft-delete: MOVE the entry from crm_time_entries into the archive in one
 * transaction, stamping deleted_at. After this the row exists in exactly one
 * table (atomic) and is gone from every live read/aggregation.
 */
export function archiveTimeEntry(db: Database.Database, entryId: string, deletedAt: string): void {
  const move = db.transaction((eid: string) => {
    db.prepare(`
      INSERT INTO crm_time_entries_deleted (${TIME_ENTRY_COLUMNS}, deleted_at)
      SELECT ${TIME_ENTRY_COLUMNS}, ? FROM crm_time_entries WHERE id = ?
    `).run(deletedAt, eid);
    db.prepare('DELETE FROM crm_time_entries WHERE id = ?').run(eid);
  });
  move(entryId);
}

/**
 * Restore: the inverse MOVE, archive -> live, in one transaction. May throw if a
 * foreign key can't be satisfied (the client/project was deleted while the entry
 * was archived) — db runs with foreign_keys = ON, so the caller surfaces it.
 */
export function restoreTimeEntry(db: Database.Database, entryId: string): void {
  const move = db.transaction((eid: string) => {
    db.prepare(`
      INSERT INTO crm_time_entries (${TIME_ENTRY_COLUMNS})
      SELECT ${TIME_ENTRY_COLUMNS} FROM crm_time_entries_deleted WHERE id = ?
    `).run(eid);
    db.prepare('DELETE FROM crm_time_entries_deleted WHERE id = ?').run(eid);
  });
  move(entryId);
}
