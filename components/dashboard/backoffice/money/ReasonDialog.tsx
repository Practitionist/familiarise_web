"use client";

import { useEffect, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export const MIN_REASON_LENGTH = 5;

/**
 * #1771 K-1 — every console door asks why before it acts; the reason lands
 * in the OpsActionLog row. Extra fields (an amount, a date) ride as children.
 */
export function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  pending,
  canConfirm = true,
  onConfirm,
  children,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  pending: boolean;
  canConfirm?: boolean;
  onConfirm: (reason: string) => void;
  children?: ReactNode;
}>) {
  const [reason, setReason] = useState("");
  // A parent closing the dialog (success, Cancel) must not leave this
  // reason for the next door's audit row.
  useEffect(() => {
    if (!open) setReason("");
  }, [open]);
  const ready = reason.trim().length >= MIN_REASON_LENGTH && canConfirm;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {children}
          <div className="space-y-1.5">
            <Label htmlFor="ops-reason">Reason (kept in the audit log)</Label>
            <Textarea
              id="ops-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why are you doing this?"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            onClick={() => onConfirm(reason.trim())}
            disabled={!ready || pending}
          >
            {pending ? "Working…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
