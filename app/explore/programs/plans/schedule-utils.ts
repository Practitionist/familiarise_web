import { differenceInDays, startOfDay } from "date-fns";

export type SessionStatus = "Upcoming" | "Completed" | "Happening Now";

export interface SessionInfo {
  sessionNumber: number;
  appointmentId: string;
  sessionStart: Date;
  sessionEnd: Date;
  status: SessionStatus;
}

/**
 * Consolidate appointment slots into session rows.
 *
 * Each appointment represents one class session — its slots are consecutive
 * time blocks (e.g. 3×30 min = 1.5 hr). This function merges them into a
 * single start→end range per appointment and assigns a global session number.
 */
interface AppointmentSlot {
  startsAt: string | Date;
  endsAt: string | Date;
}

interface AppointmentWithSlots {
  id: string;
  slotsOfAppointment: AppointmentSlot[];
}

export function buildSessionsFromAppointments(
  appointments: AppointmentWithSlots[],
): SessionInfo[] {
  const now = new Date();

  const sorted = [...appointments]
    .filter((a) => a.slotsOfAppointment?.length > 0)
    .sort((a, b) => {
      const aStart = new Date(a.slotsOfAppointment[0].startsAt).getTime();
      const bStart = new Date(b.slotsOfAppointment[0].startsAt).getTime();
      return aStart - bStart;
    });

  return sorted.map((appointment, idx) => {
    const slots = [...appointment.slotsOfAppointment].sort(
      (a, b) =>
        new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
    );
    const sessionStart = new Date(slots[0].startsAt);
    const sessionEnd = new Date(slots[slots.length - 1].endsAt);

    let status: SessionStatus = "Upcoming";
    if (now > sessionEnd) status = "Completed";
    else if (now >= sessionStart && now < sessionEnd) status = "Happening Now";

    return {
      sessionNumber: idx + 1,
      appointmentId: appointment.id,
      sessionStart,
      sessionEnd,
      status,
    };
  });
}

/**
 * Group sessions by week number relative to the first session's date.
 * Returns a Map of weekNumber → sessions in that week.
 */
export function groupSessionsByWeek(
  sessions: SessionInfo[],
): Map<number, SessionInfo[]> {
  const weeks = new Map<number, SessionInfo[]>();
  if (sessions.length === 0) return weeks;

  const firstDate = sessions[0].sessionStart;

  for (const session of sessions) {
    const daysDiff = differenceInDays(
      startOfDay(session.sessionStart),
      startOfDay(firstDate),
    );
    const weekNum = Math.floor(daysDiff / 7) + 1;
    if (!weeks.has(weekNum)) weeks.set(weekNum, []);
    weeks.get(weekNum)!.push(session);
  }

  return weeks;
}
