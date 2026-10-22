"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/** A one-off action that asks for its own reason inline before it runs. */
export function ReasonAction({
  label,
  confirmLabel,
  busy,
  minLength = 1,
  onConfirm,
}: Readonly<{
  label: string;
  confirmLabel: string;
  busy: boolean;
  minLength?: number;
  onConfirm: (reason: string, done: () => void) => void;
}>) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (open) field.current?.focus();
  }, [open]);
  if (!open)
    return (
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => setOpen(true)}
      >
        {label}
      </Button>
    );
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        onConfirm(reason.trim(), () => {
          setOpen(false);
          setReason("");
        });
      }}
    >
      <Textarea
        ref={field}
        aria-label={`Reason: ${label}`}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="Reason (kept in the case's private history)"
        required
      />
      <div className="flex gap-2">
        <Button size="sm" disabled={busy || reason.trim().length < minLength}>
          {confirmLabel}
        </Button>
        <Button
          size="sm"
          type="button"
          variant="ghost"
          onClick={() => setOpen(false)}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
