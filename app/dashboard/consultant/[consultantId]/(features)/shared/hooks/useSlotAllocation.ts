import { useState, useCallback, useEffect } from "react";
import { useToast } from "@/components/ui/use-toast";
import {
  TimeSlot,
  validateSelectedSlots,
  calculateRequiredSlots,
} from "../utils/calendarUtils";
import {
  AllocationAlgorithms,
  AllocationOptions,
  AllocationResult,
} from "../utils/allocationAlgorithms";

export interface UseSlotAllocationOptions {
  eventType: "consultation" | "subscription" | "webinar" | "class";
  eventId: string;
  durationInMonths?: number;
  callsPerWeek?: number;
  sessionDurationInHours?: number;
  onSuccess?: (result: AllocationResult) => void;
  onError?: (error: string) => void;
}

export interface UseSlotAllocationReturn {
  selectedSlots: TimeSlot[];
  setSelectedSlots: (slots: TimeSlot[]) => void;
  isAllocating: boolean;
  allocationError: string | null;
  requiredSlots: number;
  canAllocate: boolean;

  // Slot management
  toggleSlot: (slot: TimeSlot) => void;
  clearSlots: () => void;
  isSlotSelected: (slot: TimeSlot) => boolean;

  // Allocation methods
  manualAllocate: () => Promise<void>;
  autoAllocate: (availableSlots: TimeSlot[]) => Promise<void>;
  preAllocate: (requestedSlots: TimeSlot[]) => Promise<void>;

  // Validation
  validateSlots: () => { isValid: boolean; errorMessage?: string };
}

/**
 * Custom hook for managing slot allocation logic
 */
export function useSlotAllocation(
  options: UseSlotAllocationOptions,
): UseSlotAllocationReturn {
  const {
    eventType,
    eventId,
    durationInMonths,
    callsPerWeek,
    sessionDurationInHours,
    onSuccess,
    onError,
  } = options;

  const { toast } = useToast();

  // State
  const [selectedSlots, setSelectedSlots] = useState<TimeSlot[]>([]);
  const [isAllocating, setIsAllocating] = useState(false);
  const [allocationError, setAllocationError] = useState<string | null>(null);
  const [validationMessage, setValidationMessage] = useState<string | null>(
    null,
  );
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Calculate required slots
  const requiredSlots = calculateRequiredSlots(
    eventType,
    durationInMonths,
    callsPerWeek,
    sessionDurationInHours,
  );

  // Check if we can allocate (have the right number of slots)
  const canAllocate = selectedSlots.length === requiredSlots;

  // Handle validation messages with toast
  useEffect(() => {
    if (validationMessage) {
      toast({
        variant: "destructive",
        title: "Selection Error",
        description: validationMessage,
      });
      setValidationMessage(null); // Clear after showing
    }
  }, [validationMessage, toast]);

  // Handle success messages with toast
  useEffect(() => {
    if (successMessage) {
      toast({
        title: "Success",
        description: successMessage,
      });
      setSuccessMessage(null); // Clear after showing
    }
  }, [successMessage, toast]);

  // Toggle slot selection
  const toggleSlot = useCallback(
    (slot: TimeSlot) => {
      setSelectedSlots((current) => {
        const isSelected = current.some(
          (s) => s.startTime.getTime() === slot.startTime.getTime(),
        );

        if (isSelected) {
          // Remove slot
          return current.filter(
            (s) => s.startTime.getTime() !== slot.startTime.getTime(),
          );
        } else {
          // Add slot (with limits)
          if (eventType === "consultation") {
            // Single slot events - replace selection
            return [slot];
          } else if (eventType === "webinar") {
            // For webinars, check if it's single or multi-slot based on duration
            const webinarRequiredSlots = calculateRequiredSlots(
              eventType,
              undefined,
              undefined,
              sessionDurationInHours,
            );
            if (webinarRequiredSlots === 1) {
              // Single slot webinar - replace selection
              return [slot];
            } else {
              // Multi-slot webinar - allow adding up to required slots
              if (current.length >= webinarRequiredSlots) {
                setValidationMessage(
                  `You can only select ${webinarRequiredSlots} consecutive slots for this ${sessionDurationInHours || 1} hour webinar.`,
                );
                return current;
              } else {
                // Add slot and validate consecutiveness
                const newSelection = [...current, slot].sort(
                  (a, b) => a.startTime.getTime() - b.startTime.getTime(),
                );

                // Validate consecutive slots for multi-slot webinars
                if (newSelection.length > 1) {
                  for (let i = 1; i < newSelection.length; i++) {
                    const prevSlot = newSelection[i - 1];
                    const currentSlot = newSelection[i];
                    if (
                      currentSlot.startTime.getTime() !==
                      prevSlot.endTime.getTime()
                    ) {
                      setValidationMessage("Webinar slots must be consecutive");
                      return current;
                    }
                  }
                }

                return newSelection;
              }
            }
          } else {
            // Handle subscription/class events
            if (current.length >= requiredSlots) {
              // Multi-slot events - add if under limit
              setValidationMessage(
                `You can only select ${requiredSlots} slots for this ${eventType}.`,
              );
              return current;
            } else {
              // Add slot with validation
              // For subscription/class, validate weekly distribution
              const newSelection = [...current, slot].sort(
                (a, b) => a.startTime.getTime() - b.startTime.getTime(),
              );

              if (callsPerWeek) {
                const validation = validateSlotDistribution(
                  newSelection,
                  callsPerWeek,
                );
                if (!validation.isValid) {
                  setValidationMessage(
                    validation.errorMessage || "Invalid slot distribution",
                  );
                  return current;
                }
              }

              return newSelection;
            }
          }
        }
      });
    },
    [eventType, requiredSlots, callsPerWeek, sessionDurationInHours],
  );

  // Clear all selected slots
  const clearSlots = useCallback(() => {
    setSelectedSlots([]);
    setAllocationError(null);
  }, []);

  // Check if a slot is selected
  const isSlotSelected = useCallback(
    (slot: TimeSlot) => {
      return selectedSlots.some(
        (s) => s.startTime.getTime() === slot.startTime.getTime(),
      );
    },
    [selectedSlots],
  );

  // Validate current selection
  const validateSlots = useCallback(() => {
    const validation = validateSelectedSlots(
      selectedSlots,
      eventType,
      requiredSlots,
      sessionDurationInHours,
    );

    if (!validation.isValid) {
      return validation;
    }

    // Additional validation for subscription/class distribution
    if (
      (eventType === "subscription" || eventType === "class") &&
      callsPerWeek
    ) {
      return validateSlotDistribution(selectedSlots, callsPerWeek);
    }

    return { isValid: true };
  }, [
    selectedSlots,
    eventType,
    requiredSlots,
    callsPerWeek,
    sessionDurationInHours,
  ]);

  // Manual allocation using selected slots
  const manualAllocate = useCallback(async () => {
    const validation = validateSlots();
    if (!validation.isValid) {
      const errorMessage = validation.errorMessage || "Invalid slot selection";
      setAllocationError(errorMessage);
      setValidationMessage(errorMessage);
      onError?.(errorMessage);
      return;
    }

    setIsAllocating(true);
    setAllocationError(null);

    try {
      const allocationOptions: AllocationOptions = {
        eventType,
        eventId,
        durationInMonths,
        callsPerWeek,
        sessionDurationInHours,
      };

      const result = await AllocationAlgorithms.manualAllocate(
        selectedSlots,
        allocationOptions,
      );

      if (result.success) {
        setSuccessMessage("Slots allocated successfully");
        onSuccess?.(result);
      } else {
        const errorMessage = result.error || "Manual allocation failed";
        setAllocationError(errorMessage);
        setValidationMessage(errorMessage);
        onError?.(errorMessage);
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Allocation failed";
      setAllocationError(errorMessage);
      setValidationMessage(errorMessage);
      onError?.(errorMessage);
    } finally {
      setIsAllocating(false);
    }
  }, [
    selectedSlots,
    validateSlots,
    eventType,
    eventId,
    durationInMonths,
    callsPerWeek,
    onSuccess,
    onError,
  ]);

  // Auto allocation
  const autoAllocate = useCallback(
    async (availableSlots: TimeSlot[]) => {
      setIsAllocating(true);
      setAllocationError(null);

      try {
        const allocationOptions: AllocationOptions = {
          eventType,
          eventId,
          durationInMonths,
          callsPerWeek,
          sessionDurationInHours,
        };

        const result = await AllocationAlgorithms.autoAllocate(
          availableSlots,
          allocationOptions,
        );

        if (result.success) {
          setSelectedSlots(result.selectedSlots);
          toast({
            title: "Success",
            description: "Slots auto-allocated successfully",
          });
          onSuccess?.(result);
        } else {
          const errorMessage = result.error || "Auto allocation failed";
          setAllocationError(errorMessage);
          toast({
            variant: "destructive",
            title: "Auto Allocation Failed",
            description: errorMessage,
          });
          onError?.(errorMessage);
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Auto allocation failed";
        setAllocationError(errorMessage);
        toast({
          variant: "destructive",
          title: "Auto Allocation Error",
          description: errorMessage,
        });
        onError?.(errorMessage);
      } finally {
        setIsAllocating(false);
      }
    },
    [
      eventType,
      eventId,
      durationInMonths,
      callsPerWeek,
      toast,
      onSuccess,
      onError,
    ],
  );

  // Pre-allocation using requested slots
  const preAllocate = useCallback(
    async (requestedSlots: TimeSlot[]) => {
      setIsAllocating(true);
      setAllocationError(null);

      try {
        const allocationOptions: AllocationOptions = {
          eventType,
          eventId,
          durationInMonths,
          callsPerWeek,
          sessionDurationInHours,
          requestedSlots,
        };

        const result =
          await AllocationAlgorithms.preAllocate(allocationOptions);

        if (result.success) {
          setSelectedSlots(result.selectedSlots);
          toast({
            title: "Success",
            description: "Requested slots allocated successfully",
          });
          onSuccess?.(result);
        } else {
          const errorMessage = result.error || "Pre-allocation failed";
          setAllocationError(errorMessage);
          toast({
            variant: "destructive",
            title: "Pre-allocation Failed",
            description: errorMessage,
          });
          onError?.(errorMessage);
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Pre-allocation failed";
        setAllocationError(errorMessage);
        toast({
          variant: "destructive",
          title: "Pre-allocation Error",
          description: errorMessage,
        });
        onError?.(errorMessage);
      } finally {
        setIsAllocating(false);
      }
    },
    [
      eventType,
      eventId,
      durationInMonths,
      callsPerWeek,
      toast,
      onSuccess,
      onError,
    ],
  );

  return {
    // State
    selectedSlots,
    setSelectedSlots,
    isAllocating,
    allocationError,
    requiredSlots,
    canAllocate,

    // Slot management
    toggleSlot,
    clearSlots,
    isSlotSelected,

    // Allocation methods
    manualAllocate,
    autoAllocate,
    preAllocate,

    // Validation
    validateSlots,
  };
}

/**
 * Helper function to validate slot distribution for subscriptions/classes
 */
function validateSlotDistribution(
  slots: TimeSlot[],
  callsPerWeek: number,
): { isValid: boolean; errorMessage?: string } {
  const slotsByWeek = new Map<string, TimeSlot[]>();

  slots.forEach((slot) => {
    const weekStart = getWeekStart(slot.startTime);
    const weekKey = weekStart.toISOString();

    if (!slotsByWeek.has(weekKey)) {
      slotsByWeek.set(weekKey, []);
    }
    slotsByWeek.get(weekKey)!.push(slot);
  });

  for (const [weekKey, weekSlots] of Array.from(slotsByWeek.entries())) {
    if (weekSlots.length > callsPerWeek) {
      const weekDate = new Date(weekKey);
      return {
        isValid: false,
        errorMessage: `Too many slots selected for week of ${weekDate.toLocaleDateString()} (max ${callsPerWeek} allowed)`,
      };
    }
  }

  return { isValid: true };
}

/**
 * Helper function to get the start of the week for a given date
 */
function getWeekStart(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day; // Sunday as start of week
  return new Date(d.setDate(diff));
}
