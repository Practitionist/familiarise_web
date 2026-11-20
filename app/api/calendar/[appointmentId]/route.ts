// A signed, session-less .ics: every refusal is the same 404, and the file carries only the
// title, the times and the dashboard link, never the video link or attendee details. A seat
// that ended with a cancel reads a cancellation of its own entries and nothing more.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import {
  appointmentDashboardUrl,
  calendarDetails,
  calendarSeatWhere,
  holdsCalendarSeat,
  verifyCalendarToken,
} from "@/lib/appointments/calendar-links";
import {
  buildIcs,
  calendarOccurrences,
  icsSessions,
} from "@/lib/appointments/ics";
import { planTitleOrSessionLabel } from "@/lib/novu/humanize";
import { applyRateLimit, calendarLimiter, getClientIp } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };

const QuerySchema = z.object({
  u: z.string().min(1).max(128),
  t: z.string().regex(/^[0-9a-f]{64}$/),
});

function notFound(): NextResponse {
  return new NextResponse("Not found", { status: 404, headers: NO_STORE });
}

/** A seat on this booking that ended with a cancel or its refund: it may still withdraw its entries. */
async function heldEndedSeat(
  appointmentId: string,
  userId: string,
): Promise<boolean> {
  const seat = await prisma.appointmentParticipant.findFirst({
    where: {
      appointmentId,
      userId,
      role: "CONSULTEE",
      status: { in: ["CANCELLED", "REFUNDED"] },
    },
    select: { id: true },
  });
  return seat !== null;
}

/**
 * What `userId` may download. A paid, unrefunded seat reads the booking's
 * upcoming sessions, confirmed or cancelled. A seat that ended reads only the
 * cancelled ones, as a cancellation. Anyone else reads nothing.
 */
async function attendeeCalendar(appointmentId: string, userId: string) {
  const live = await holdsCalendarSeat(prisma, appointmentId, userId);
  if (!live && !(await heldEndedSeat(appointmentId, userId))) return null;
  const appointment = await prisma.appointment.findFirst({
    where: live
      ? {
          id: appointmentId,
          deletedAt: null,
          participants: { some: calendarSeatWhere(userId) },
        }
      : { id: appointmentId },
    select: {
      appointmentType: true,
      consultation: {
        select: { consultationPlan: { select: { title: true } } },
      },
      subscription: {
        select: { subscriptionPlan: { select: { title: true } } },
      },
      webinar: { select: { webinarPlan: { select: { title: true } } } },
      class: { select: { classPlan: { select: { title: true } } } },
      trial: { select: { subscriptionPlan: { select: { title: true } } } },
      occurrences: {
        select: {
          ordinal: true,
          startsAt: true,
          endsAt: true,
          updatedAt: true,
          isTentative: true,
          completionStatus: true,
          deletedAt: true,
        },
      },
    },
  });
  if (!appointment) return null;
  const upcoming = icsSessions(
    appointmentId,
    calendarOccurrences(appointment.occurrences),
  );
  const sessions = live ? upcoming : upcoming.filter((s) => s.cancelled);
  if (sessions.length === 0) return null;
  const title = planTitleOrSessionLabel(
    appointment.consultation?.consultationPlan?.title ??
      appointment.subscription?.subscriptionPlan?.title ??
      appointment.webinar?.webinarPlan?.title ??
      appointment.class?.classPlan?.title ??
      appointment.trial?.subscriptionPlan?.title,
    appointment.appointmentType,
  );
  return { title, sessions, cancellationOnly: !live };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> },
): Promise<NextResponse> {
  const limited = await applyRateLimit(
    calendarLimiter,
    getClientIp(req),
    "calendar",
  );
  if (limited) return limited;

  const { appointmentId } = await params;
  const query = QuerySchema.safeParse({
    u: req.nextUrl.searchParams.get("u") ?? "",
    t: req.nextUrl.searchParams.get("t") ?? "",
  });
  if (
    !query.success ||
    !verifyCalendarToken(appointmentId, query.data.u, query.data.t)
  ) {
    return notFound();
  }

  const calendar = await attendeeCalendar(appointmentId, query.data.u);
  if (!calendar) return notFound();

  const ics = buildIcs({
    title: calendar.title,
    // A cancellation carries the title and times only: no way back into the booking.
    ...(calendar.cancellationOnly
      ? {}
      : {
          description: calendarDetails(appointmentId),
          url: appointmentDashboardUrl(appointmentId),
        }),
    sessions: calendar.sessions,
    // Times are UTC; naming the attendee's own zone would put their data in a forwardable file.
    zone: "UTC",
  });
  return new NextResponse(ics, {
    status: 200,
    headers: {
      ...NO_STORE,
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'attachment; filename="familiarise-session.ics"',
    },
  });
}
