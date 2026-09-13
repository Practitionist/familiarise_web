/**
 * Participant counting over the appointment roster (#1554).
 *
 * The seat is an `AppointmentParticipant` row; the per-occurrence user join is
 * gone. Every helper here is pure — no Prisma import — so client components can
 * run them on data a server component handed down. Callers include
 * `participants` on the appointment (ideally already filtered with
 * `liveParticipant()`); the status filter below is defence in depth for a
 * caller that included the whole roster.
 */

/** Statuses under which a participant row still holds its seat. */
const LIVE = new Set(["HELD", "CONFIRMED", "ATTENDED"]);

export type SeatHolder = { userId: string; status?: string };

export type SeatBearingAppointment = {
  participants?: SeatHolder[] | null;
};

/** Live seat holders of one appointment, minus the excluded ids. */
export function liveSeatUserIds(
  appointment: SeatBearingAppointment | null | undefined,
  excludeUserIds: string[] = [],
): Set<string> {
  const ids = new Set<string>();
  for (const seat of appointment?.participants ?? []) {
    if (seat.status !== undefined && !LIVE.has(seat.status)) continue;
    if (excludeUserIds.includes(seat.userId)) continue;
    ids.add(seat.userId);
  }
  return ids;
}

/**
 * Count unique participants across multiple appointments — a class student
 * holds a seat on every session's appointment, so seats are unique users.
 */
export function countUniqueParticipants(
  appointments: SeatBearingAppointment[],
  excludeUserIds: string[] = [],
): number {
  const uniqueUserIds = new Set<string>();
  for (const appointment of appointments) {
    for (const id of liveSeatUserIds(appointment, excludeUserIds)) {
      uniqueUserIds.add(id);
    }
  }
  return uniqueUserIds.size;
}

/** Count participants of a webinar's single appointment. */
export function countWebinarParticipants(
  appointment: SeatBearingAppointment | null,
  excludeUserIds: string[] = [],
): number {
  return liveSeatUserIds(appointment, excludeUserIds).size;
}

/** Whether the user holds a seat on any of the appointments (class enrolment). */
export function isUserEnrolled(
  appointments: SeatBearingAppointment[],
  userId: string,
): boolean {
  return appointments.some((appointment) =>
    liveSeatUserIds(appointment).has(userId),
  );
}

/** Whether the user holds a seat on any of the webinars' appointments. */
export function isUserRegisteredForWebinar(
  webinars: Array<{ appointment?: SeatBearingAppointment | null }>,
  userId: string,
): boolean {
  return webinars.some((webinar) =>
    liveSeatUserIds(webinar.appointment).has(userId),
  );
}
