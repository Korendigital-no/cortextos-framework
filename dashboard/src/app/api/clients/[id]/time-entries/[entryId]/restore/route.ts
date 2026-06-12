import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { restoreTimeEntry } from '@/lib/time-entry-archive';

export const dynamic = 'force-dynamic';

interface DeletedEntryRow { id: string; client_id: string; }

/** A deleted entry is restorable only by the client it belonged to — same
 *  tenancy guard as entryBelongsToClient, against the archive table. */
function deletedEntryBelongsToClient(entryId: string, clientId: string): DeletedEntryRow | null {
  const row = db
    .prepare('SELECT id, client_id FROM crm_time_entries_deleted WHERE id = ?')
    .get(entryId) as DeletedEntryRow | undefined;
  if (!row || row.client_id !== clientId) return null;
  return row;
}

/**
 * Restore a soft-deleted time entry — the inverse of DELETE: MOVE it back from
 * crm_time_entries_deleted into crm_time_entries (transactional). Powers the
 * undo-toast and any "recently deleted" restore affordance.
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string; entryId: string }> }) {
  const { id: clientId, entryId } = await params;
  if (!deletedEntryBelongsToClient(entryId, clientId)) {
    return Response.json({ error: 'Deleted time entry not found' }, { status: 404 });
  }
  try {
    restoreTimeEntry(db, entryId);
  } catch (err) {
    // db.ts runs with foreign_keys = ON. If the client/project was deleted while
    // this entry sat in the archive, the re-INSERT's FK fails — surface it loudly
    // (409) rather than silently losing the restore.
    return Response.json(
      { error: `Could not restore time entry: ${err instanceof Error ? err.message : String(err)}` },
      { status: 409 },
    );
  }
  return Response.json({ ok: true });
}
