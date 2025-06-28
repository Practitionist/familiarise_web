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
import { AllocationService } from "../../shared/utils/allocationService";
import { TimeSlot } from "../../shared/utils/calendarUtils";

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

      const eventType =
        requestType === AppointmentsType.SUBSCRIPTION
          ? "subscription"
          : "consultation";

      // Convert requested slots to TimeSlot objects
      const timeSlots: TimeSlot[] = requestedSlots.map((slotString) => {
        const startTime = new Date(slotString);
        const endTime = new Date(startTime.getTime() + 30 * 60 * 1000); // 30 minutes later
        return {
          startTime,
          endTime,
          isAvailable: true,
          isBooked: false,
        };
      });

      const validationResponse = await AllocationService.validateSlots(
        eventType,
        requestId,
        timeSlots,
      );

      if (!validationResponse.success) {
        throw new Error(validationResponse.error || "Failed to validate slots");
      }

      setValidationResult(validationResponse.data || null);
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

  const renderDialogContent = () => {
    if (loading) {
      return (
        <div className="flex items-center justify-center p-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900"></div>
        </div>
      );
    }

    if (error) {
      return (
        <div className="bg-red-50 p-4 rounded-md text-red-700">{error}</div>
      );
    }

    if (validationResult) {
      return (
        <>
          {hasConflicts && (
            <div className="bg-red-50 p-4 rounded-md mb-4">
              <h3 className="font-semibold text-red-700 mb-2">
                Conflicting Slots
              </h3>
              <ul className="space-y-2">
                {conflicts.map((conflict) => (
                  <li key={conflict.slot} className="text-sm text-red-600">
                    {new Date(conflict.slot).toLocaleString()} - Conflicts with{" "}
                    {conflict.existingAppointment.type} with{" "}
                    {conflict.existingAppointment.with}
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
                {outsideAvailability.map((slot) => (
                  <li key={slot.slot} className="text-sm text-yellow-700">
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
      );
    }

    return null; // Should not happen if validation runs on open
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Confirm Slot Allocation</DialogTitle>
          <DialogDescription>
            Review requested slots before allocation
          </DialogDescription>
        </DialogHeader>

        {renderDialogContent()}

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
