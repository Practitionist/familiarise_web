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
 * One session row per occurrence of the class's wrapper (#1554), in start
 * order, with a global session number.
 */
interface AppointmentSlot {
  startsAt: string | Date;
  endsAt: string | Date;
  completionStatus?: string | null;
  deletedAt?: string | Date | null;
}

interface AppointmentWithSlots {
  id: string;
  occurrences: AppointmentSlot[];
}

export function buildSessionsFromAppointment(
  appointment: AppointmentWithSlots | null | undefined,
): SessionInfo[] {
  const now = new Date();
  if (!appointment) return [];

  const sorted = [...appointment.occurrences]
    .filter(
      (o) =>
        !o.deletedAt &&
        o.completionStatus !== "CANCELLED" &&
        o.completionStatus !== "RESCHEDULED",
    )
    .sort(
      (a, b) =>
        new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
    );

  return sorted.map((occurrence, idx) => {
    const sessionStart = new Date(occurrence.startsAt);
    const sessionEnd = new Date(occurrence.endsAt);

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
