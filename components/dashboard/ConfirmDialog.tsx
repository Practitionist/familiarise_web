"use client";

import { Loader2 } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
  ResponsiveModalTrigger,
} from "@/components/ui/responsive-modal";
import { Textarea } from "@/components/ui/textarea";

export interface ConfirmDialogProps {
  /** Controlled mode; omit both and pass `trigger` for uncontrolled. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Extra body under the description, e.g. a summary of what changes. */
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "destructive";
  /** Ask for a written reason; confirm stays disabled below `minLength`. */
  requireReason?: { label?: string; minLength?: number; placeholder?: string };
  /** Confirm stays disabled until the user types exactly this. */
  requireTyped?: string;
  /**
   * Throw to keep the dialog open with the error shown inline. The message of
   * a thrown `Error` is shown as-is, so write it for the user.
   */
  onConfirm: (ctx: { reason?: string }) => Promise<void> | void;
}

const GENERIC_FAILURE = "That didn't go through. Please try again.";

/**
 * The one confirmation for destructive and money actions (#1527 Q10): a
 * centred dialog at sm+ and a bottom sheet on mobile, an optional reason
 * (absorbs the admin ReasonDialog, which asked for five characters), an
 * optional typed confirmation, a pending state, and failures shown inside the
 * dialog rather than in a toast that can be missed.
 */
export function ConfirmDialog({
  open: openProp,
  onOpenChange,
  trigger,
  title,
  description,
  children,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "default",
  requireReason,
  requireTyped,
  onConfirm,
}: Readonly<ConfirmDialogProps>) {
  const [openState, setOpenState] = useState(false);
  const [reason, setReason] = useState("");
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reasonId = useId();
  const typedId = useId();
  const errorId = useId();

  const open = openProp ?? openState;
  const setOpen = (next: boolean) => {
    // A request in flight cannot be abandoned by closing the dialog.
    if (pending) return;
    if (!next) {
      setReason("");
      setTyped("");
      setError(null);
    }
    if (openProp === undefined) setOpenState(next);
    onOpenChange?.(next);
  };

  const minLength = requireReason?.minLength ?? 5;
  const reasonOk = !requireReason || reason.trim().length >= minLength;
  const typedOk = !requireTyped || typed === requireTyped;

  const confirm = async () => {
    setPending(true);
    setError(null);
    try {
      await onConfirm({ reason: requireReason ? reason.trim() : undefined });
      setPending(false);
      setReason("");
      setTyped("");
      if (openProp === undefined) setOpenState(false);
      onOpenChange?.(false);
    } catch (caught) {
      setPending(false);
      setError(
        caught instanceof Error && caught.message
          ? caught.message
          : GENERIC_FAILURE,
      );
    }
  };

  return (
    <ResponsiveModal open={open} onOpenChange={setOpen}>
      {trigger && (
        <ResponsiveModalTrigger asChild>{trigger}</ResponsiveModalTrigger>
      )}
      <ResponsiveModalContent className="sm:max-w-md">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (reasonOk && typedOk && !pending) void confirm();
          }}
        >
          <ResponsiveModalHeader>
            <ResponsiveModalTitle>{title}</ResponsiveModalTitle>
            {description && (
              <ResponsiveModalDescription>
                {description}
              </ResponsiveModalDescription>
            )}
          </ResponsiveModalHeader>

          {children}

          {requireReason && (
            <div className="space-y-1.5">
              <Label htmlFor={reasonId}>
                {requireReason.label ?? "Reason"}
              </Label>
              <Textarea
                id={reasonId}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={requireReason.placeholder}
                disabled={pending}
                rows={3}
                aria-describedby={`${reasonId}-hint`}
              />
              <p
                id={`${reasonId}-hint`}
                className="text-xs text-muted-foreground"
              >
                At least {minLength} characters. This is kept in the audit log.
              </p>
            </div>
          )}

          {requireTyped && (
            <div className="space-y-1.5">
              <Label htmlFor={typedId}>
                Type{" "}
                <span className="font-mono font-semibold">{requireTyped}</span>{" "}
                to confirm
              </Label>
              <Input
                id={typedId}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                disabled={pending}
              />
            </div>
          )}

          {error && (
            <p id={errorId} role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <ResponsiveModalFooter className="gap-2 sm:gap-0">
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              {cancelLabel}
            </Button>
            <Button
              type="submit"
              variant={tone === "destructive" ? "destructive" : "default"}
              disabled={pending || !reasonOk || !typedOk}
              aria-describedby={error ? errorId : undefined}
            >
              {pending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
              )}
              {confirmLabel}
            </Button>
          </ResponsiveModalFooter>
        </form>
      </ResponsiveModalContent>
    </ResponsiveModal>
  );
}
