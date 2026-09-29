/**
 * #1569 B-4 — who attended one session, for its host only: each seat holder's
 * minutes in the booked window, read from MeetingPresence with devices merged.
 * A learner never sees another learner's presence.
 */

import prisma from "@/lib/prisma";
import { liveParticipant } from "./participants";
import { presentMinutes } from "./session-outcome";
import { SESSION_HOSTS_SELECT, sessionHostUserIds } from "./session-hosts";

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
}): Promise<{ bookedMinutes: number; seats: SeatAttendance[] } | null> {
  const occ = await prisma.appointmentOccurrence.findFirst({
    where: { id: args.occurrenceId, appointmentId: args.appointmentId },
    select: {
      startsAt: true,
      endsAt: true,
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
  const hosts = sessionHostUserIds(occ.appointment);
  if (!args.privileged && !hosts.includes(args.viewerUserId)) return null;
  const now = new Date();
  const to = occ.endsAt < now ? occ.endsAt : now;
  return {
    bookedMinutes: Math.round(
      (occ.endsAt.getTime() - occ.startsAt.getTime()) / 60_000,
    ),
    seats: occ.appointment.participants.map((p) => ({
      userId: p.userId,
      name: p.user.name,
      presentMinutes: presentMinutes(
        // An open interval counts up to now.
        occ.presences
          .filter((i) => i.userId === p.userId)
          .map((i) => ({ ...i, leftAt: i.leftAt ?? now })),
        occ.startsAt,
        to,
      ),
    })),
  };
}
