"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/** What the confirm dialog asks before a session action runs. */
export interface PendingConfirm {
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
}

/** One controlled confirm dialog for every row action on the page. */
export function SessionConfirmDialog({
  pending,
  onClose,
}: Readonly<{ pending: PendingConfirm | null; onClose: () => void }>) {
  return (
    <AlertDialog open={!!pending} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{pending?.title}</AlertDialogTitle>
          <AlertDialogDescription>{pending?.body}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              pending?.onConfirm();
              onClose();
            }}
          >
            {pending?.confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
