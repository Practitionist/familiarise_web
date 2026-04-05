import { useState, useCallback, useMemo, useEffect } from "react";
import {
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
  addDays,
  getDaysInMonth,
} from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { AllocationService } from "../utils/allocationService";
import { INTERVALS } from "@/utils/timeSlotsMeta";

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

/** Minimal plan info shape for event types used in appointment title/status extraction */
interface EventPlanInfo {
  title?: string;
}

interface AppointmentConsultation {
  requestStatus?: string;
  consultationPlan?: EventPlanInfo;
  requestedBy?: { user?: { name?: string } };
}

interface AppointmentSubscription {
  id?: string;
  requestStatus?: string;
  subscriptionPlan?: EventPlanInfo;
  requestedBy?: { user?: { name?: string } };
}

interface AppointmentWebinar {
  status?: string;
  webinarPlan?: EventPlanInfo;
}

interface AppointmentClass {
  status?: string;
  classPlan?: EventPlanInfo;
}

export interface AppointmentSlotRaw {
  startsAt: string;
  endsAt: string;
  isTentative?: boolean;
  user?: Array<{ name?: string }>;
}

export interface Appointment {
  id: string;
  appointmentType: string;
  slotsOfAppointment?: AppointmentSlotRaw[];
  consultation?: AppointmentConsultation;
  subscription?: AppointmentSubscription;
  webinar?: AppointmentWebinar;
  class?: AppointmentClass;
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
  slotStatusMap: Map<string, SlotStatusResult>;
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
      // Always start from the view's natural start so pre-period weeks have
      // availability data (allows "Outside Period" label on consultant's actual
      // available slots rather than blank disabled cells — UX consistency fix).
      const startDate =
        view === "week" ? startOfWeek(currentDate) : startOfMonth(currentDate);
      // End at allowedEnd in allocate mode to avoid fetching past the period.
      const endDate =
        mode === "allocate" && allowedEnd
          ? allowedEnd
          : view === "week"
            ? endOfWeek(currentDate)
            : endOfMonth(currentDate);

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
          ? data.weekly.filter((slot: RawSlotData) => {
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
          ? data.custom.filter((slot: RawSlotData) => {
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
  }, [consultantId, toast, view, currentDate, mode, allowedStart, allowedEnd]);

  // FIXED: Proper date range filtering for appointments to prevent "stray slots"
  const fetchExistingAppointments = useCallback(async (): Promise<void> => {
    if (!consultantId) return;

    try {
      // Always start from the view's natural start so pre-period weeks have
      // appointment data for conflict detection (mirrors availability fix).
      const startDate =
        view === "week" ? startOfWeek(currentDate) : startOfMonth(currentDate);
      // End at allowedEnd in allocate mode.
      const endDate =
        mode === "allocate" && allowedEnd
          ? allowedEnd
          : view === "week"
            ? endOfWeek(currentDate)
            : endOfMonth(currentDate);

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
      const validatedAppointments = data.filter((appt: Appointment) => {
        if (!appt || !appt.id) {
          console.warn(
            "⚠️ fetchExistingAppointments: Filtering out appointment without id",
          );
          return false;
        }

        // If appointment has slots, validate them
        if (appt.slotsOfAppointment && Array.isArray(appt.slotsOfAppointment)) {
          appt.slotsOfAppointment = appt.slotsOfAppointment.filter(
            (slot: AppointmentSlotRaw) => {
              if (!slot || !slot.startsAt || !slot.endsAt) {
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

      // Filter out cancelled/rejected/expired appointments so they don't show as "Booked"
      const activeAppointments = validatedAppointments.filter((appt: Appointment) => {
        const inactiveRequestStatuses = ["REJECTED", "CANCELLED", "EXPIRED"];
        // Check consultation status
        if (appt.consultation?.requestStatus) {
          if (inactiveRequestStatuses.includes(appt.consultation.requestStatus))
            return false;
        }
        // Check subscription status
        if (appt.subscription?.requestStatus) {
          if (inactiveRequestStatuses.includes(appt.subscription.requestStatus))
            return false;
        }
        // Check webinar status
        if (appt.webinar?.status) {
          if (appt.webinar.status === "CANCELLED") return false;
        }
        // Check class status
        if (appt.class?.status) {
          if (appt.class.status === "CANCELLED") return false;
        }
        return true;
      });

      setExistingAppointments(activeAppointments);
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
  }, [consultantId, toast, view, currentDate, mode, allowedStart, allowedEnd]);

  const fetchEventSlots = useCallback(async (): Promise<void> => {
    // Fetch event slots for ALL event types (subscription, consultation, webinar, class)
    // This allows the calendar to show "This Event" (black) instead of "Booked" (gray)
    // for slots belonging to the current event being viewed
    if (!eventType || !eventId) {
      setEventSlots([]);
      return;
    }

    try {
      const data = await AllocationService.fetchEventSlots(eventType, eventId, consultantId);

      if (data && Array.isArray(data) && data.length > 0) {
        // Filter out cancelled/rejected appointments from event slots
        const activeData = data.filter((appt: Appointment) => {
          if (appt.consultation?.requestStatus) {
            if (
              ["REJECTED", "CANCELLED", "EXPIRED"].includes(
                appt.consultation.requestStatus,
              )
            )
              return false;
          }
          if (appt.subscription?.requestStatus) {
            if (
              ["REJECTED", "CANCELLED", "EXPIRED"].includes(
                appt.subscription.requestStatus,
              )
            )
              return false;
          }
          if (appt.webinar?.status === "CANCELLED") return false;
          if (appt.class?.status === "CANCELLED") return false;
          return true;
        });

        // Process ALL appointments, not just the first one
        // This ensures all sessions of a subscription/class show as "This Event"
        // FIX: Skip tentative slots — during rescheduling, tentative slots are the OLD
        // slots being replaced. They should NOT show as "This Event" on the calendar
        // because the auto-allocate will delete them. Showing them as "This Event"
        // misleads the consultant into thinking they're confirmed bookings.
        const slots: TimeSlot[] = activeData.flatMap((appointment: Appointment) =>
          (appointment.slotsOfAppointment || [])
            .filter((slot: AppointmentSlotRaw) => !slot.isTentative)
            .flatMap((slot: AppointmentSlotRaw): TimeSlot[] => {
              const start = new Date(slot.startsAt);
              const end = new Date(slot.endsAt);
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
            }),
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

  /**
   * Helper function to extract appointment plan title
   */
  const extractAppointmentTitle = (appointment: Appointment): string => {
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
  const extractAppointmentParticipant = (appointment: Appointment): string => {
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
   * PERFORMANCE: Compute visible dates for the current view so the slotStatusMap
   * can precompute statuses for every cell in a single pass.
   */
  const visibleDates = useMemo((): Date[] => {
    const dates: Date[] = [];
    if (view === "week") {
      const weekStart = startOfWeek(currentDate);
      for (let i = 0; i < 7; i++) {
        dates.push(addDays(weekStart, i));
      }
    } else {
      const monthStart = startOfMonth(currentDate);
      const daysInMonth = getDaysInMonth(currentDate);
      for (let i = 0; i < daysInMonth; i++) {
        dates.push(addDays(monthStart, i));
      }
    }
    return dates;
  }, [currentDate, view]);

  /**
   * PERFORMANCE: Pre-parse raw slot and appointment times once, then reuse across
   * all 336+ cell computations instead of re-parsing per cell.
   */
  const parsedRawSlots = useMemo(() => {
    const allRaw = [
      ...(rawAvailabilitySlots.weekly || []),
      ...(rawAvailabilitySlots.custom || []),
    ];
    return allRaw.map((slot) => ({
      start: new Date(slot.slotStartTimeInUTC).getTime(),
      end: new Date(slot.slotEndTimeInUTC).getTime(),
      bookingStatus: slot.bookingStatus || "available",
    }));
  }, [rawAvailabilitySlots]);

  const parsedAppointmentSlots = useMemo(() => {
    return existingAppointments.flatMap((appointment) =>
      (appointment.slotsOfAppointment || []).map((slt: AppointmentSlotRaw) => ({
        start: new Date(slt.startsAt).getTime(),
        end: new Date(slt.endsAt).getTime(),
        appointmentId: appointment.id,
        appointmentType: appointment.appointmentType,
        title: extractAppointmentTitle(appointment),
        with: extractAppointmentParticipant(appointment),
      })),
    );
  }, [existingAppointments]);

  /**
   * PERFORMANCE: Precompute slot status for every visible cell.
   * Converts 336 × O(W+C+A×S) → 1 precomputation + 336 × O(1) Map lookups.
   * Key format: `${year}-${month}-${day}-${hour}-${minute}`
   */
  const slotStatusMap = useMemo((): Map<string, SlotStatusResult> => {
    const map = new Map<string, SlotStatusResult>();
    const now = Date.now();

    for (const date of visibleDates) {
      const y = date.getFullYear();
      const m = date.getMonth();
      const d = date.getDate();

      for (const interval of INTERVALS) {
        const key = `${y}-${m}-${d}-${interval.hour}-${interval.minute}`;

        // Calculate interval boundaries in local time
        const localStart = new Date(
          y,
          m,
          d,
          interval.hour,
          interval.minute,
          0,
          0,
        );
        const localEnd = new Date(localStart.getTime() + 30 * 60 * 1000);
        const startMs = localStart.getTime();
        const endMs = localEnd.getTime();

        // Find overlapping raw availability slots
        const overlappingSlots = parsedRawSlots.filter(
          (s) => startMs < s.end && s.start < endMs,
        );

        // Find overlapping appointments for tooltip
        const overlappingAppointments = parsedAppointmentSlots
          .filter((s) => startMs < s.end && s.start < endMs)
          .map((s) => ({
            id: s.appointmentId,
            type: s.appointmentType,
            title: s.title,
            with: s.with,
          }));

        // Determine booking status from server-calculated data
        let isAvailable = false;
        let isBookedForDisplay = false;
        let isPartiallyBooked = false;

        if (overlappingSlots.length > 0) {
          const bookingStatus = overlappingSlots[0].bookingStatus;
          isAvailable = bookingStatus === "available";
          isBookedForDisplay = bookingStatus === "fully-booked";
          isPartiallyBooked = bookingStatus === "partially-booked";
        }

        // Ensure appointments without availability slots still show as booked
        if (!isBookedForDisplay && overlappingAppointments.length > 0) {
          isBookedForDisplay = true;
          isAvailable = false;
        }

        const isInPast = endMs < now;
        const isDisabled = !isAvailable || isBookedForDisplay || isInPast;

        map.set(key, {
          isAvailable,
          isBooked: isBookedForDisplay || isPartiallyBooked,
          isBookedForDisplay,
          isPartiallyBooked,
          isDisabled,
          isInPast,
          intervalStartUTCString: localStart.toISOString(),
          intervalEndUTCString: localEnd.toISOString(),
          localStartTime: localStart,
          localEndTime: localEnd,
          overlappingAppointments,
        });
      }
    }

    return map;
  }, [visibleDates, parsedRawSlots, parsedAppointmentSlots]);

  /**
   * SLOT STATUS LOOKUP — O(1) via precomputed Map.
   * Falls back to inline computation for cells not in the visible range
   * (e.g. month view overflow days).
   */
  const getSlotStatusForInterval = useCallback(
    (
      interval: { hour: number; minute: number },
      date: Date,
    ): SlotStatusResult => {
      const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${interval.hour}-${interval.minute}`;
      const cached = slotStatusMap.get(key);
      if (cached) return cached;

      // Fallback for cells outside the precomputed visible range
      const localIntervalStartDate = new Date(date);
      localIntervalStartDate.setHours(interval.hour, interval.minute, 0, 0);
      const localIntervalEndDate = new Date(
        localIntervalStartDate.getTime() + 30 * 60 * 1000,
      );

      const startMs = localIntervalStartDate.getTime();
      const endMs = localIntervalEndDate.getTime();

      const overlappingSlots = parsedRawSlots.filter(
        (s) => startMs < s.end && s.start < endMs,
      );

      const overlappingAppointments = parsedAppointmentSlots
        .filter((s) => startMs < s.end && s.start < endMs)
        .map((s) => ({
          id: s.appointmentId,
          type: s.appointmentType,
          title: s.title,
          with: s.with,
        }));

      let isAvailable = false;
      let isBookedForDisplay = false;
      let isPartiallyBooked = false;

      if (overlappingSlots.length > 0) {
        const bookingStatus = overlappingSlots[0].bookingStatus;
        isAvailable = bookingStatus === "available";
        isBookedForDisplay = bookingStatus === "fully-booked";
        isPartiallyBooked = bookingStatus === "partially-booked";
      }

      if (!isBookedForDisplay && overlappingAppointments.length > 0) {
        isBookedForDisplay = true;
        isAvailable = false;
      }

      const now = new Date();
      const isInPast = localIntervalEndDate < now;
      const isDisabled = !isAvailable || isBookedForDisplay || isInPast;

      return {
        isAvailable,
        isBooked: isBookedForDisplay || isPartiallyBooked,
        isBookedForDisplay,
        isPartiallyBooked,
        isDisabled,
        isInPast,
        intervalStartUTCString: localIntervalStartDate.toISOString(),
        intervalEndUTCString: localIntervalEndDate.toISOString(),
        localStartTime: localIntervalStartDate,
        localEndTime: localIntervalEndDate,
        overlappingAppointments,
      };
    },
    [slotStatusMap, parsedRawSlots, parsedAppointmentSlots],
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

  // PERFORMANCE: Split into two effects so date-independent fetches don't re-fire on week navigation.

  // Effect 1 — Date-independent: runs on dialog open only (consultantDetails + eventSlots)
  useEffect(() => {
    if (autoLoad && consultantId) {
      Promise.all([fetchConsultantDetails(), fetchEventSlots()]).catch(
        (error) => {
          console.error("Error fetching date-independent data:", error);
          setError(
            error instanceof Error
              ? error.message
              : "Failed to fetch calendar data",
          );
        },
      );
    }
  }, [autoLoad, consultantId, fetchConsultantDetails, fetchEventSlots]);

  // Effect 2 — Date-dependent: runs on dialog open + week/month navigation
  useEffect(() => {
    if (autoLoad && consultantId) {
      // Only show loading spinner on initial load, not on background refetches
      const isInitialLoad =
        !consultantDetails && rawAvailabilitySlots.weekly.length === 0;
      if (isInitialLoad) {
        setLoading(true);
      }
      setError(null);

      Promise.all([fetchAvailabilitySlots(), fetchExistingAppointments()])
        .catch((error) => {
          console.error("Error fetching date-dependent data:", error);
          setError(
            error instanceof Error
              ? error.message
              : "Failed to fetch calendar data",
          );
        })
        .finally(() => {
          setLoading(false);
        });
    }
  }, [
    autoLoad,
    consultantId,
    fetchAvailabilitySlots,
    fetchExistingAppointments,
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
    slotStatusMap, // PERFORMANCE: Precomputed status map for O(1) lookups
  };
}
