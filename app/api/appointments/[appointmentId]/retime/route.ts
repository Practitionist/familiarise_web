import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireApiAuth, resolveEventHostActor } from "@/lib/auth-helpers";
import { applyRateLimit, eventMutationLimiter } from "@/lib/rate-limit";
import prisma from "@/lib/prisma";
import { BookingRuleError } from "@/lib/booking/booking-rule-error";
import { bookingRuleResponse } from "@/lib/booking/booking-rule-response";
import { retimeWebinar } from "@/lib/booking/event-retime";
import {
  AppointmentBusyError,
  BookingLockUnavailableError,
} from "@/utils/appointmentlock";
import { ConsultantScheduleConflictError } from "@/lib/collaborators/availability";
import { apiError } from "@/lib/errors/api-error";

const RetimeSchema = z.object({
  startsAt: z.string().datetime({ offset: true }),
});

/**
 * POST /api/appointments/[appointmentId]/retime { startsAt }
 *
 * The host (or a host-org operator) moves a published webinar to a new date in
 * one step. Attendees are told, and those who bought before the move may leave
 * with a full refund until the event's `retimeBy`.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  try {
    const auth = await requireApiAuth({ expectUser: true });
    if (auth.error) return auth.error;
    const { session } = auth;
    const limited = await applyRateLimit(eventMutationLimiter, session.user.id);
    if (limited) return limited;

    const { appointmentId } = await params;
    const body = RetimeSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return NextResponse.json(
        { error: "Pick the new date and time.", code: "INVALID_RETIME" },
        { status: 400 },
      );
    }

    const appointment = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      select: { webinarId: true },
    });
    const host = appointment?.webinarId
      ? await resolveEventHostActor(session, "webinar", appointment.webinarId)
      : null;
    if (host === "staff") {
      return NextResponse.json(
        {
          error:
            "Only the webinar's host can move it to a new date. From the back office you can cancel it instead, and everyone is refunded in full.",
          code: "RETIME_HOST_ONLY",
        },
        { status: 403 },
      );
    }
    if (host !== "consultant" && host !== "host-org") {
      return NextResponse.json(
        {
          error: "Only the webinar's host can re-time it.",
          code: "RETIME_HOST_ONLY",
        },
        { status: 404 },
      );
    }
    // One seat's payment dispute never freezes the webinar for every seat.
    const result = await retimeWebinar({
      appointmentId,
      startsAt: new Date(body.data.startsAt),
      actorUserId: session.user.id,
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof BookingRuleError) return bookingRuleResponse(error);
    if (
      error instanceof AppointmentBusyError ||
      error instanceof BookingLockUnavailableError
    ) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.httpStatus },
      );
    }
    if (error instanceof ConsultantScheduleConflictError) {
      return NextResponse.json(
        { error: error.message, code: "SCHEDULE_CONFLICT" },
        { status: 409 },
      );
    }
    return apiError({ tag: "[Appointment.Retime]", error });
  }
}
