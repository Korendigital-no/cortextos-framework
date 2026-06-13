'use client';

/**
 * DeleteClientDialog — confirmation for removing a client. The action is
 * system-decided from billing history, and the copy reflects it:
 *  - a client that ever logged time is ARCHIVED (recoverable, billing history
 *    preserved) — never hard-deleted, for accounting integrity. An Undo follows.
 *  - a client with no logged time is permanently deleted (truly empty).
 * Mirrors DeleteTimeEntryDialog (shadcn Dialog + in-flight ref guard).
 */

import { useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { IconArchive, IconTrash } from '@tabler/icons-react';

export interface DeleteClientDialogProps {
  open: boolean;
  companyName: string;
  /** True when the client has logged time (live or archived) → archive path. */
  hasTimeHistory: boolean;
  entryCount: number;
  totalHours: number;
  projectCount: number;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}

export default function DeleteClientDialog({
  open,
  companyName,
  hasTimeHistory,
  entryCount,
  totalHours,
  projectCount,
  onConfirm,
  onCancel,
}: DeleteClientDialogProps) {
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const handleConfirm = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  };

  return (
    <Dialog open={open} onOpenChange={o => { if (!o && !busy) onCancel(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {hasTimeHistory ? (
              <IconArchive size={18} className="text-amber-600" />
            ) : (
              <IconTrash size={18} className="text-destructive" />
            )}
            {hasTimeHistory ? 'Archive client' : 'Delete client'}
          </DialogTitle>
          <DialogDescription>
            {hasTimeHistory
              ? 'This client has billing history, so it is archived (recoverable), not deleted.'
              : 'This client has no logged time.'}
          </DialogDescription>
        </DialogHeader>

        <div className="text-sm text-muted-foreground space-y-2">
          {hasTimeHistory ? (
            <>
              <p>
                <span className="font-semibold text-foreground">{companyName}</span> has logged time
                {' '}({entryCount} {entryCount === 1 ? 'entry' : 'entries'}, {totalHours.toFixed(1)}h)
                {projectCount > 0 && <> across {projectCount} {projectCount === 1 ? 'project' : 'projects'}</>}.
              </p>
              <p>
                To preserve billing history it will be <span className="font-medium text-foreground">archived</span> —
                hidden from your client list but fully recoverable. You&apos;ll get an Undo.
              </p>
            </>
          ) : (
            <p>
              <span className="font-semibold text-foreground">{companyName}</span> has no logged time.
              This permanently deletes the client{projectCount > 0 && <> and its {projectCount} {projectCount === 1 ? 'project' : 'projects'}</>}. This cannot be undone.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button
            variant={hasTimeHistory ? 'default' : 'destructive'}
            onClick={handleConfirm}
            disabled={busy}
          >
            {busy ? 'Working…' : hasTimeHistory ? 'Archive client' : 'Delete client'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
