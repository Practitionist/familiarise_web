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

/** Count participants of an event's one appointment (webinar or class, #1554). */
export function countWebinarParticipants(
  appointment: SeatBearingAppointment | null,
  excludeUserIds: string[] = [],
): number {
  return liveSeatUserIds(appointment, excludeUserIds).size;
}

/** Whether the user holds a seat on the class's appointment (enrolment). */
export function isUserEnrolled(
  appointment: SeatBearingAppointment | null | undefined,
  userId: string,
): boolean {
  return liveSeatUserIds(appointment).has(userId);
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
