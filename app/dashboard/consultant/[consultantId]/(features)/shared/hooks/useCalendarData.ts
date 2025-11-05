import { useState, useCallback, useMemo, useEffect } from "react";
import { startOfWeek, endOfWeek, startOfMonth, endOfMonth } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { AllocationService } from "../utils/allocationService";

/**
 * CALENDAR DATA SYNCHRONIZATION REFACTOR
 * =====================================
 *
 * PROBLEM SOLVED:
 * - Three calendar views (Settings, Expert Profile, Planner) showed inconsistent booking status
 * - Manual calculation logic in UnifiedCalendar didn't match server-calculated status
 * - Date filtering issues caused "stray booked slots" from different time periods
 * - Mixed TypeScript interfaces caused confusion and bugs
 *
 * SOLUTION:
 * - Unified data source: All calendars now use server-calculated `bookingStatus`
 * - Enhanced TypeScript interfaces with clear separation of concerns
 * - Optimized slot status calculation using raw availability data
 * - Proper date filtering and timezone handling
 */

// Enhanced TypeScript interfaces - FIXED: Replaced 'any' types with proper interfaces
export interface UseCalendarDataOptions {
  consultantId: string;
  eventType?: "consultation" | "subscription" | "webinar" | "class";
  eventId?: string;
  autoLoad?: boolean;
  view: "week" | "month";
  currentDate: Date;
  mode: "view" | "select" | "allocate";
  allowedStart?: Date;
  allowedEnd?: Date;
}

export interface TimeSlot {
  startTime: Date;
  endTime: Date;
  isAvailable: boolean;
  isBooked: boolean;
}

export interface Appointment {
  id: string;
  appointmentType: string;
  slotsOfAppointment?: {
    startsAt: string;
    endsAt: string;
    // Legacy field names for backwards compatibility
    slotStartTimeInUTC?: string;
    slotEndTimeInUTC?: string;
  }[];
  consultation?: any;
  subscription?: any;
  webinar?: any;
  class?: any;
}

export interface ConsultantData {
  id: string;
  name: string;
  // Add other consultant properties as needed
}

/**
 * RAW SLOT DATA - Server-calculated booking status
 * BEFORE: Used manual calculation with date filtering issues
 * AFTER: Uses server-calculated `bookingStatus` field for consistency
 */
export interface RawSlotData {
  slotId: string;
  slotStartTimeInUTC: string;
  slotEndTimeInUTC: string;
  bookingStatus: "available" | "partially-booked" | "fully-booked"; // KEY: Server-calculated status
  type: "WEEKLY" | "CUSTOM";
  dayOfWeek?: string;
  localStartTime?: string;
  localEndTime?: string;
}

/**
 * SLOT STATUS RESULT - Enhanced with clear status flags
 * BEFORE: Confusing mix of isBooked, isConflicting, etc.
 * AFTER: Clear separation: isBookedForDisplay (gray), isPartiallyBooked (yellow)
 */
export interface SlotStatusResult {
  isAvailable: boolean;
  isBooked: boolean; // For backwards compatibility
  isBookedForDisplay: boolean; // Fully booked (gray) - FIXED: Clear naming
  isPartiallyBooked: boolean; // Partially booked (yellow) - FIXED: Clear naming
  isDisabled: boolean;
  isInPast: boolean;
  intervalStartUTCString: string;
  intervalEndUTCString: string;
  localStartTime: Date;
  localEndTime: Date;
  overlappingAppointments: Array<{
    id: string;
    type: string;
    title: string;
    with?: string;
  }>;
}

export interface CalendarData {
  consultantDetails: ConsultantData | null;
  availableSlots: TimeSlot[];
  existingAppointments: Appointment[];
  rawAvailabilitySlots: {
    weekly: RawSlotData[];
    custom: RawSlotData[];
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
  ) => SlotStatusResult;
}

/**
 * Enhanced calendar data hook with proper TypeScript interfaces and optimized data processing
 *
 * KEY IMPROVEMENTS:
 * 1. Uses server-calculated booking status instead of manual calculation
 * 2. Proper date filtering for appointments
 * 3. Enhanced TypeScript coverage
 * 4. Individual refetch functions for granular control
 * 5. Optimized performance with useCallback and useMemo
 */
export function useCalendarData(
  options: UseCalendarDataOptions,
): UseCalendarDataReturn {
  const {
    consultantId,
    eventType,
    eventId,
    autoLoad = true,
    view,
    currentDate,
    mode,
    allowedStart,
    allowedEnd,
  } = options;
  const { toast } = useToast();

  // State management - ENHANCED: Better TypeScript coverage
  const [consultantDetails, setConsultantDetails] =
    useState<ConsultantData | null>(null);
  const [rawAvailabilitySlots, setRawAvailabilitySlots] = useState<{
    weekly: RawSlotData[];
    custom: RawSlotData[];
  }>({ weekly: [], custom: [] });
  const [existingAppointments, setExistingAppointments] = useState<
    Appointment[]
  >([]);
  const [eventSlots, setEventSlots] = useState<TimeSlot[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // PERFORMANCE: Computed available slots from raw data using useMemo
  const availableSlots = useMemo((): TimeSlot[] => {
    const allRawSlots = [
      ...(rawAvailabilitySlots.weekly || []),
      ...(rawAvailabilitySlots.custom || []),
    ];

    return allRawSlots.map((slot: RawSlotData) => ({
      startTime: new Date(slot.slotStartTimeInUTC),
      endTime: new Date(slot.slotEndTimeInUTC),
      isAvailable:
        slot.bookingStatus === "available" ||
        slot.bookingStatus === "partially-booked",
      isBooked: slot.bookingStatus === "fully-booked",
    }));
  }, [rawAvailabilitySlots]);

  // PERFORMANCE: Data fetching functions with useCallback optimization
  const fetchConsultantDetails = useCallback(async (): Promise<void> => {
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

  // FIXED: Proper date range filtering for availability slots
  const fetchAvailabilitySlots = useCallback(async (): Promise<void> => {
    if (!consultantId) return;

    try {
      // // Use subscription start date for allocation // Use UI date for viewing
      const startDate =
        mode === "allocate" && allowedStart
          ? allowedStart
          : view === "week"
            ? startOfWeek(currentDate)
            : startOfMonth(currentDate);
      // Use subscription end date for allocation // Use UI date for viewing
      const endDate =
        mode === "allocate" && allowedEnd
          ? allowedEnd
          : view === "week"
            ? endOfWeek(currentDate)
            : endOfMonth(currentDate); // --- END OF FIX --- ```

      const data = await AllocationService.fetchAvailabilitySlots(
        consultantId,
        startDate,
        endDate,
      );

      // Defensive: Validate data structure before using
      if (!data || typeof data !== "object") {
        console.warn(
          "⚠️ fetchAvailabilitySlots: Invalid data structure returned",
        );
        setRawAvailabilitySlots({ weekly: [], custom: [] });
        return;
      }

      // Defensive: Ensure arrays exist and are valid
      const validatedData = {
        weekly: Array.isArray(data.weekly)
          ? data.weekly.filter((slot: any) => {
              if (!slot || !slot.slotStartTimeInUTC || !slot.slotEndTimeInUTC) {
                console.warn(
                  "⚠️ fetchAvailabilitySlots: Filtering out invalid weekly slot",
                );
                return false;
              }
              return true;
            })
          : [],
        custom: Array.isArray(data.custom)
          ? data.custom.filter((slot: any) => {
              if (!slot || !slot.slotStartTimeInUTC || !slot.slotEndTimeInUTC) {
                console.warn(
                  "⚠️ fetchAvailabilitySlots: Filtering out invalid custom slot",
                );
                return false;
              }
              return true;
            })
          : [],
      };

      setRawAvailabilitySlots(validatedData);
    } catch (error) {
      console.error("Error fetching availability slots:", error);
      const errorMessage =
        error instanceof Error ? error.message : "Failed to fetch availability";
      setError(errorMessage);
      toast({
        variant: "destructive",
        title: "Error",
        description: errorMessage,
      });
    }
  }, [consultantId, toast, view, currentDate]);

  // FIXED: Proper date range filtering for appointments to prevent "stray slots"
  const fetchExistingAppointments = useCallback(async (): Promise<void> => {
    if (!consultantId) return;

    try {
      // // Use subscription start date for allocation // Use UI date for viewing
      const startDate =
        mode === "allocate" && allowedStart
          ? allowedStart
          : view === "week"
            ? startOfWeek(currentDate)
            : startOfMonth(currentDate);
      // Use subscription end date for allocation // Use UI date for viewing
      const endDate =
        mode === "allocate" && allowedEnd
          ? allowedEnd
          : view === "week"
            ? endOfWeek(currentDate)
            : endOfMonth(currentDate); // --- END OF FIX --- ```

      const data = await AllocationService.fetchAppointments(
        consultantId,
        startDate,
        endDate,
      );

      // Defensive: Validate data is an array before using
      if (!Array.isArray(data)) {
        console.warn("⚠️ fetchExistingAppointments: Data is not an array");
        setExistingAppointments([]);
        return;
      }

      // Defensive: Filter out invalid appointments
      const validatedAppointments = data.filter((appt: any) => {
        if (!appt || !appt.id) {
          console.warn(
            "⚠️ fetchExistingAppointments: Filtering out appointment without id",
          );
          return false;
        }

        // If appointment has slots, validate them
        if (appt.slotsOfAppointment && Array.isArray(appt.slotsOfAppointment)) {
          appt.slotsOfAppointment = appt.slotsOfAppointment.filter(
            (slot: any) => {
              // FIX: Check for BOTH new field names (startsAt/endsAt) AND old field names (slotStartTimeInUTC/slotEndTimeInUTC)
              const hasNewFields = slot && slot.startsAt && slot.endsAt;
              const hasOldFields =
                slot && slot.slotStartTimeInUTC && slot.slotEndTimeInUTC;

              if (!hasNewFields && !hasOldFields) {
                console.warn(
                  `⚠️ fetchExistingAppointments: Filtering out invalid slot in appointment ${appt.id}`,
                  { slot },
                );
                return false;
              }
              return true;
            },
          );
        }

        return true;
      });

      setExistingAppointments(validatedAppointments);
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
  }, [consultantId, toast, view, currentDate]);

  const fetchEventSlots = useCallback(async (): Promise<void> => {
    // Fetch event slots for ALL event types (subscription, consultation, webinar, class)
    // This allows the calendar to show "This Event" (black) instead of "Booked" (gray)
    // for slots belonging to the current event being viewed
    if (!eventType || !eventId) {
      setEventSlots([]);
      return;
    }

    try {
      const data = await AllocationService.fetchEventSlots(eventType, eventId);

      console.log("[useCalendarData] fetchEventSlots response:", {
        eventType,
        eventId,
        dataLength: data?.length,
        firstAppointment: data?.[0],
      });

      if (data && data.length > 0 && data[0].slotsOfAppointment?.length > 0) {
        const slots: TimeSlot[] = data[0].slotsOfAppointment.flatMap(
          (slot: any): TimeSlot[] => {
            // FIX: Use correct field names from API (startsAt/endsAt)
            const start = new Date(slot.startsAt || slot.slotStartTimeInUTC);
            const end = new Date(slot.endsAt || slot.slotEndTimeInUTC);
            const durationMinutes =
              (end.getTime() - start.getTime()) / (1000 * 60);
            const numIntervals = Math.round(durationMinutes / 30);

            const intervalSlots: TimeSlot[] = [];
            for (let i = 0; i < numIntervals; i++) {
              const intervalStart = new Date(
                start.getTime() + i * 30 * 60 * 1000,
              );
              const intervalEnd = new Date(
                intervalStart.getTime() + 30 * 60 * 1000,
              );
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
        console.log("[useCalendarData] Setting eventSlots:", {
          slotsCount: slots.length,
          firstSlot: slots[0]
            ? {
                startTime: slots[0].startTime.toISOString(),
                endTime: slots[0].endTime.toISOString(),
              }
            : null,
        });
        setEventSlots(slots);
      } else {
        console.log(
          "[useCalendarData] No event slots found, setting empty array",
        );
        setEventSlots([]);
      }
    } catch (error) {
      console.error("Error fetching event slots:", error);
      setEventSlots([]);
    }
  }, [eventType, eventId]);

  /**
   * Helper function to extract appointment plan title
   */
  const extractAppointmentTitle = (appointment: any): string => {
    if (!appointment) return "Unknown";

    switch (appointment.appointmentType) {
      case "CONSULTATION":
        return (
          appointment.consultation?.consultationPlan?.title || "Consultation"
        );
      case "SUBSCRIPTION":
        return (
          appointment.subscription?.subscriptionPlan?.title || "Subscription"
        );
      case "WEBINAR":
        return appointment.webinar?.webinarPlan?.title || "Webinar";
      case "CLASS":
        return appointment.class?.classPlan?.title || "Class";
      default:
        return appointment.appointmentType || "Unknown";
    }
  };

  /**
   * Helper function to extract appointment participant name
   */
  const extractAppointmentParticipant = (appointment: any): string => {
    if (!appointment) return "";

    switch (appointment.appointmentType) {
      case "CONSULTATION":
        return appointment.consultation?.requestedBy?.user?.name || "";
      case "SUBSCRIPTION":
        return appointment.subscription?.requestedBy?.user?.name || "";
      case "WEBINAR":
      case "CLASS":
        return appointment.slotsOfAppointment?.[0]?.user?.[0]?.name || "";
      default:
        return "";
    }
  };

  /**
   * CRITICAL FUNCTION - SLOT STATUS CALCULATION REFACTOR
   * ===================================================
   *
   * BEFORE: Manual calculation with inconsistent logic across components
   * - UnifiedCalendar manually calculated booking status
   * - ConsultantAvailability used server-calculated status
   * - Different date filtering caused "stray slots" from future dates
   *
   * AFTER: Unified approach using server-calculated booking status
   * - All calendars use the same data source (rawAvailabilitySlots)
   * - Server handles complex booking calculations
   * - Proper timezone handling and date filtering
   * - Clear status flags: isBookedForDisplay (gray), isPartiallyBooked (yellow)
   */
  const getSlotStatusForInterval = useCallback(
    (
      interval: { hour: number; minute: number },
      date: Date,
    ): SlotStatusResult => {
      // STEP 1: Calculate the 30-minute interval boundaries in local time
      const localIntervalStartDate = new Date(date);
      localIntervalStartDate.setHours(interval.hour, interval.minute, 0, 0);
      const localIntervalEndDate = new Date(localIntervalStartDate);
      localIntervalEndDate.setMinutes(localIntervalStartDate.getMinutes() + 30);

      // STEP 2: Get UTC times for comparison with server data
      // The Date objects are already in the correct time - just use them directly
      // toISOString() will convert them to UTC format correctly
      const intervalStartUTC = localIntervalStartDate;
      const intervalEndUTC = localIntervalEndDate;

      // STEP 3: Find overlapping slots from raw availability data
      // KEY CHANGE: Use server-calculated booking status instead of manual calculation
      const allRawSlots = [
        ...(rawAvailabilitySlots.weekly || []),
        ...(rawAvailabilitySlots.custom || []),
      ];

      const overlappingSlots = allRawSlots.filter((slot: RawSlotData) => {
        const slotStart = new Date(slot.slotStartTimeInUTC);
        const slotEnd = new Date(slot.slotEndTimeInUTC);
        return intervalStartUTC < slotEnd && slotStart < intervalEndUTC;
      });

      // STEP 4: Find overlapping appointments for tooltip information
      const overlappingAppointments = existingAppointments.flatMap(
        (appointment) =>
          appointment.slotsOfAppointment
            ?.filter((slt: any) => {
              // FIX: Use correct field names from API (startsAt/endsAt, not slotStartTimeInUTC/slotEndTimeInUTC)
              const slotStart = new Date(
                slt.startsAt || slt.slotStartTimeInUTC,
              );
              const slotEnd = new Date(slt.endsAt || slt.slotEndTimeInUTC);
              return intervalStartUTC < slotEnd && slotStart < intervalEndUTC;
            })
            .map((_slot) => ({
              id: appointment.id,
              type: appointment.appointmentType,
              title: extractAppointmentTitle(appointment),
              with: extractAppointmentParticipant(appointment),
            })) || [],
      );

      // DEBUG: Log when booked slots have no overlapping appointments (tooltip won't show)
      if (
        overlappingSlots.length > 0 &&
        overlappingSlots[0].bookingStatus === "fully-booked" &&
        overlappingAppointments.length === 0
      ) {
        console.warn(
          "[getSlotStatusForInterval] Booked slot with no overlapping appointments - tooltip won't show:",
          {
            interval: `${interval.hour}:${interval.minute}`,
            date: date.toDateString(),
            existingAppointmentsCount: existingAppointments.length,
            firstAppointmentSlots:
              existingAppointments[0]?.slotsOfAppointment?.length,
          },
        );
      }

      // STEP 5: Determine booking status using SERVER-CALCULATED data
      // FIXED: Use server bookingStatus instead of manual calculation
      let isAvailable = false;
      let isBookedForDisplay = false; // Gray "Booked" slots
      let isPartiallyBooked = false; // Yellow "Partially Booked" slots

      if (overlappingSlots.length > 0) {
        const primarySlot = overlappingSlots[0];
        const bookingStatus = primarySlot.bookingStatus || "available";

        // Map server status to display flags - FIXED: Clear status mapping
        isAvailable = bookingStatus === "available";
        isBookedForDisplay = bookingStatus === "fully-booked";
        isPartiallyBooked = bookingStatus === "partially-booked";
      }

      // CRITICAL FIX: Ensure existing appointments are visible even if no availability slot exists
      // If any appointment overlaps this interval, mark it as booked for display
      if (!isBookedForDisplay && overlappingAppointments.length > 0) {
        isBookedForDisplay = true;
        isAvailable = false;
      }

      // STEP 6: Check if interval is in the past - FIXED: Proper timezone handling
      const now = new Date();
      const isInPast = localIntervalEndDate < now;

      // STEP 7: Determine disabled state
      const isDisabled = !isAvailable || isBookedForDisplay || isInPast;

      return {
        isAvailable,
        isBooked: isBookedForDisplay || isPartiallyBooked, // For backwards compatibility
        isBookedForDisplay, // FIXED: Use this for gray "Booked" display
        isPartiallyBooked, // FIXED: Use this for yellow "Partially Booked" display
        isDisabled,
        isInPast,
        intervalStartUTCString: intervalStartUTC.toISOString(),
        intervalEndUTCString: intervalEndUTC.toISOString(),
        localStartTime: localIntervalStartDate,
        localEndTime: localIntervalEndDate,
        overlappingAppointments,
      };
    },
    [rawAvailabilitySlots, existingAppointments],
  );

  // PERFORMANCE: Fetch all data function with parallel API calls
  const fetchAllData = useCallback(async (): Promise<void> => {
    if (!consultantId) return;

    setLoading(true);
    setError(null);

    try {
      // OPTIMIZATION: Parallel data fetching for better performance
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
  }, [
    consultantId,
    fetchConsultantDetails,
    fetchAvailabilitySlots,
    fetchExistingAppointments,
    fetchEventSlots,
  ]);

  // PERFORMANCE: Auto-load data with proper dependency tracking
  useEffect(() => {
    if (autoLoad && consultantId) {
      setLoading(true);
      setError(null);

      // OPTIMIZATION: Parallel data fetching on mount and dependency changes
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
  }, [
    autoLoad,
    consultantId,
    eventType,
    eventId,
    currentDate,
    view,
    mode,
    allowedStart,
    allowedEnd,
  ]);

  // ENHANCEMENT: Individual refetch functions for granular control
  const refetchConsultant = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      await fetchConsultantDetails();
    } finally {
      setLoading(false);
    }
  }, [fetchConsultantDetails]);

  const refetchAvailability = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      await fetchAvailabilitySlots();
    } finally {
      setLoading(false);
    }
  }, [fetchAvailabilitySlots]);

  const refetchAppointments = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      await fetchExistingAppointments();
    } finally {
      setLoading(false);
    }
  }, [fetchExistingAppointments]);

  const refetchEventSlots = useCallback(async (): Promise<void> => {
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

    // Actions - ENHANCEMENT: Granular refetch control
    refetch: fetchAllData,
    refetchConsultant,
    refetchAvailability,
    refetchAppointments,
    refetchEventSlots,
    getSlotStatusForInterval, // KEY: Unified slot status calculation
  };
}
