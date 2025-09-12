import { format } from "date-fns";
import { TAppointment } from "@/types/appointment";

// Helper: count number of Sunday-start weeks overlapping [start, end] inclusive
function countSundayWeeksInclusiveLocal(
  startDate: Date,
  endDate: Date,
): number {
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (end < start) return 0;
  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);
  // get Sunday of week for a given date
  const toSunday = (d: Date) => {
    const date = new Date(d);
    const day = date.getDay(); // 0 = Sunday
    const sunday = new Date(date);
    sunday.setDate(date.getDate() - day);
    sunday.setHours(0, 0, 0, 0);
    return sunday;
  };
  const startSunday = toSunday(start);
  const endSunday = toSunday(end);
  let weeks = 1;
  const cursor = new Date(startSunday);
  while (cursor < endSunday) {
    cursor.setDate(cursor.getDate() + 7);
    weeks += 1;
  }
  return weeks;
}

// Calculate completed sessions using week-based logic
function calculateWeekBasedCompletedSessions(
  subscriptionStart: Date,
  subscriptionEnd: Date,
  currentDate: Date,
  callsPerWeek: number,
  appointments: TAppointment[],
): number {
  // Helper function to get start of week (Sunday)
  const getWeekStart = (date: Date): Date => {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    const day = d.getDay(); // 0 = Sunday
    d.setDate(d.getDate() - day);
    return d;
  };

  // Get week boundaries
  const subscriptionWeekStart = getWeekStart(subscriptionStart);

  // Count completed calls week by week
  let completedCalls = 0;
  const weekStart = new Date(subscriptionWeekStart);

  while (weekStart < subscriptionEnd) {
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);

    // Check if this week is completely in the past
    if (weekEnd < currentDate) {
      // Assume all calls for this past week were completed
      completedCalls += callsPerWeek;
    } else if (weekStart <= currentDate && currentDate <= weekEnd) {
      // Current week - count actual completed appointments
      const currentWeekCompleted = appointments.filter((app) => {
        const slots = getSlotTimes(app);
        if (slots.length === 0) return false;

        const appointmentDate = new Date(slots[0]);
        const isInThisWeek =
          appointmentDate >= weekStart && appointmentDate <= weekEnd;
        const isCompleted =
          new Date(Math.max(...slots.map((time) => new Date(time).getTime()))) <
          currentDate;

        return isInThisWeek && isCompleted;
      }).length;

      completedCalls += currentWeekCompleted;
    }
    // Future weeks: don't count anything

    // Move to next week
    weekStart.setDate(weekStart.getDate() + 7);
  }

  // Cap at total possible sessions
  const totalSubscriptionWeeks = countSundayWeeksInclusiveLocal(
    subscriptionStart,
    subscriptionEnd,
  );
  const maxPossibleSessions = totalSubscriptionWeeks * callsPerWeek;
  return Math.min(completedCalls, maxPossibleSessions);
}

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

  const times = appointment.slotsOfAppointment
    .map((slot) => {
      const time = slot.slotStartTimeInUTC;
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

  // Ensure earliest-first ordering so consumers like getStartTime use the true start
  times.sort((a, b) => a.getTime() - b.getTime());
  return times;
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

// Expand appointments into per-day sessions, grouping contiguous 30-min slots on the same day
export const expandAppointmentsIntoSessions = (
  appointments: TAppointment[],
): TAppointment[] => {
  return (appointments || []).flatMap((appointment) => {
    const slots = appointment.slotsOfAppointment || [];
    if (slots.length === 0) return [appointment];

    // Sort slots by start time to build contiguous sessions
    const sorted = [...slots].sort((a, b) => {
      const aStart = new Date(a.slotStartTimeInUTC as string | Date).getTime();
      const bStart = new Date(b.slotStartTimeInUTC as string | Date).getTime();
      return aStart - bStart;
    });

    // Group contiguous slots (30-min adjacency) within the same day
    const sessions: Array<typeof slots> = [];
    let run: typeof slots = [];
    let lastEnd: number | null = null;
    let lastDay: string | null = null;

    for (const s of sorted) {
      const start = new Date(s.slotStartTimeInUTC as string | Date);
      const end = new Date(
        (s.slotEndTimeInUTC as string | Date) || s.slotStartTimeInUTC,
      );
      const dayKey = start.toDateString();

      const isContiguous =
        lastEnd !== null && dayKey === lastDay && start.getTime() === lastEnd;

      if (!isContiguous && run.length > 0) {
        sessions.push(run);
        run = [];
      }
      run.push(s);
      lastEnd = end.getTime();
      lastDay = dayKey;
    }
    if (run.length > 0) sessions.push(run);

    // Map each session to one appointment-like item
    return sessions.map((sessionSlots, idx) => ({
      ...appointment,
      id: `${appointment.id}-session-${idx}`,
      slotsOfAppointment: sessionSlots,
    }));
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

  // Expand appointments ONLY for recurring events (subscription/class)
  const expandedAppointments = appointments.flatMap((appointment) => {
    const hasSlots =
      Array.isArray(appointment.slotsOfAppointment) &&
      appointment.slotsOfAppointment.length > 0;

    // For consultations/webinars, do NOT split by slot
    if (
      !hasSlots ||
      appointment.appointmentType === "CONSULTATION" ||
      appointment.appointmentType === "WEBINAR"
    ) {
      return [appointment];
    }

    // For subscriptions/classes, create separate entries for each slot
    return appointment.slotsOfAppointment.map((slot) => ({
      ...appointment,
      id: `${appointment.id}-${slot.id}`,
      slotsOfAppointment: [slot],
    }));
  });

  return expandedAppointments.filter((appointment) => {
    const slotTime = getStartTime(appointment);
    if (!slotTime) return false;

    const slotDate = new Date(slotTime);
    const isToday = slotDate >= todayStart && slotDate <= todayEnd;

    // For subscription appointments, also check if they're active
    if (
      appointment.appointmentType === "SUBSCRIPTION" &&
      appointment.subscription
    ) {
      const startDate = new Date(appointment.subscription.startDate);
      const endDate = new Date(appointment.subscription.endDate);
      return isToday && now >= startDate && now <= endDate;
    }

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

    const hasSlots =
      Array.isArray(appointment.slotsOfAppointment) &&
      appointment.slotsOfAppointment.length > 0;

    // Do NOT split appointments by 30-minute slots in any case.
    // Keep each appointment (session) intact so the UI shows only the session start time once.
    if (!hasSlots) {
      groups[groupKey].push({
        ...appointment,
        id: `${appointment.id}-default`,
      });
    } else {
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
    // Expected total sessions = weeks in window × callsPerWeek
    const sub = firstAppointment.subscription as unknown as {
      startDate?: string | Date;
      endDate?: string | Date;
      subscriptionPlan?: { callsPerWeek?: number } | null;
    };
    const startDate = sub?.startDate ? new Date(sub.startDate) : undefined;
    const endDate = sub?.endDate ? new Date(sub.endDate) : undefined;
    const callsPerWeek = sub?.subscriptionPlan?.callsPerWeek || 1;
    const totalSessions =
      startDate && endDate
        ? countSundayWeeksInclusiveLocal(startDate, endDate) * callsPerWeek
        : appointments.length;

    // Week-based completion logic:
    // 1. Past complete weeks = assumed completed (weeks × callsPerWeek)
    // 2. Current week = only count actual completed calls
    const now = new Date();
    const completedSessions = calculateWeekBasedCompletedSessions(
      startDate!,
      endDate!,
      now,
      callsPerWeek,
      appointments,
    );

    return `${plan} (${completedSessions}/${totalSessions} sessions)`;
  }

  if (type === "CLASS" && firstAppointment.class) {
    const plan = firstAppointment.class.classPlan?.title || "Unknown Class";
    // Expected total sessions = weeks in window × callsPerWeek (classes per week)
    const cls = firstAppointment.class as unknown as {
      startDate?: string | Date;
      endDate?: string | Date;
      classPlan?: { callsPerWeek?: number } | null;
    };
    const startDate = cls?.startDate ? new Date(cls.startDate) : undefined;
    const endDate = cls?.endDate ? new Date(cls.endDate) : undefined;
    const callsPerWeek = cls?.classPlan?.callsPerWeek || 1;
    const totalSessions =
      startDate && endDate
        ? countSundayWeeksInclusiveLocal(startDate, endDate) * callsPerWeek
        : appointments.length;

    // Week-based completion logic for classes:
    // 1. Past complete weeks = assumed completed (weeks × callsPerWeek)
    // 2. Current week = only count actual completed classes
    const now = new Date();
    const completedSessions = calculateWeekBasedCompletedSessions(
      startDate!,
      endDate!,
      now,
      callsPerWeek,
      appointments,
    );

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
    const startDate = new Date(firstAppointment.subscription.startDate);
    const endDate = new Date(firstAppointment.subscription.endDate);

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
