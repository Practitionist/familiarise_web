import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/auth-helpers";
import { apiError } from "@/lib/errors";
import { liveParticipant } from "@/lib/booking/participants";
import prisma from "@/lib/prisma";

const NO_STORE = { "Cache-Control": "private, no-store" };

/**
 * The webinar and class plans the caller holds a seat on, as plan ids. This is
 * the only way a client learns "am I registered" for the explore cards: the
 * public plan payloads carry a seat count and never who holds the seats.
 */
export async function GET() {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;

  try {
    const seats = await prisma.appointmentParticipant.findMany({
      where: {
        userId: auth.session.user.id,
        role: "CONSULTEE",
        ...liveParticipant(),
        OR: [
          { appointment: { webinarId: { not: null } } },
          { appointment: { classId: { not: null } } },
        ],
      },
      select: {
        appointment: {
          select: {
            webinar: { select: { webinarPlanId: true } },
            class: { select: { classPlanId: true } },
          },
        },
      },
    });

    const webinarPlanIds = new Set<string>();
    const classPlanIds = new Set<string>();
    for (const { appointment } of seats) {
      if (appointment.webinar)
        webinarPlanIds.add(appointment.webinar.webinarPlanId);
      if (appointment.class) classPlanIds.add(appointment.class.classPlanId);
    }

    return NextResponse.json(
      {
        data: {
          webinarPlanIds: [...webinarPlanIds],
          classPlanIds: [...classPlanIds],
        },
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    return apiError({ tag: "[EventSeats.GET]", error, subsystem: "bookings" });
  }
}
