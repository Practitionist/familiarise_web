import { format } from "date-fns";
import { TAppointment } from "@/types/appointment";

// Get the consultee name based on appointment type
export const getConsumeeName = (appointment: TAppointment): string => {
  if (!appointment) return "Unknown User";

  switch (appointment.appointmentType) {
    case "CONSULTATION":
      return (
        appointment.consultation?.requestedBy?.user?.name ?? "Unknown User"
      );
    case "SUBSCRIPTION":
      return (
        appointment.subscription?.requestedBy?.user?.name ?? "Unknown User"
      );
    case "WEBINAR":
    case "CLASS":
      return (
        appointment.slotsOfAppointment?.[0]?.user?.[0]?.name ?? "Unknown User"
      );
    default:
      return "Unknown User";
  }
};

// Get the consultee image based on appointment type
export const getConsumeeImage = (appointment: TAppointment): string => {
  if (!appointment) return "/placeholder.svg";

  switch (appointment.appointmentType) {
    case "CONSULTATION":
      return (
        appointment.consultation?.requestedBy?.user?.image ?? "/placeholder.svg"
      );
    case "SUBSCRIPTION":
      return (
        appointment.subscription?.requestedBy?.user?.image ?? "/placeholder.svg"
      );
    case "WEBINAR":
    case "CLASS":
      return (
        appointment.slotsOfAppointment?.[0]?.user?.[0]?.image ??
        "/placeholder.svg"
      );
    default:
      return "/placeholder.svg";
  }
};

// Get appointment type and plan
export const getAppointmentTypeAndPlan = (
  appointment: TAppointment,
): string => {
  if (!appointment?.appointmentType) return "Unknown Type";

  const type =
    appointment.appointmentType.charAt(0) +
    appointment.appointmentType.slice(1).toLowerCase();
  let plan = "Unknown Plan";

  switch (appointment.appointmentType) {
    case "CONSULTATION":
      plan =
        appointment.consultation?.consultationPlan?.title ?? "Unknown Plan";
      break;
    case "SUBSCRIPTION":
      plan =
        appointment.subscription?.subscriptionPlan?.title ?? "Unknown Plan";
      break;
    case "WEBINAR":
      plan = appointment.webinar?.webinarPlan?.title ?? "Unknown Plan";
      break;
    case "CLASS":
      plan = appointment.class?.classPlan?.title ?? "Unknown Plan";
      break;
  }

  return `${type} - ${plan}`;
};

// Get all slot times from appointment with proper type conversion
export const getSlotTimes = (appointment: TAppointment): Date[] => {
  if (!appointment?.slotsOfAppointment?.length) {
    return [];
  }

  return appointment.slotsOfAppointment
    .map((slot: any) => {
      // Support both field names: startsAt (from API) and slotStartTimeInUTC (from dashboard API transformation)
      const time = slot.startsAt || slot.slotStartTimeInUTC;
      // Handle both Date objects and string timestamps
      if (time instanceof Date) {
        return time;
      }
      if (typeof time === "string" || typeof time === "number") {
        const date = new Date(time);
        return isNaN(date.getTime()) ? null : date;
      }
      return null;
    })
    .filter((date): date is Date => date !== null);
};

/**
 * Calculates session progress metrics for a group of appointments
 * @param groupAppointments - Array of appointments in the group (e.g., subscription sessions)
 * @param referenceDate - Optional reference date for comparison (defaults to now)
 * @returns Session progress metrics including total, completed, remaining sessions and percentage
 */
export const calculateSessionProgress = (
  groupAppointments: TAppointment[],
  referenceDate: Date = new Date(),
): {
  totalSessions: number;
  completedSessions: number;
  remainingSessions: number;
  progressPercentage: number;
} => {
  const totalSessions = groupAppointments.length;
  const completedSessions = groupAppointments.filter((app) =>
    getSlotTimes(app).every((time) => new Date(time) < referenceDate),
  ).length;
  const remainingSessions = totalSessions - completedSessions;
  const progressPercentage =
    totalSessions > 0 ? (completedSessions / totalSessions) * 100 : 0;

  return {
    totalSessions,
    completedSessions,
    remainingSessions,
    progressPercentage,
  };
};

// Get first slot time from appointment (for backwards compatibility)
export const getStartTime = (appointment: TAppointment): Date | null => {
  const times = getSlotTimes(appointment);
  return times.length > 0 ? times[0] : null;
};

// Check if appointment has any future slots
export const hasUpcomingSlots = (appointment: TAppointment): boolean => {
  const now = new Date();
  return getSlotTimes(appointment).some((time) => new Date(time) > now);
};

// Check if appointment has any slots today
export const hasTodaySlots = (appointment: TAppointment): boolean => {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayEnd = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    23,
    59,
    59,
    999,
  );

  return getSlotTimes(appointment).some((time) => {
    const date = new Date(time);
    return date >= todayStart && date <= todayEnd;
  });
};

// Format UTC time to local time
export const formatAppointmentTime = (utcTime: string): string => {
  // Create a date object in local time
  const localDate = new Date(utcTime);

  // Format the date in local time with browser's timezone
  return format(localDate, "EEE, MMM d, h:mm a");
};

// Get appointment status
export const getAppointmentStatus = (appointment: TAppointment): string => {
  const startTime = getStartTime(appointment);
  if (!startTime) return "Unknown";

  const now = new Date();

  // Check if appointment is marked as completed
  if (
    appointment.class?.status === "COMPLETED" ||
    appointment.webinar?.status === "COMPLETED"
  ) {
    return "Completed";
  }

  // Check if all slots are in the past
  if (getSlotTimes(appointment).every((time) => new Date(time) < now)) {
    return "Completed";
  }

  // Calculate time differences using local time
  const diffMs = startTime.getTime() - now.getTime();
  const diffMinutes = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  // Upcoming appointments with more precise timing
  if (diffMinutes <= 5 && diffMinutes > 0) return "Meeting in 5 min";
  if (diffHours < 24) return "Today";
  if (diffDays === 1) return "Tomorrow";
  if (diffDays < 7) return `In ${diffDays} days`;

  // For weekly intervals, show exact week number
  const exactWeeks = Math.ceil(diffDays / 7);
  return `In ${exactWeeks} ${exactWeeks === 1 ? "week" : "weeks"}`;
};

// Sort appointments by start time
export const sortAppointmentsByStartTime = (
  appointments: TAppointment[],
): TAppointment[] => {
  return [...appointments].sort((a, b) => {
    const aTime = getStartTime(a);
    const bTime = getStartTime(b);
    if (!aTime && !bTime) return 0;
    if (!aTime) return 1; // Put appointments without time at the end
    if (!bTime) return -1;
    return aTime.getTime() - bTime.getTime();
  });
};

// Filter today's appointments
export const getTodayAppointments = (
  appointments: TAppointment[],
): TAppointment[] => {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayEnd = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    23,
    59,
    59,
    999,
  );

  // First expand appointments with multiple slots (only for subscriptions and classes)
  const expandedAppointments = appointments.flatMap((appointment) => {
    if (
      !appointment.slotsOfAppointment ||
      appointment.slotsOfAppointment.length === 0
    ) {
      return [appointment];
    }

    // Only expand subscriptions and classes by slot
    // Consultations and webinars keep all slots together as one event
    if (
      appointment.appointmentType === "SUBSCRIPTION" ||
      appointment.appointmentType === "CLASS"
    ) {
      return appointment.slotsOfAppointment.map((slot) => ({
        ...appointment,
        id: `${appointment.id}-${slot.id}`,
        slotsOfAppointment: [slot],
      }));
    }

    // Keep consultations and webinars as single appointments
    return [appointment];
  });

  return expandedAppointments.filter((appointment) => {
    const slotTime = getStartTime(appointment);
    if (!slotTime) return false;

    const slotDate = new Date(slotTime);
    const isToday = slotDate >= todayStart && slotDate <= todayEnd;

    return isToday;
  });
};

// Filter upcoming appointments
export const getUpcomingAppointments = (
  appointments: TAppointment[],
): TAppointment[] => {
  const now = new Date();

  // First filter out completed appointments
  const filteredAppointments = appointments.filter((appointment) => {
    // For multi-slotted appointments (subscription and class)
    if (
      (appointment.appointmentType === "SUBSCRIPTION" &&
        appointment.subscription) ||
      (appointment.appointmentType === "CLASS" && appointment.class)
    ) {
      // Check if all slots are in the past
      const allSlotsCompleted = getSlotTimes(appointment).every(
        (time) => new Date(time) < now,
      );
      // Only include if not all slots are completed
      return !allSlotsCompleted;
    }

    // For single-slotted appointments (consultation and webinar)
    if (hasUpcomingSlots(appointment)) {
      // For webinar appointments
      if (appointment.appointmentType === "WEBINAR" && appointment.webinar) {
        return appointment.webinar.status !== "COMPLETED";
      }

      // For consultation appointments
      return true;
    }

    return false;
  });

  return filteredAppointments;
};

// Group recurring appointments
export const groupRecurringAppointments = (
  appointments: TAppointment[],
): { [key: string]: TAppointment[] } => {
  const groups: { [key: string]: TAppointment[] } = {};

  // Group appointments by their type (subscription/class/single)
  appointments.forEach((appointment) => {
    let groupKey = "";

    if (
      appointment.appointmentType === "SUBSCRIPTION" &&
      appointment.subscription
    ) {
      groupKey = `subscription-${appointment.subscription.id}`;
    } else if (appointment.appointmentType === "CLASS" && appointment.class) {
      groupKey = `class-${appointment.class.id}`;
    } else {
      groupKey = `single-${appointment.id}`;
    }

    if (!groups[groupKey]) {
      groups[groupKey] = [];
    }

    // For SUBSCRIPTION and CLASS appointments with slots, create separate entries for each slot
    // (because each slot represents a separate session)
    // For CONSULTATION and WEBINAR appointments, keep all slots together
    // (because all slots form one single event)
    if (
      appointment.slotsOfAppointment &&
      appointment.slotsOfAppointment.length > 0 &&
      (appointment.appointmentType === "SUBSCRIPTION" ||
        appointment.appointmentType === "CLASS")
    ) {
      appointment.slotsOfAppointment.forEach((slot) => {
        groups[groupKey].push({
          ...appointment,
          id: `${appointment.id}-${slot.id}`,
          slotsOfAppointment: [slot],
        });
      });
    } else {
      // For appointments without slots or single-event types, add them as is
      groups[groupKey].push(appointment);
    }
  });

  // Sort appointments within each group by start time
  Object.keys(groups).forEach((key) => {
    groups[key] = sortAppointmentsByStartTime(groups[key]);
  });

  return groups;
};

// Get group title
export const getGroupTitle = (appointments: TAppointment[]): string => {
  if (!appointments.length) return "";

  const firstAppointment = appointments[0];
  const type = firstAppointment.appointmentType;

  if (type === "SUBSCRIPTION" && firstAppointment.subscription) {
    const plan =
      firstAppointment.subscription.subscriptionPlan?.title || "Unknown Plan";

    // Count total appointments as sessions
    const totalSessions = appointments.length;

    // Count completed sessions based on slot times
    const now = new Date();
    const completedSessions = appointments.filter((app) =>
      getSlotTimes(app).every((time) => new Date(time) < now),
    ).length;

    return `${plan} (${completedSessions}/${totalSessions} sessions)`;
  }

  if (type === "CLASS" && firstAppointment.class) {
    const plan = firstAppointment.class.classPlan?.title || "Unknown Class";
    const totalSessions = appointments.length;

    // Count completed sessions based on slot times, same as subscription
    const now = new Date();
    const completedSessions = appointments.filter((app) =>
      getSlotTimes(app).every((time) => new Date(time) < now),
    ).length;

    return `${plan} (${completedSessions}/${totalSessions} sessions)`;
  }

  return getAppointmentTypeAndPlan(firstAppointment);
};

// Get group status
export const getGroupStatus = (appointments: TAppointment[]): string => {
  if (!appointments.length) return "Unknown";

  const firstAppointment = appointments[0];
  const type = firstAppointment.appointmentType;

  if (type === "SUBSCRIPTION" && firstAppointment.subscription) {
    const now = new Date();
    const startDate = new Date(
      firstAppointment.subscription.schedulingPeriodStartsAt,
    );
    const endDate = new Date(
      firstAppointment.subscription.schedulingPeriodEndsAt,
    );

    // Check if any sessions are completed
    const hasCompletedSessions = appointments.some((app) =>
      getSlotTimes(app).every((time) => new Date(time) < now),
    );

    if (now > endDate) return "Completed";
    if (now < startDate) return "Not Started";
    return hasCompletedSessions ? "In Progress" : "Not Started";
  }

  if (type === "CLASS" && firstAppointment.class) {
    const now = new Date();

    // Check if any sessions are completed, same as subscription
    const hasCompletedSessions = appointments.some((app) =>
      getSlotTimes(app).every((time) => new Date(time) < now),
    );

    // Check if all sessions are completed
    const allSessionsCompleted = appointments.every((app) =>
      getSlotTimes(app).every((time) => new Date(time) < now),
    );

    if (allSessionsCompleted) return "Completed";
    return hasCompletedSessions ? "In Progress" : "Not Started";
  }

  return getAppointmentStatus(firstAppointment);
};
