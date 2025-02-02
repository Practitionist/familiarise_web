import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AppointmentsType } from "@prisma/client";
import { useEffect, useState } from "react";

interface ValidationResult {
  conflicts: Array<{
    slot: string;
    existingAppointment: {
      type: string;
      with: string;
      time: string;
    };
  }>;
  outsideAvailability: Array<{
    slot: string;
  }>;
  validSlots: string[];
}

interface RequestedSlotsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  requestId: string;
  requestType: AppointmentsType;
  requestedSlots: string[];
  onConfirm: (override: boolean) => Promise<void>;
  onCancel: () => void;
}

export function RequestedSlotsDialog({
  open,
  onOpenChange,
  requestId,
  requestType,
  requestedSlots,
  onConfirm,
  onCancel,
}: RequestedSlotsDialogProps) {
  const [loading, setLoading] = useState(false);
  const [validationResult, setValidationResult] =
    useState<ValidationResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Validate slots when dialog opens
  const validateSlots = async () => {
    try {
      setLoading(true);
      setError(null);

      const endpoint =
        requestType === AppointmentsType.SUBSCRIPTION
          ? `/api/events/subscriptions/${requestId}/validate`
          : `/api/events/consultations/${requestId}/validate`;

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ slots: requestedSlots }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to validate slots");
      }

      setValidationResult(data.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to validate slots");
    } finally {
      setLoading(false);
    }
  };

  // Validate on open
  useEffect(() => {
    if (open) {
      validateSlots();
    }
  }, [open, requestId, requestedSlots]);

  // Safe access to validation result arrays
  const conflicts = validationResult?.conflicts || [];
  const outsideAvailability = validationResult?.outsideAvailability || [];
  const hasConflicts = conflicts.length > 0;
  const hasOutsideSlots = outsideAvailability.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Confirm Slot Allocation</DialogTitle>
          <DialogDescription>
            Review requested slots before allocation
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center p-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900"></div>
          </div>
        ) : error ? (
          <div className="bg-red-50 p-4 rounded-md text-red-700">{error}</div>
        ) : (
          validationResult && (
            <>
              {hasConflicts && (
                <div className="bg-red-50 p-4 rounded-md mb-4">
                  <h3 className="font-semibold text-red-700 mb-2">
                    Conflicting Slots
                  </h3>
                  <ul className="space-y-2">
                    {conflicts.map((conflict, index) => (
                      <li key={index} className="text-sm text-red-600">
                        {new Date(conflict.slot).toLocaleString()} - Conflicts
                        with {conflict.existingAppointment.type}
                        with {conflict.existingAppointment.with}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {hasOutsideSlots && (
                <div className="bg-yellow-50 p-4 rounded-md mb-4">
                  <h3 className="font-semibold text-yellow-800 mb-2">
                    Slots Outside Availability
                  </h3>
                  <ul className="space-y-2">
                    {outsideAvailability.map((slot, index) => (
                      <li key={index} className="text-sm text-yellow-700">
                        {new Date(slot.slot).toLocaleString()}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-sm text-yellow-700">
                    These slots are outside your regular availability. You can
                    override and allocate them anyway.
                  </p>
                </div>
              )}

              {!hasConflicts && !hasOutsideSlots && (
                <div className="bg-green-50 p-4 rounded-md mb-4">
                  <h3 className="font-semibold text-green-700">
                    All Slots Available
                  </h3>
                  <p className="text-sm text-green-600">
                    All requested slots are within your availability and have no
                    conflicts.
                  </p>
                </div>
              )}
            </>
          )
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onCancel} disabled={loading}>
            Cancel
          </Button>

          {!hasConflicts && !loading && validationResult && (
            <Button
              variant={hasOutsideSlots ? "destructive" : "default"}
              onClick={() => onConfirm(hasOutsideSlots)}
              disabled={loading}
            >
              {hasOutsideSlots
                ? "Override and Allocate"
                : "Allocate Requested Times"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
