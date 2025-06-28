import { useState, useEffect, useCallback, useMemo } from "react";
import { useToast } from "@/components/ui/use-toast";
import {
  TimeSlot,
  ConsultantData,
  Appointment,
  mapWeeklySlots,
  mapCustomSlots,
  getSlotStatus,
} from "../utils/calendarUtils";
import { AllocationService } from "../utils/allocationService";
import { ScheduleType } from "@prisma/client";

export interface UseCalendarDataOptions {
  consultantId: string;
  eventType?: "consultation" | "subscription" | "webinar" | "class";
  eventId?: string;
  autoLoad?: boolean;
}

export interface CalendarData {
  consultantDetails: ConsultantData | null;
  availableSlots: TimeSlot[];
  existingAppointments: Appointment[];
  rawAvailabilitySlots: {
    weekly: any[];
    custom: any[];
  };
  eventSlots: TimeSlot[];
  loading: boolean;
  error: string | null;
}

export interface UseCalendarDataReturn extends CalendarData {
  refetch: () => Promise<void>;
  refetchConsultant: () => Promise<void>;
  refetchAvailability: () => Promise<void>;
  refetchAppointments: () => Promise<void>;
  refetchEventSlots: () => Promise<void>;
  getSlotStatusForInterval: (
    interval: { hour: number; minute: number },
    date: Date,
  ) => any;
}

/**
 * Custom hook for managing calendar data fetching and state
 */
export function useCalendarData(
  options: UseCalendarDataOptions,
): UseCalendarDataReturn {
  const { consultantId, eventType, eventId, autoLoad = true } = options;
  const { toast } = useToast();

  // State
  const [consultantDetails, setConsultantDetails] =
    useState<ConsultantData | null>(null);
  const [rawAvailabilitySlots, setRawAvailabilitySlots] = useState<{
    weekly: any[];
    custom: any[];
  }>({ weekly: [], custom: [] });
  const [existingAppointments, setExistingAppointments] = useState<
    Appointment[]
  >([]);
  const [eventSlots, setEventSlots] = useState<TimeSlot[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Computed available slots
  const availableSlots = useMemo(() => {
    if (!consultantDetails) return [];

    const consultantDataForMapping = {
      ...consultantDetails,
      slotsOfAvailabilityWeekly: rawAvailabilitySlots.weekly,
      slotsOfAvailabilityCustom: rawAvailabilitySlots.custom,
    };

    if (consultantDetails.scheduleType === ScheduleType.WEEKLY) {
      return mapWeeklySlots(consultantDataForMapping, new Date(), "month");
    } else if (consultantDetails.scheduleType === ScheduleType.CUSTOM) {
      return mapCustomSlots(consultantDataForMapping);
    }

    return [];
  }, [consultantDetails, rawAvailabilitySlots]);

  // Fetch consultant details
  const fetchConsultantDetails = useCallback(async () => {
    if (!consultantId) return;

    try {
      const data = await AllocationService.fetchConsultantData(consultantId);
      setConsultantDetails(data);
    } catch (error) {
      console.error("Error fetching consultant details:", error);
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Failed to fetch consultant data";
      setError(errorMessage);
      toast({
        variant: "destructive",
        title: "Error",
        description: errorMessage,
      });
    }
  }, [consultantId, toast]);

  // Fetch availability slots
  const fetchAvailabilitySlots = useCallback(async () => {
    if (!consultantId) return;

    try {
      const data = await AllocationService.fetchAvailabilitySlots(consultantId);
      setRawAvailabilitySlots(data);
    } catch (error) {
      console.error("Error fetching availability slots:", error);
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Failed to fetch availability data";
      setError(errorMessage);
      toast({
        variant: "destructive",
        title: "Error",
        description: errorMessage,
      });
    }
  }, [consultantId, toast]);

  // Fetch existing appointments
  const fetchExistingAppointments = useCallback(async () => {
    if (!consultantId) return;

    try {
      const data = await AllocationService.fetchAppointments(consultantId);
      setExistingAppointments(data);
    } catch (error) {
      console.error("Error fetching appointments:", error);
      const errorMessage =
        error instanceof Error ? error.message : "Failed to fetch appointments";
      setError(errorMessage);
      toast({
        variant: "destructive",
        title: "Error",
        description: errorMessage,
      });
    }
  }, [consultantId, toast]);

  // Fetch event-specific slots
  const fetchEventSlots = useCallback(async () => {
    if (
      !eventType ||
      !eventId ||
      (eventType !== "webinar" && eventType !== "class")
    ) {
      setEventSlots([]);
      return;
    }

    try {
      const data = await AllocationService.fetchEventSlots(eventType, eventId);

      if (data && data.length > 0 && data[0].slotsOfAppointment?.length > 0) {
        const slots: TimeSlot[] = data[0].slotsOfAppointment.flatMap(
          (slot: any): TimeSlot[] => {
            const start = new Date(slot.slotStartTimeInUTC);
            const end = new Date(slot.slotEndTimeInUTC);
            const durationMinutes =
              (end.getTime() - start.getTime()) / (1000 * 60);
            const numIntervals = Math.round(durationMinutes / 30);

            const intervalSlots: TimeSlot[] = [];
            for (let i = 0; i < numIntervals; i++) {
              const intervalStart = new Date(
                start.getTime() + i * 30 * 60 * 1000,
              ); // 30-minute grid intervals
              const intervalEnd = new Date(
                intervalStart.getTime() + 30 * 60 * 1000,
              ); // 30-minute grid intervals
              intervalSlots.push({
                startTime: intervalStart,
                endTime: intervalEnd,
                isAvailable: true,
                isBooked: true, // Event slots are considered booked/allocated
              });
            }
            return intervalSlots;
          },
        );
        setEventSlots(slots);
      } else {
        setEventSlots([]);
      }
    } catch (error) {
      console.error("Error fetching event slots:", error);
      setEventSlots([]);
    }
  }, [eventType, eventId]);

  // Fetch all data
  const fetchAllData = useCallback(async () => {
    if (!consultantId) return;

    setLoading(true);
    setError(null);

    try {
      await Promise.all([
        fetchConsultantDetails(),
        fetchAvailabilitySlots(),
        fetchExistingAppointments(),
        fetchEventSlots(),
      ]);
    } catch (error) {
      console.error("Error fetching calendar data:", error);
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Failed to fetch calendar data";
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  }, [consultantId]); // Remove function dependencies to prevent infinite loops

  // Get slot status for a specific interval
  const getSlotStatusForInterval = useCallback(
    (interval: { hour: number; minute: number }, date: Date) => {
      return getSlotStatus(
        interval,
        date,
        availableSlots,
        existingAppointments,
      );
    },
    [availableSlots, existingAppointments],
  );

  // Auto-load data on mount and when dependencies change
  useEffect(() => {
    if (autoLoad && consultantId) {
      setLoading(true);
      setError(null);

      Promise.all([
        fetchConsultantDetails(),
        fetchAvailabilitySlots(),
        fetchExistingAppointments(),
        fetchEventSlots(),
      ])
        .catch((error) => {
          console.error("Error fetching calendar data:", error);
          const errorMessage =
            error instanceof Error
              ? error.message
              : "Failed to fetch calendar data";
          setError(errorMessage);
        })
        .finally(() => {
          setLoading(false);
        });
    }
  }, [autoLoad, consultantId, eventType, eventId]);

  // Individual refetch functions
  const refetchConsultant = useCallback(async () => {
    setLoading(true);
    try {
      await fetchConsultantDetails();
    } finally {
      setLoading(false);
    }
  }, [fetchConsultantDetails]);

  const refetchAvailability = useCallback(async () => {
    setLoading(true);
    try {
      await fetchAvailabilitySlots();
    } finally {
      setLoading(false);
    }
  }, [fetchAvailabilitySlots]);

  const refetchAppointments = useCallback(async () => {
    setLoading(true);
    try {
      await fetchExistingAppointments();
    } finally {
      setLoading(false);
    }
  }, [fetchExistingAppointments]);

  const refetchEventSlots = useCallback(async () => {
    setLoading(true);
    try {
      await fetchEventSlots();
    } finally {
      setLoading(false);
    }
  }, [fetchEventSlots]);

  return {
    // Data
    consultantDetails,
    availableSlots,
    existingAppointments,
    rawAvailabilitySlots,
    eventSlots,
    loading,
    error,

    // Actions
    refetch: fetchAllData,
    refetchConsultant,
    refetchAvailability,
    refetchAppointments,
    refetchEventSlots,
    getSlotStatusForInterval,
  };
}
