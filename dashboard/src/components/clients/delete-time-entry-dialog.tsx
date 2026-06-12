'use client';

/**
 * DeleteTimeEntryDialog — confirmation for soft-deleting a logged time entry.
 *
 * Mirrors DeleteTaskDialog (shadcn Dialog + in-flight ref guard + busy state).
 * The copy reflects the soft-delete contract: the entry is archived and can be
 * restored (an Undo toast fires after delete), so this is recoverable.
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
import { IconTrash } from '@tabler/icons-react';

export interface DeleteTimeEntryDialogProps {
  open: boolean;
  description: string;
  hours: number;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}

export default function DeleteTimeEntryDialog({
  open,
  description,
  hours,
  onConfirm,
  onCancel,
}: DeleteTimeEntryDialogProps) {
  const [deleting, setDeleting] = useState(false);
  // Synchronous guard: `disabled={deleting}` only lands after a re-render, so a
  // rapid double-click could fire onConfirm twice before it takes. The ref
  // blocks the second call instantly.
  const inFlight = useRef(false);

  const handleConfirm = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setDeleting(true);
    try {
      await onConfirm();
    } finally {
      setDeleting(false);
      inFlight.current = false;
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={o => {
        if (!o && !deleting) onCancel();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <IconTrash size={18} className="text-destructive" />
            Delete time entry
          </DialogTitle>
          <DialogDescription>
            Remove{' '}
            <span className="font-semibold text-foreground">
              {hours.toFixed(1)}h — {description}
            </span>
            ? It moves to the deleted archive and can be restored — you&apos;ll get an Undo.
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={deleting}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleConfirm} disabled={deleting}>
            {deleting ? 'Deleting…' : 'Delete'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
