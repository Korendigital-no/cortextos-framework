'use client';

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

export interface DeleteNoteDialogProps {
  open: boolean;
  notePreview: string;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}

export default function DeleteNoteDialog({
  open,
  notePreview,
  onConfirm,
  onCancel,
}: DeleteNoteDialogProps) {
  const [deleting, setDeleting] = useState(false);
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
            Delete note
          </DialogTitle>
          <DialogDescription>
            This will permanently remove the note{notePreview ? ': ' : '.'}
            {notePreview && (
              <span className="font-semibold text-foreground">
                &ldquo;{notePreview}&rdquo;
              </span>
            )}
            {notePreview ? '. ' : ''}This action cannot be undone.
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
