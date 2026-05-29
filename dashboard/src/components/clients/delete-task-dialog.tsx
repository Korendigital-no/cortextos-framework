'use client';

/**
 * DeleteTaskDialog — confirmation dialog for client-task deletion.
 *
 * Mirrors DeleteCronDialog: uses the shadcn/ui Dialog primitive, a destructive
 * confirm button, and a busy state while the delete is in flight.
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
import { IconTrash, IconRefresh } from '@tabler/icons-react';

export interface DeleteTaskDialogProps {
  open: boolean;
  taskTitle: string;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}

export default function DeleteTaskDialog({
  open,
  taskTitle,
  onConfirm,
  onCancel,
}: DeleteTaskDialogProps) {
  const [deleting, setDeleting] = useState(false);
  // Synchronous guard: `disabled={deleting}` only takes effect after React
  // re-renders, so a rapid double-click / Enter could fire onConfirm twice
  // before the disabled state lands. The ref blocks the second call instantly.
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
      onOpenChange={open => {
        if (!open && !deleting) onCancel();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <IconTrash size={18} className="text-destructive" />
            Delete task
          </DialogTitle>
          <DialogDescription>
            This will permanently remove{' '}
            <span className="font-semibold text-foreground">{taskTitle}</span>.{' '}
            This action cannot be undone.
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={deleting}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={deleting}
            className="min-w-[100px]"
          >
            {deleting ? (
              <>
                <IconRefresh size={14} className="mr-1.5 animate-spin" />
                Deleting...
              </>
            ) : (
              <>
                <IconTrash size={14} className="mr-1.5" />
                Delete
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
