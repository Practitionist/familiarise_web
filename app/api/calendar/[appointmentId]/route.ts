// A signed, session-less .ics: every refusal is the same 404, and the file carries only the
// title, the times and the dashboard link, never the video link or attendee details.

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
import { buildIcs } from "@/lib/appointments/ics";
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

/** The booking's upcoming confirmed sessions, or null unless `userId` holds a paid, unrefunded seat on it. */
async function attendeeCalendar(appointmentId: string, userId: string) {
  if (!(await holdsCalendarSeat(prisma, appointmentId, userId))) return null;
  const appointment = await prisma.appointment.findFirst({
    where: {
      id: appointmentId,
      deletedAt: null,
      participants: { some: calendarSeatWhere(userId) },
    },
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
        where: {
          deletedAt: null,
          isTentative: false,
          completionStatus: "SCHEDULED",
          startsAt: { gt: new Date() },
        },
        orderBy: { startsAt: "asc" },
        select: { id: true, startsAt: true, endsAt: true },
      },
    },
  });
  if (!appointment || appointment.occurrences.length === 0) return null;
  const title = planTitleOrSessionLabel(
    appointment.consultation?.consultationPlan?.title ??
      appointment.subscription?.subscriptionPlan?.title ??
      appointment.webinar?.webinarPlan?.title ??
      appointment.class?.classPlan?.title ??
      appointment.trial?.subscriptionPlan?.title,
    appointment.appointmentType,
  );
  return { title, sessions: appointment.occurrences };
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
    description: calendarDetails(appointmentId),
    url: appointmentDashboardUrl(appointmentId),
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
