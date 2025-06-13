import { AppointmentsType, RequestStatus, ScheduleType } from "@prisma/client";
import { TAppointment } from "@/types/appointment";
import { DetailedTimeSlotMeta, TimeSlotMeta } from "@/utils/timeSlotsMeta";
import {
  AvailabilityApiResponse,
  ConsultantApiResponse,
  ConsultationApiResponse,
  SubscriptionApiResponse,
} from "./types";

// ===== API UTILITIES =====

export interface ApiResult<T> {
  ok: boolean;
  data: T | null;
  error?: string;
}

/**
 * Generic fetch utility with error handling
 */
export async function fetchDataFromApi<T>(url: string): Promise<ApiResult<T>> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Failed to fetch ${url}:`, errorText);
      return {
        ok: false,
        data: null,
        error: `Server error (${response.status}) while fetching data.`,
      };
    }
    const data = await response.json();
    if (data && data.data !== undefined) {
      return { ok: true, data: data.data as T, error: undefined };
    } else {
      console.error(`Unexpected response structure from ${url}:`, data);
      return {
        ok: false,
        data: null,
        error: "Received unexpected data structure from server.",
      };
    }
  } catch (err) {
    console.error(`Error fetching ${url}:`, err);
    let message = "An unknown error occurred while fetching data.";
    if (err instanceof TypeError && err.message === "Failed to fetch") {
      message =
        "Network error: Could not connect to the server. Please check your internet connection.";
    } else if (err instanceof Error) {
      message = err.message;
    }
    return { ok: false, data: null, error: message };
  }
}

/**
 * Parallel data fetching for all required endpoints
 */
export async function fetchAllRequestData(consultantId: string) {
  const endpoints = [
    `/api/events/consultations?consultantProfileId=${consultantId}&status=PENDING`,
    `/api/events/subscriptions?consultantProfileId=${consultantId}&status=PENDING`,
    `/api/slots/availability/weekly?consultantProfileId=${consultantId}`,
    `/api/slots/availability/custom?consultantProfileId=${consultantId}`,
    `/api/slots/appointments?consultantProfileId=${consultantId}&consultationStatus=APPROVED&subscriptionStatus=APPROVED&webinarStatus=APPROVED&classStatus=APPROVED`,
    `/api/user/consultants/${consultantId}`,
  ];

  const [
    consultationsResult,
    subscriptionsResult,
    weeklyAvailabilityResult,
    customAvailabilityResult,
    appointmentsResult,
    consultantResult,
  ] = await Promise.all([
    fetchDataFromApi<ConsultationApiResponse[]>(endpoints[0]),
    fetchDataFromApi<SubscriptionApiResponse[]>(endpoints[1]),
    fetchDataFromApi<AvailabilityApiResponse[]>(endpoints[2]),
    fetchDataFromApi<AvailabilityApiResponse[]>(endpoints[3]),
    fetchDataFromApi<TAppointment[]>(endpoints[4]),
    fetchDataFromApi<ConsultantApiResponse>(endpoints[5]),
  ]);

  const results = [
    consultationsResult,
    subscriptionsResult,
    weeklyAvailabilityResult,
    customAvailabilityResult,
    appointmentsResult,
    consultantResult,
  ];

  // Check for errors
  for (const result of results) {
    if (!result.ok && result.error) {
      return { ok: false, error: result.error, data: null };
    }
  }

  return {
    ok: true,
    error: null,
    data: {
      consultations: consultationsResult.data,
      subscriptions: subscriptionsResult.data,
      weeklyAvailability: weeklyAvailabilityResult.data,
      customAvailability: customAvailabilityResult.data,
      appointments: appointmentsResult.data,
      consultant: consultantResult.data,
    },
  };
}

// ===== DATA PROCESSING UTILITIES =====

export interface Request {
  id: string;
  type: AppointmentsType;
  title: string;
  requestedBy: any;
  requestedAt: string;
  requestedTimes?: string[];
  status: RequestStatus;
  requiredSlots: number;
  allocatedSlots?: string[];
}

/**
 * Calculate required slots for subscription
 */
export function calculateSubscriptionSlots(
  callsPerWeek: number = 1,
  durationInMonths: number = 1
): number {
  const weeksInDuration = durationInMonths * 4;
  return Math.max(callsPerWeek * weeksInDuration, 1);
}

/**
 * Process consultation data into Request format
 */
export function processConsultations(
  consultations: ConsultationApiResponse[],
  typeFilter: "all" | "consultation" | "subscription"
): Request[] {
  if (typeFilter !== "all" && typeFilter !== "consultation") return [];
  
  return consultations.map((consultation) => ({
    id: consultation.id,
    type: AppointmentsType.CONSULTATION,
    title: consultation.consultationPlan?.title || "Untitled Plan",
    requestedBy: consultation.requestedBy,
    requestedAt: consultation.requestedAt,
    requestedTimes:
      consultation.appointment?.slotsOfAppointment?.map(
        (slot) => slot.slotStartTimeInUTC,
      ) || [],
    status: consultation.requestStatus,
    requiredSlots: 1,
  }));
}

/**
 * Process subscription data into Request format
 */
export function processSubscriptions(
  subscriptions: SubscriptionApiResponse[],
  typeFilter: "all" | "consultation" | "subscription"
): Request[] {
  if (typeFilter !== "all" && typeFilter !== "subscription") return [];

  return subscriptions.map((subscription) => {
    const callsPerWeek = subscription.subscriptionPlan?.callsPerWeek ?? 1;
    const durationInMonths = subscription.subscriptionPlan?.durationInMonths ?? 1;
    const requiredSlots = calculateSubscriptionSlots(callsPerWeek, durationInMonths);

    return {
      id: subscription.id,
      type: AppointmentsType.SUBSCRIPTION,
      title: subscription.subscriptionPlan?.title || "Untitled Plan",
      requestedBy: subscription.requestedBy,
      requestedAt: subscription.requestedAt,
      requestedTimes:
        subscription.appointments?.flatMap(
          (appt) =>
            appt.slotsOfAppointment?.map(
              (slot) => slot.slotStartTimeInUTC,
            ) || [],
        ) || [],
      status: subscription.requestStatus,
      requiredSlots,
    };
  });
}

/**
 * Generate weekly availability slots for next 3 months
 * Note: This function is for weekly schedules that repeat each week
 */
export function generateWeeklyAvailabilitySlots(
  weeklyAvailability: any[] // Using any for weekly availability with different structure
): TimeSlotMeta[] {
  if (!weeklyAvailability || !Array.isArray(weeklyAvailability) || weeklyAvailability.length === 0) {
    return [];
  }

  const availableSlots: TimeSlotMeta[] = [];
  const currentDate = new Date();
  const endDate = new Date();
  endDate.setMonth(currentDate.getMonth() + 3);

  // Create a mapping from day names to numbers (0 = Sunday, 1 = Monday, etc.)
  const dayNameToNumber: { [key: string]: number } = {
    'SUNDAY': 0,
    'MONDAY': 1,
    'TUESDAY': 2,
    'WEDNESDAY': 3,
    'THURSDAY': 4,
    'FRIDAY': 5,
    'SATURDAY': 6
  };

  // Iterate through each day from current date to end date
  for (let date = new Date(currentDate); date <= endDate; date.setDate(date.getDate() + 1)) {
    const dayOfWeek = date.getDay(); // 0 = Sunday, 1 = Monday, etc.

    // Find all weekly availability slots for this day of week
    const daySlots = weeklyAvailability.filter(slot => {
      const slotDayName = slot.dayOfWeekforStartTimeInUTC;
      const slotDayNumber = dayNameToNumber[slotDayName];
      return slotDayNumber === dayOfWeek;
    });

    // Generate time slots for each availability slot on this day
    daySlots.forEach(slot => {
      try {
        // Parse the start and end times from the 1970 UTC timestamps
        const startTime = new Date(slot.slotStartTimeInUTC);
        const endTime = new Date(slot.slotEndTimeInUTC);

        // Create slots every 30 minutes within the availability window
        const slotDate = new Date(date);
        slotDate.setUTCHours(startTime.getUTCHours(), startTime.getUTCMinutes(), 0, 0);
        
        const slotEndDate = new Date(date);
        slotEndDate.setUTCHours(endTime.getUTCHours(), endTime.getUTCMinutes(), 0, 0);

        // Generate 30-minute slots
        while (slotDate < slotEndDate) {
          const slotEndTime = new Date(slotDate);
          slotEndTime.setMinutes(slotEndTime.getMinutes() + 30);

          // Only add if the slot end time doesn't exceed the availability end time
          if (slotEndTime <= slotEndDate) {
            availableSlots.push({
              startTime: new Date(slotDate),
              endTime: new Date(slotEndTime),
            });
          }

          // Move to next 30-minute slot
          slotDate.setMinutes(slotDate.getMinutes() + 30);
        }
      } catch (error) {
        console.error("Error processing weekly availability slot:", error, slot);
      }
    });
  }

  return availableSlots;
}

/**
 * Process custom availability slots
 */
export function processCustomAvailabilitySlots(
  customAvailability: AvailabilityApiResponse[]
): TimeSlotMeta[] {
  const currentTime = new Date();
  
  return customAvailability
    .filter((slot) => {
      const slotStart = new Date(slot.slotStartTimeInUTC);
      return slotStart > currentTime;
    })
    .map((slot) => ({
      startTime: new Date(slot.slotStartTimeInUTC),
      endTime: new Date(slot.slotEndTimeInUTC),
    }));
}

/**
 * Process appointments into DetailedTimeSlotMeta format
 */
export function processAppointments(appointments: TAppointment[]): DetailedTimeSlotMeta[] {
  return appointments.flatMap((appointment) =>
    appointment.slotsOfAppointment.map((slot) => {
      // Determine appointment type and title
      let type: AppointmentsType;
      let title: string;

      if (appointment.consultation) {
        type = AppointmentsType.CONSULTATION;
        title = appointment.consultation.consultationPlan?.title || "Consultation";
      } else if (appointment.subscription) {
        type = AppointmentsType.SUBSCRIPTION;
        title = appointment.subscription.subscriptionPlan?.title || "Subscription";
      } else if (appointment.webinar) {
        type = AppointmentsType.WEBINAR;
        title = appointment.webinar.webinarPlan?.title || "Webinar";
      } else if (appointment.class) {
        type = AppointmentsType.CLASS;
        title = appointment.class.classPlan?.title || "Class";
      } else {
        // Fallback for unknown appointment types
        type = appointment.appointmentType || AppointmentsType.CONSULTATION;
        title = "Appointment";
      }

      return {
        startTime: new Date(slot.slotStartTimeInUTC),
        endTime: new Date(slot.slotEndTimeInUTC),
        appointmentDetails: {
          id: appointment.id,
          type,
          title,
        },
      };
    })
  );
}

// ===== CALENDAR UTILITIES =====

/**
 * Calculate total available slots for a given period
 */
export function calculateTotalAvailableSlots(
  availableSlots: TimeSlotMeta[],
  existingAppointments: DetailedTimeSlotMeta[]
): number {
  let count = 0;
  const currentTime = new Date();
  
  const slotsByDay = new Map<string, TimeSlotMeta[]>();
  
  availableSlots.forEach((slot) => {
    const startTime = slot.startTime instanceof Date ? slot.startTime : new Date(slot.startTime);
    const dayKey = startTime.toDateString();
    
    if (!slotsByDay.has(dayKey)) {
      slotsByDay.set(dayKey, []);
    }
    slotsByDay.get(dayKey)!.push(slot);
  });
  
  slotsByDay.forEach((daySlots, dayKey) => {
    const dayDate = new Date(dayKey);
    
    for (let hour = 0; hour < 24; hour++) {
      for (let minute = 0; minute < 60; minute += 30) {
        const intervalStart = new Date(dayDate);
        intervalStart.setHours(hour, minute, 0, 0);
        const intervalEnd = new Date(intervalStart);
        intervalEnd.setMinutes(intervalStart.getMinutes() + 30);
        
        if (intervalEnd <= currentTime) continue;
        
        const isCoveredByAvailability = daySlots.some((slot) => {
          const slotStart = slot.startTime instanceof Date ? slot.startTime : new Date(slot.startTime);
          const slotEnd = slot.endTime instanceof Date ? slot.endTime : new Date(slot.endTime);
          return slotStart <= intervalStart && slotEnd >= intervalEnd;
        });
        
        if (!isCoveredByAvailability) continue;
        
        const hasConflict = existingAppointments.some((appointment) => {
          const appointmentStart = appointment.startTime instanceof Date ? appointment.startTime : new Date(appointment.startTime);
          const appointmentEnd = appointment.endTime instanceof Date ? appointment.endTime : new Date(appointment.endTime);
          return intervalStart < appointmentEnd && appointmentStart < intervalEnd;
        });
        
        if (!hasConflict) {
          count++;
        }
      }
    }
  });
  
  return count;
}

/**
 * Get week view dates from current date
 */
export function getWeekViewDates(currentDate: Date): Date[] {
  const startOfWeek = new Date(currentDate);
  startOfWeek.setDate(currentDate.getDate() - currentDate.getDay());
  startOfWeek.setHours(0, 0, 0, 0);

  return Array.from({ length: 7 }, (_, dayIndex) => {
    const date = new Date(startOfWeek);
    date.setDate(startOfWeek.getDate() + dayIndex);
    return date;
  });
}

/**
 * Navigate date for calendar
 */
export function navigateDate(
  currentDate: Date,
  direction: "previous" | "next",
  view: "week" | "month"
): Date {
  const newDate = new Date(currentDate);
  const offset = view === "week" ? 7 : 30;
  const multiplier = direction === "next" ? 1 : -1;
  newDate.setDate(newDate.getDate() + (offset * multiplier));
  return newDate;
}

/**
 * Get days in month
 */
export function getDaysInMonth(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

/**
 * Count available slots for a specific day
 */
export function countAvailableSlotsForDay(
  date: Date,
  availableSlots: TimeSlotMeta[],
  existingAppointments: DetailedTimeSlotMeta[]
): number {
  let count = 0;
  const currentTime = new Date();
  
  for (let hour = 0; hour < 24; hour++) {
    for (let minute = 0; minute < 60; minute += 30) {
      const intervalStart = new Date(date);
      intervalStart.setHours(hour, minute, 0, 0);
      const intervalEnd = new Date(intervalStart);
      intervalEnd.setMinutes(intervalStart.getMinutes() + 30);
      
      if (intervalEnd <= currentTime) continue;
      
      const isCoveredByAvailability = availableSlots.some((slot) => {
        const slotStart = slot.startTime instanceof Date ? slot.startTime : new Date(slot.startTime);
        const slotEnd = slot.endTime instanceof Date ? slot.endTime : new Date(slot.endTime);
        const slotDate = slotStart.toDateString();
        const intervalDate = intervalStart.toDateString();
        return slotDate === intervalDate && slotStart <= intervalStart && slotEnd >= intervalEnd;
      });
      
      if (!isCoveredByAvailability) continue;
      
      const hasConflict = existingAppointments.some((appointment) => {
        const appointmentStart = appointment.startTime instanceof Date ? appointment.startTime : new Date(appointment.startTime);
        const appointmentEnd = appointment.endTime instanceof Date ? appointment.endTime : new Date(appointment.endTime);
        return intervalStart < appointmentEnd && appointmentStart < intervalEnd;
      });
      
      if (!hasConflict) {
        count++;
      }
    }
  }
  
  return count;
}

// ===== ALLOCATION UTILITIES =====

/**
 * Check if auto allocation is possible for a request
 */
export function canAutoAllocate(
  selectedRequest: Request | null,
  availableSlots: TimeSlotMeta[],
  existingAppointments: DetailedTimeSlotMeta[]
): boolean {
  if (!selectedRequest || !availableSlots.length) return false;

  const currentTime = new Date();
  let availableSlotCount = 0;
  const requiredSlots = selectedRequest.requiredSlots;

  const slotsByDay = new Map<string, TimeSlotMeta[]>();
  
  availableSlots.forEach((slot) => {
    const startTime = slot.startTime instanceof Date ? slot.startTime : new Date(slot.startTime);
    const dayKey = startTime.toDateString();
    
    if (!slotsByDay.has(dayKey)) {
      slotsByDay.set(dayKey, []);
    }
    slotsByDay.get(dayKey)!.push(slot);
  });

  slotsByDay.forEach((daySlots, dayKey) => {
    if (availableSlotCount >= requiredSlots) return;
    
    const dayDate = new Date(dayKey);
    
    for (let hour = 0; hour < 24; hour++) {
      for (let minute = 0; minute < 60; minute += 30) {
        if (availableSlotCount >= requiredSlots) break;
        
        const intervalStart = new Date(dayDate);
        intervalStart.setHours(hour, minute, 0, 0);
        const intervalEnd = new Date(intervalStart);
        intervalEnd.setMinutes(intervalStart.getMinutes() + 30);
        
        if (intervalEnd <= currentTime) continue;
        
        const isCoveredByAvailability = daySlots.some((slot) => {
          const slotStart = slot.startTime instanceof Date ? slot.startTime : new Date(slot.startTime);
          const slotEnd = slot.endTime instanceof Date ? slot.endTime : new Date(slot.endTime);
          return slotStart <= intervalStart && slotEnd >= intervalEnd;
        });
        
        if (!isCoveredByAvailability) continue;
        
        const hasConflict = existingAppointments.some((appointment) => {
          const appointmentStart = appointment.startTime instanceof Date ? appointment.startTime : new Date(appointment.startTime);
          const appointmentEnd = appointment.endTime instanceof Date ? appointment.endTime : new Date(appointment.endTime);
          return intervalStart < appointmentEnd && appointmentStart < intervalEnd;
        });
        
        if (!hasConflict) {
          availableSlotCount++;
        }
      }
    }
  });
  
  return availableSlotCount >= requiredSlots;
}

// ===== UI UTILITIES =====

/**
 * Get badge variant for request status
 */
export function getRequestStatusBadgeVariant(
  status: RequestStatus,
): "outline" | "default" | "destructive" {
  switch (status) {
    case RequestStatus.PENDING:
      return "outline";
    case RequestStatus.APPROVED:
      return "default";
    case RequestStatus.REJECTED:
    case RequestStatus.CANCELLED:
    case RequestStatus.EXPIRED:
      return "destructive";
    default:
      return "outline";
  }
}

/**
 * Get timezone of browser
 */
export function getBrowserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// ===== POLLING UTILITIES =====

/**
 * Setup polling with visibility detection
 */
export function setupPolling(
  callback: () => void,
  intervalMs: number = 30000
): () => void {
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let isVisible = !document.hidden;

  const startPolling = () => {
    if (intervalId) clearInterval(intervalId);
    intervalId = setInterval(callback, intervalMs);
  };

  const stopPolling = () => {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };

  const handleVisibilityChange = () => {
    isVisible = !document.hidden;
    if (isVisible) {
      startPolling();
    } else {
      stopPolling();
    }
  };

  document.addEventListener("visibilitychange", handleVisibilityChange);
  
  if (isVisible) {
    startPolling();
  }

  return () => {
    stopPolling();
    document.removeEventListener("visibilitychange", handleVisibilityChange);
  };
}
