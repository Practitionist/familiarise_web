import { format } from "date-fns";
import { TAppointment } from "@/types/appointment";

// =============================================================================
// Collaborator Role Helpers
// =============================================================================

/**
 * Determine the collaborator role for the current consultant on a webinar/class appointment.
 * Returns null for consultations/subscriptions (no collaborators) or solo events without collaborators.
 */
export function getCollaboratorRole(
  appointment: TAppointment,
  consultantId: string,
): string | null {
  if (appointment.appointmentType === "WEBINAR" && appointment.webinar) {
    const plan = appointment.webinar.webinarPlan;
    if (plan?.consultantProfileId === consultantId) {
      // Only show "Host" badge if there are collaborators
      const collaborators = (plan as Record<string, unknown>).collaborators;
      if (Array.isArray(collaborators) && collaborators.length > 0) {
        return "HOST";
      }
      return null; // Solo event
    }
    const collaborators = (plan as Record<string, unknown>).collaborators;
    if (Array.isArray(collaborators)) {
      const collab = collaborators.find(
        (c: Record<string, unknown>) => c.consultantProfileId === consultantId,
      );
      if (collab) return (collab as Record<string, unknown>).role as string;
    }
  }
  if (appointment.appointmentType === "CLASS" && appointment.class) {
    const plan = appointment.class.classPlan;
    if (plan?.consultantProfileId === consultantId) {
      const collaborators = (plan as Record<string, unknown>).collaborators;
      if (Array.isArray(collaborators) && collaborators.length > 0) {
        return "HOST";
      }
      return null;
    }
    const collaborators = (plan as Record<string, unknown>).collaborators;
    if (Array.isArray(collaborators)) {
      const collab = collaborators.find(
        (c: Record<string, unknown>) => c.consultantProfileId === consultantId,
      );
      if (collab) return (collab as Record<string, unknown>).role as string;
    }
  }
  return null;
}

/** Format a collaborator role enum value to a human-readable label */
export function formatCollaboratorRole(role: string): string {
  const labels: Record<string, string> = {
    HOST: "Host",
    CO_HOST: "Co-Host",
    MODERATOR: "Moderator",
    GUEST_SPEAKER: "Guest Speaker",
    TECHNICAL_SUPPORT: "Tech Support",
    CO_INSTRUCTOR: "Co-Instructor",
    TEACHING_ASSISTANT: "TA",
    GUEST_LECTURER: "Guest Lecturer",
    CONTENT_CREATOR: "Content Creator",
  };
  return labels[role] || role;
}

/** Get the CSS class for a collaborator role badge */
export function getRoleBadgeStyle(role: string): string {
  if (role === "HOST") return "bg-gray-900 text-white";
  return "bg-purple-100 text-purple-800";
}

/**
 * Type for appointment slot that supports both API response formats
 * - startsAt: Standard Prisma field from direct queries
 * - slotStartTimeInUTC: Legacy field from transformed dashboard API responses
 */
type AppointmentSlot = {
  startsAt?: string | Date;
  slotStartTimeInUTC?: string | Date;
};

// Get the relevant name based on appointment type
// For consultations/subscriptions: returns the consultee (requester) name
// For webinars/classes: returns the consultant (host) name
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
      // For webinars, show the consultant (host) name
      return (
        appointment.webinar?.webinarPlan?.consultantProfile?.user?.name ??
        "Unknown Consultant"
      );
    case "CLASS":
      // For classes, show the consultant (instructor) name
      return (
        appointment.class?.classPlan?.consultantProfile?.user?.name ??
        "Unknown Consultant"
      );
    default:
      return "Unknown User";
  }
};

// Get the relevant image based on appointment type
// For consultations/subscriptions: returns the consultee (requester) image
// For webinars/classes: returns the consultant (host) image
export const getConsumeeImage = (appointment: TAppointment): string => {
  if (!appointment) return "/placeholder.svg";

  switch (appointment.appointmentType) {
    case "CONSULTATION":
      return (
        appointment.consultation?.requestedBy?.user?.image ??
        "/placeholder-user.jpg"
      );
    case "SUBSCRIPTION":
      return (
        appointment.subscription?.requestedBy?.user?.image ??
        "/placeholder-user.jpg"
      );
    case "WEBINAR":
      // For webinars, show the consultant (host) image
      return (
        appointment.webinar?.webinarPlan?.consultantProfile?.user?.image ??
        "/placeholder.svg"
      );
    case "CLASS":
      // For classes, show the consultant (instructor) image
      return (
        appointment.class?.classPlan?.consultantProfile?.user?.image ??
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
    .map((slot: AppointmentSlot) => {
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
  // `groupRecurringAppointments` expands SUBSCRIPTION/CLASS appointments into one entry per
  // slot (for per-slot UI display). Deduplicate here to get one entry per session.
  // Synthetic IDs have format `${originalAppointmentId}-${slotId}` (both cuid — no dashes),
  // so split at the first `-` to recover the original appointment ID.
  const appointmentType = groupAppointments[0]?.appointmentType;
  const isRecurring =
    appointmentType === "SUBSCRIPTION" || appointmentType === "CLASS";

  let dedupedAppointments: TAppointment[];
  if (isRecurring) {
    const seen = new Set<string>();
    dedupedAppointments = groupAppointments.filter((app) => {
      const dashIdx = app.id.indexOf("-");
      const baseId = dashIdx !== -1 ? app.id.substring(0, dashIdx) : app.id;
      if (seen.has(baseId)) return false;
      seen.add(baseId);
      return true;
    });
  } else {
    dedupedAppointments = groupAppointments;
  }

  const totalSessions = dedupedAppointments.length;
  const completedSessions = dedupedAppointments.filter((app) => {
    const slotTimes = getSlotTimes(app);
    return (
      slotTimes.length > 0 &&
      slotTimes.every((time) => new Date(time) < referenceDate)
    );
  }).length;
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

  // Handle appointments with no slots
  if (!startTime) return "Not Scheduled";

  const now = new Date();

  // Check if appointment is marked as cancelled
  if (
    appointment.class?.status === "CANCELLED" ||
    appointment.webinar?.status === "CANCELLED"
  ) {
    return "Cancelled";
  }

  // Check if appointment is marked as completed
  if (
    appointment.class?.status === "COMPLETED" ||
    appointment.webinar?.status === "COMPLETED"
  ) {
    return "Completed";
  }

  // Check if all slots are in the past
  const slotTimes = getSlotTimes(appointment);
  if (slotTimes.length > 0 && slotTimes.every((time) => new Date(time) < now)) {
    return "Completed";
  }

  // Calculate time differences using local time
  const diffMs = startTime.getTime() - now.getTime();
  const diffMinutes = Math.floor(diffMs / (1000 * 60));

  // Use calendar-based day comparison for accurate "Today"/"Tomorrow" labels
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrowStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
  );
  const dayAfterTomorrowStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 2,
  );

  const appointmentDate = new Date(startTime);

  // Upcoming appointments with more precise timing
  if (diffMinutes <= 5 && diffMinutes > 0) return "Meeting in 5 min";

  // Check if appointment is today (same calendar day)
  if (appointmentDate >= todayStart && appointmentDate < tomorrowStart) {
    return "Today";
  }

  // Check if appointment is tomorrow (next calendar day)
  if (
    appointmentDate >= tomorrowStart &&
    appointmentDate < dayAfterTomorrowStart
  ) {
    return "Tomorrow";
  }

  // Calculate day difference for appointments further out
  const diffDays = Math.floor(
    (appointmentDate.getTime() - todayStart.getTime()) / (1000 * 60 * 60 * 24),
  );

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
      const upcomingSlotTimes = getSlotTimes(appointment);
      const allSlotsCompleted =
        upcomingSlotTimes.length > 0 &&
        upcomingSlotTimes.every((time) => new Date(time) < now);
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

/**
 * Groups appointments by their type (CONSULTATION, SUBSCRIPTION, WEBINAR, CLASS)
 * and sorts them chronologically within each group
 * @param appointments - Array of appointments to group
 * @returns Object with appointment types as keys and sorted appointment arrays as values
 */
export const groupAppointmentsByType = (
  appointments: TAppointment[],
): { [key: string]: TAppointment[] } => {
  const groups: { [key: string]: TAppointment[] } = {
    CONSULTATION: [],
    SUBSCRIPTION: [],
    WEBINAR: [],
    CLASS: [],
  };

  // Group appointments by their type
  appointments.forEach((appointment) => {
    if (appointment.appointmentType && groups[appointment.appointmentType]) {
      groups[appointment.appointmentType].push(appointment);
    }
  });

  // Sort each group chronologically
  Object.keys(groups).forEach((type) => {
    groups[type] = sortAppointmentsByStartTime(groups[type]);
  });

  // Keep empty groups to show all sections even when no appointments exist
  return groups;
};

/**
 * Gets a human-readable display name for an appointment type
 * @param type - The AppointmentsType enum value
 * @returns Formatted display name
 */
export const getAppointmentTypeDisplayName = (type: string): string => {
  const typeMap: { [key: string]: string } = {
    CONSULTATION: "Consultations",
    SUBSCRIPTION: "Subscriptions",
    WEBINAR: "Webinars",
    CLASS: "Classes",
  };
  return typeMap[type] || type;
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
    const completedSessions = appointments.filter((app) => {
      const times = getSlotTimes(app);
      return times.length > 0 && times.every((time) => new Date(time) < now);
    }).length;

    return `${plan} (${completedSessions}/${totalSessions} sessions)`;
  }

  if (type === "CLASS" && firstAppointment.class) {
    const plan = firstAppointment.class.classPlan?.title || "Unknown Class";
    const totalSessions = appointments.length;

    // Count completed sessions based on slot times, same as subscription
    const now = new Date();
    const completedSessions = appointments.filter((app) => {
      const times = getSlotTimes(app);
      return times.length > 0 && times.every((time) => new Date(time) < now);
    }).length;

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
    const hasCompletedSessions = appointments.some((app) => {
      const times = getSlotTimes(app);
      return times.length > 0 && times.every((time) => new Date(time) < now);
    });

    if (now > endDate) return "Completed";
    if (now < startDate) return "Not Started";
    return hasCompletedSessions ? "In Progress" : "Not Started";
  }

  if (type === "CLASS" && firstAppointment.class) {
    const now = new Date();

    // Check if any sessions are completed, same as subscription
    const hasCompletedSessions = appointments.some((app) => {
      const times = getSlotTimes(app);
      return times.length > 0 && times.every((time) => new Date(time) < now);
    });

    // Check if all sessions are completed
    const allSessionsCompleted = appointments.every((app) => {
      const times = getSlotTimes(app);
      return times.length > 0 && times.every((time) => new Date(time) < now);
    });

    if (allSessionsCompleted) return "Completed";
    return hasCompletedSessions ? "In Progress" : "Not Started";
  }

  return getAppointmentStatus(firstAppointment);
};
