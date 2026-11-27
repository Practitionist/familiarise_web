"use client";

import { Loader2 } from "lucide-react";
import { useId, useState } from "react";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from "@/components/ui/responsive-modal";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  CONDUCT_REMOVAL_NOTE_MAX,
  CONDUCT_REMOVAL_REASONS,
  CONDUCT_REMOVAL_REASON_LABELS,
  ConductRemovalReasonSchema,
  type ConductRemovalReasonInput,
} from "@/schemas/conduct-removal";

export type RemovalChoice =
  { mode: "NO_FAULT" } | ({ mode: "CONDUCT" } & ConductRemovalReasonInput);

export interface RemoveParticipantDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  attendeeName: string | null;
  eventTitle: string;
  /** The roster also offers a no-fault removal (full refund now, nothing held). */
  allowNoFault: boolean;
  /** The seat was never paid for, so a no-fault removal refunds nothing. */
  freeSeat?: boolean;
  /** Throw to keep the dialog open; the message of a thrown Error is shown as-is. */
  onSubmit: (choice: RemovalChoice) => Promise<void>;
}

const RemovalMode = z.enum(["NO_FAULT", "CONDUCT"]);

const GENERIC_FAILURE = "That didn't go through. Please try again.";

/**
 * Removing an attendee from a group event. A conduct removal records why and
 * is reviewed by support; a no-fault removal (the roster only) refunds in full.
 */
export function RemoveParticipantDialog({
  open,
  onOpenChange,
  attendeeName,
  eventTitle,
  allowNoFault,
  freeSeat = false,
  onSubmit,
}: Readonly<RemoveParticipantDialogProps>) {
  const [mode, setMode] = useState<RemovalChoice["mode"]>(
    allowNoFault ? "NO_FAULT" : "CONDUCT",
  );
  const [reason, setReason] = useState<string>("");
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const noteId = useId();
  const errorId = useId();

  const conduct = ConductRemovalReasonSchema.safeParse({
    reason,
    note: note || undefined,
  });
  const canSubmit = mode === "NO_FAULT" || conduct.success;

  const close = (next: boolean) => {
    // A request in flight cannot be abandoned by closing the dialog.
    if (pending) return;
    if (!next) {
      setMode(allowNoFault ? "NO_FAULT" : "CONDUCT");
      setReason("");
      setNote("");
      setError(null);
    }
    onOpenChange(next);
  };

  const submit = async () => {
    const choice: RemovalChoice | null =
      mode === "NO_FAULT"
        ? { mode: "NO_FAULT" }
        : conduct.success
          ? { mode: "CONDUCT", ...conduct.data }
          : null;
    if (!choice) return;
    setPending(true);
    setError(null);
    try {
      await onSubmit(choice);
      setPending(false);
      close(false);
    } catch (error_) {
      setPending(false);
      setError(
        error_ instanceof Error && error_.message
          ? error_.message
          : GENERIC_FAILURE,
      );
    }
  };

  return (
    <ResponsiveModal open={open} onOpenChange={close}>
      <ResponsiveModalContent className="sm:max-w-md">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit && !pending) void submit();
          }}
        >
          <ResponsiveModalHeader>
            <ResponsiveModalTitle>
              Remove {attendeeName ?? "this attendee"}?
            </ResponsiveModalTitle>
            <ResponsiveModalDescription>
              They lose access to {eventTitle} and their seat is released back
              to the event.
            </ResponsiveModalDescription>
          </ResponsiveModalHeader>

          {allowNoFault && (
            <RadioGroup
              value={mode}
              onValueChange={(v) => {
                const next = RemovalMode.safeParse(v);
                if (next.success) setMode(next.data);
              }}
              className="space-y-2"
              disabled={pending}
            >
              <div className="flex items-start gap-3 rounded-md border p-3">
                <RadioGroupItem
                  value="NO_FAULT"
                  id="remove-no-fault"
                  className="mt-0.5"
                />
                <Label htmlFor="remove-no-fault" className="space-y-0.5">
                  <span className="block font-medium">
                    Remove with a full refund
                  </span>
                  <span className="block text-xs font-normal text-muted-foreground">
                    For a mistaken enrolment. Refunded now; nothing is held.
                  </span>
                </Label>
              </div>
              <div className="flex items-start gap-3 rounded-md border p-3">
                <RadioGroupItem
                  value="CONDUCT"
                  id="remove-conduct"
                  className="mt-0.5"
                />
                <Label htmlFor="remove-conduct" className="space-y-0.5">
                  <span className="block font-medium">Remove for conduct</span>
                  <span className="block text-xs font-normal text-muted-foreground">
                    For disruptive or abusive behaviour. Support reviews it.
                  </span>
                </Label>
              </div>
            </RadioGroup>
          )}

          {mode === "CONDUCT" && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>Reason</Label>
                <Select
                  value={reason}
                  onValueChange={setReason}
                  disabled={pending}
                >
                  <SelectTrigger aria-label="Reason for removal">
                    <SelectValue placeholder="Choose a reason" />
                  </SelectTrigger>
                  <SelectContent>
                    {CONDUCT_REMOVAL_REASONS.map((value) => (
                      <SelectItem key={value} value={value}>
                        {CONDUCT_REMOVAL_REASON_LABELS[value]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={noteId}>
                  Note {reason === "OTHER" ? "" : "(optional)"}
                </Label>
                <Textarea
                  id={noteId}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={CONDUCT_REMOVAL_NOTE_MAX}
                  rows={3}
                  disabled={pending}
                  placeholder="What happened, in a sentence or two"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {attendeeName ?? "The attendee"} will see this reason and note,
                and is blocked from this event&apos;s calls. Your earnings from
                this seat are held while support reviews it; support decides
                within 72 hours. If support overturns the removal, whatever is
                still unrefunded on their seat goes back to them. If support
                doesn&apos;t decide in time, they are refunded the sessions that
                had not been delivered when you removed them.
              </p>
            </div>
          )}

          {mode === "NO_FAULT" && (
            <p className="text-xs text-muted-foreground">
              {freeSeat
                ? "Their seat was free, so there is nothing to refund."
                : "Their seat is refunded in full at any notice, including after the session has started."}
            </p>
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
              onClick={() => close(false)}
              disabled={pending}
            >
              Keep them enrolled
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={pending || !canSubmit}
              aria-describedby={error ? errorId : undefined}
            >
              {pending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
              )}
              {mode === "NO_FAULT" && !freeSeat
                ? "Remove and refund"
                : "Remove"}
            </Button>
          </ResponsiveModalFooter>
        </form>
      </ResponsiveModalContent>
    </ResponsiveModal>
  );
}
