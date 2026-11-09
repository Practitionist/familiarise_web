import { NextRequest, NextResponse } from "next/server";

import { BookingRuleError } from "@/lib/booking/booking-rule-error";
import { bookingRuleResponse } from "@/lib/booking/booking-rule-response";
import { removeParticipantForConduct } from "@/lib/booking/participant-removal";
import { guardMeetingRoute } from "@/lib/meetings/route-guard";
import { isOneToManyAppointmentType } from "@/lib/meetings/room-ready";
import { reportSentryError } from "@/lib/observability/report";
import { meetingStageLimiter } from "@/lib/rate-limit";
import { streamLogger } from "@/lib/stream-logger";
import { ConductRemovalBodySchema } from "@/schemas/participant-removal";

/**
 * POST /api/meetings/[meetingId]/remove
 * A host or accepted co-host removes an attendee from a live webinar or class
 * for conduct. The seat is released and recorded, support reviews it, and
 * Stream drops the attendee from the call and chat (see
 * lib/booking/participant-removal.ts). Organisation operators use the roster.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ meetingId: string }> },
) {
  try {
    const guard = await guardMeetingRoute(
      params,
      "remove from",
      meetingStageLimiter,
    );
    if (!guard.ok) return guard.response;
    const { userId, meetingId, access } = guard;

    if (access.role !== "host") {
      streamLogger.warn("Attendee removal refused — caller is not the host", {
        userId,
        meetingId,
        role: access.role,
      });
      return NextResponse.json(
        {
          error: "Only a host or co-host can remove attendees from a session.",
          reason: "not_host",
        },
        { status: 403 },
      );
    }

    const appointment = access.appointment;
    const appointmentType =
      appointment?.appointmentType ??
      (appointment?.webinar ? "WEBINAR" : appointment?.class ? "CLASS" : null);
    if (
      !appointment?.id ||
      !appointmentType ||
      !isOneToManyAppointmentType(appointmentType)
    ) {
      return NextResponse.json(
        {
          error: "Attendees can only be removed from webinar and class rooms.",
        },
        { status: 400 },
      );
    }

    const parsed = ConductRemovalBodySchema.safeParse(
      await req.json().catch(() => null),
    );
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid removal request.", details: parsed.error.issues },
        { status: 400 },
      );
    }
    const { targetUserId, reason, note } = parsed.data;
    if (targetUserId === userId) {
      return NextResponse.json(
        { error: "You cannot remove yourself. Leave the session instead." },
        { status: 400 },
      );
    }

    const removed = await removeParticipantForConduct({
      appointmentId: appointment.id,
      targetUserId,
      actor: { userId, role: access.coPresenter ? "CO_HOST" : "HOST" },
      reason,
      note,
    }).catch((error: unknown) => {
      if (error instanceof BookingRuleError) return error;
      throw error;
    });
    if (removed instanceof BookingRuleError)
      return bookingRuleResponse(removed);
    if (!removed) return NextResponse.json({ removed: false });
    return NextResponse.json({
      removed: true,
      caseReference: removed.caseReference,
      earningsHeld: removed.earningsHeld,
    });
  } catch (error) {
    reportSentryError(error, {
      subsystem: "stream",
      op: "meetings.removeAttendee",
    });
    streamLogger.error("Failed to remove attendee", error);
    return NextResponse.json(
      { error: "Could not remove the attendee. Please try again." },
      { status: 500 },
    );
  }
}
