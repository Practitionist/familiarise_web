"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Loader2, AlertTriangle } from "lucide-react";

// These match the CancellationReason enum in Prisma schema
const CANCELLATION_REASONS = [
  {
    value: "SCHEDULE_CONFLICT",
    label: "Schedule conflict",
    description: "I have a scheduling conflict and can't make this time",
  },
  {
    value: "FOUND_ALTERNATIVE",
    label: "Found alternative",
    description: "I've found another option that suits my needs better",
  },
  {
    value: "FINANCIAL_REASONS",
    label: "Financial reasons",
    description: "I can no longer afford this booking",
  },
  {
    value: "PERSONAL_EMERGENCY",
    label: "Personal emergency",
    description: "An unexpected personal situation has come up",
  },
  {
    value: "NO_LONGER_NEEDED",
    label: "No longer needed",
    description: "I no longer need this consultation",
  },
  {
    value: "CONSULTANT_ISSUE",
    label: "Issue with consultant",
    description: "I'm experiencing issues with the consultant",
  },
  {
    value: "TECHNICAL_ISSUE",
    label: "Technical issues",
    description: "I'm having technical problems with the platform",
  },
  {
    value: "OTHER",
    label: "Other reason",
    description: "Another reason not listed here",
  },
] as const;

type CancellationReason = (typeof CANCELLATION_REASONS)[number]["value"];

interface CancellationReasonModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (reason: CancellationReason, notes?: string) => Promise<void>;
  bookingType?: "consultation" | "subscription";
  bookingTitle?: string;
}

export function CancellationReasonModal({
  isOpen,
  onClose,
  onConfirm,
  bookingType = "consultation",
  bookingTitle,
}: CancellationReasonModalProps) {
  const [selectedReason, setSelectedReason] =
    useState<CancellationReason | null>(null);
  const [notes, setNotes] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = async () => {
    if (!selectedReason) {
      setError("Please select a reason for cancellation");
      return;
    }

    setError(null);
    setIsSubmitting(true);

    try {
      await onConfirm(selectedReason, notes || undefined);
      // Reset state on success
      setSelectedReason(null);
      setNotes("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to cancel booking");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    if (!isSubmitting) {
      setSelectedReason(null);
      setNotes("");
      setError(null);
      onClose();
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            Cancel {bookingType}
          </DialogTitle>
          <DialogDescription>
            {bookingTitle ? (
              <>Are you sure you want to cancel &quot;{bookingTitle}&quot;?</>
            ) : (
              <>Are you sure you want to cancel this {bookingType}?</>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Reason Selection */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">
              Please select a reason for cancellation
            </Label>
            <RadioGroup
              value={selectedReason || ""}
              onValueChange={(value) =>
                setSelectedReason(value as CancellationReason)
              }
              className="space-y-2"
            >
              {CANCELLATION_REASONS.map((reason) => (
                <div
                  key={reason.value}
                  className={`flex items-start space-x-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                    selectedReason === reason.value
                      ? "border-primary bg-primary/5"
                      : "border-zinc-200 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                  }`}
                  onClick={() => setSelectedReason(reason.value)}
                >
                  <RadioGroupItem value={reason.value} id={reason.value} />
                  <div className="flex-1">
                    <Label
                      htmlFor={reason.value}
                      className="font-medium cursor-pointer"
                    >
                      {reason.label}
                    </Label>
                    <p className="text-xs text-zinc-500">
                      {reason.description}
                    </p>
                  </div>
                </div>
              ))}
            </RadioGroup>
          </div>

          {/* Additional Notes */}
          <div className="space-y-2">
            <Label htmlFor="notes" className="text-sm font-medium">
              Additional notes (optional)
            </Label>
            <Textarea
              id="notes"
              placeholder="Please provide any additional details about your cancellation..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              disabled={isSubmitting}
            />
          </div>

          {/* Error Message */}
          {error && (
            <p className="text-sm text-red-500 bg-red-50 dark:bg-red-950 p-2 rounded">
              {error}
            </p>
          )}

          {/* Refund Info */}
          <div className="text-xs text-zinc-500 bg-zinc-50 dark:bg-zinc-900 p-3 rounded">
            <p>
              <strong>Note:</strong> Cancellation policy may apply. Refund
              eligibility depends on the time until the scheduled appointment.
              Please check our cancellation policy for more details.
            </p>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            variant="outline"
            onClick={handleClose}
            disabled={isSubmitting}
          >
            Keep Booking
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={!selectedReason || isSubmitting}
          >
            {isSubmitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Cancelling...
              </>
            ) : (
              "Confirm Cancellation"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { CANCELLATION_REASONS };
export type { CancellationReason };
