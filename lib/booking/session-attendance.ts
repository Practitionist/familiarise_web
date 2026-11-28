/**
 * Who attended one session, for its host only: each seat holder's minutes in
 * the booked window, from Stream's settled record with devices merged. Before
 * the record is stored, `settled` is false and no minutes are claimed. A
 * learner never sees another learner's presence.
 */

import prisma from "@/lib/prisma";
import { liveParticipant } from "./participants";
import { presentMinutes } from "./session-outcome";
import {
  currentSessionHostUserIds,
  SESSION_HOSTS_SELECT,
} from "./session-hosts";

export interface SeatAttendance {
  userId: string;
  name: string | null;
  presentMinutes: number;
}

/** Null when the viewer is not on the host side (or the session is not this booking's). */
export async function readSessionAttendance(args: {
  appointmentId: string;
  occurrenceId: string;
  viewerUserId: string;
  privileged: boolean;
}): Promise<{
  bookedMinutes: number;
  settled: boolean;
  seats: SeatAttendance[];
} | null> {
  const occ = await prisma.appointmentOccurrence.findFirst({
    where: { id: args.occurrenceId, appointmentId: args.appointmentId },
    select: {
      startsAt: true,
      endsAt: true,
      meeting: { select: { attendanceSettledAt: true } },
      presences: { select: { userId: true, joinedAt: true, leftAt: true } },
      appointment: {
        select: {
          ...SESSION_HOSTS_SELECT,
          participants: {
            where: { role: "CONSULTEE", ...liveParticipant() },
            select: { userId: true, user: { select: { name: true } } },
          },
        },
      },
    },
  });
  if (!occ) return null;
  // A permission check, so today's roster: a past collaborator no longer sees attendance.
  const hosts = currentSessionHostUserIds(occ.appointment);
  if (!args.privileged && !hosts.includes(args.viewerUserId)) return null;
  const settled = Boolean(occ.meeting?.attendanceSettledAt);
  return {
    bookedMinutes: Math.round(
      (occ.endsAt.getTime() - occ.startsAt.getTime()) / 60_000,
    ),
    settled,
    seats: occ.appointment.participants.map((p) => ({
      userId: p.userId,
      name: p.user.name,
      presentMinutes: settled
        ? presentMinutes(
            occ.presences.filter((i) => i.userId === p.userId),
            occ.startsAt,
            occ.endsAt,
          )
        : 0,
    })),
  };
}
