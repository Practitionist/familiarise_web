import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
import prisma from "@/lib/prisma";
import { apiError } from "@/lib/errors";
import { withdrawRescheduleRequest } from "@/lib/booking/reschedule-withdraw";
import { RESCHEDULE_OPEN_STATUSES } from "@/lib/booking/transitions";

/**
 * POST /api/appointments/[appointmentId]/reschedule/withdraw
 *
 * The initiator takes back their own open reschedule. The other party has
 * Decline, which ends the same request with a different meaning: a withdrawal
 * restores the booking, a decline leaves the slots released for the consultant
 * to re-place.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  try {
    const { appointmentId } = await params;
    const session = await getSession(true);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Found via the appointment rather than by request id: the caller is acting
    // on a booking they can see, and openForAppointmentId already guarantees at
    // most one live reschedule per appointment, so there is nothing to choose
    // between.
    const open = await prisma.rescheduleRequest.findFirst({
      where: {
        appointmentId,
        status: { in: RESCHEDULE_OPEN_STATUSES },
      },
      select: { id: true, initiatedById: true },
    });

    if (!open) {
      return NextResponse.json(
        { error: "No open reschedule request for this booking." },
        { status: 404 },
      );
    }

    // Authorization is identity, not role: whoever opened it may take it back,
    // whichever side of the booking they are on.
    if (open.initiatedById !== session.user.id) {
      return NextResponse.json(
        {
          error:
            "Only the person who requested this reschedule can withdraw it.",
          code: "NOT_INITIATOR",
        },
        { status: 403 },
      );
    }

    const result = await withdrawRescheduleRequest({
      rescheduleRequestId: open.id,
      withdrawnById: session.user.id,
    });

    if (!result.withdrawn) {
      // PROPOSAL_NOT_OPEN means the other party answered while this request was
      // in flight — a 409, not a failure of the caller's input.
      return NextResponse.json(
        { error: "This reschedule can no longer be withdrawn.", code: result.reason },
        { status: result.reason === "NOT_INITIATOR" ? 403 : 409 },
      );
    }

    return NextResponse.json({
      withdrawn: true,
      message: "Your reschedule request has been withdrawn.",
    });
  } catch (error) {
    return apiError({ tag: "[Reschedule.Withdraw]", error });
  }
}
