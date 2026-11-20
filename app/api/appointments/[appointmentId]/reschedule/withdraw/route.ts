import { NextRequest, NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/auth-helpers";
import {
  applyRateLimit,
  eventMutationLimiter,
  rescheduleAppointmentLimiter,
} from "@/lib/rate-limit";
import prisma from "@/lib/prisma";
import { apiError } from "@/lib/errors";
import {
  rescheduleWithdrawAuthority,
  WITHDRAW_AUTHORITY_SELECT,
  withdrawRescheduleRequest,
} from "@/lib/booking/reschedule-withdraw";
import { membershipSuspendedResponse } from "@/lib/enterprise/suspended-member-sessions";
import { RESCHEDULE_OPEN_STATUSES } from "@/lib/booking/transitions";
import {
  AppointmentBusyError,
  BookingLockUnavailableError,
} from "@/utils/appointmentlock";

/** The answer for a caller who once could withdraw this move and no longer can. */
function lostAuthorityResponse(
  refusal: "NOT_FOUND" | "NO_LONGER_A_PARTY" | "MEMBERSHIP_SUSPENDED",
): NextResponse {
  // A suspended learner on an org-funded booking moves nothing, as on open and respond.
  if (refusal === "MEMBERSHIP_SUSPENDED") return membershipSuspendedResponse();
  // The initiator still has to act for the side they opened it from, as on
  // the respond route; an expert removed from the host org has lost that.
  return NextResponse.json(
    {
      error:
        "You no longer act for this booking, so you can't withdraw its reschedule.",
      code: "NO_LONGER_A_PARTY",
    },
    { status: 403 },
  );
}

/**
 * POST /api/appointments/[appointmentId]/reschedule/withdraw
 *
 * The initiator takes back their own open reschedule. The other party has
 * Decline, which ends the same request the same way — both restore the released
 * sessions, so the booking ends up where it started either way. What differs is
 * who may do it and what a refusal means: the initiator may withdraw, as may
 * anyone acting for the same side when an organisation actor opened the move
 * (the learner for a sponsor admin's, the expert for a host-org operator's),
 * and a withdrawal blocked because the original time was taken is a 409 that
 * leaves the proposal OPEN to be answered, not a settled request.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  try {
    const { appointmentId } = await params;
    // #1583 D-P0-02 — fresh, ban-aware read; 401 / 403 / 503 shapes are the helper's.
    const authResult = await requireApiAuth({ expectUser: true });
    if (authResult.error) return authResult.error;
    const { session } = authResult;
    // Same budget as the sibling reschedule route: both move slots and money.
    const limited = await applyRateLimit(eventMutationLimiter, session.user.id);
    if (limited) return limited;
    const apptLimited = await applyRateLimit(
      rescheduleAppointmentLimiter,
      `${session.user.id}:${appointmentId}`,
    );
    if (apptLimited) return apptLimited;

    // Found via the appointment rather than by request id: the caller is acting
    // on a booking they can see, and openForAppointmentId already guarantees at
    // most one live reschedule per appointment — including the preference-only
    // rows added in #1065, which claim the reservation for exactly this reason —
    // so there is nothing to choose between. The ordering is belt-and-braces
    // against that invariant ever lapsing: newest is the one the user means.
    const open = await prisma.rescheduleRequest.findFirst({
      where: {
        appointmentId,
        status: { in: RESCHEDULE_OPEN_STATUSES },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, ...WITHDRAW_AUTHORITY_SELECT },
    });

    const authority = open
      ? await rescheduleWithdrawAuthority(open, session)
      : null;

    // "No open request" and "an open request this caller may not withdraw"
    // answer with the SAME 404, deliberately. This route never checks that the
    // caller can see the appointment at all, so distinguishing them would let
    // any signed-in user walk appointment ids and learn which bookings have a
    // live reschedule and whose it is. A 403 here is a membership oracle for
    // other people's bookings.
    if (
      !open ||
      !authority ||
      (!authority.allowed && authority.refusal === "NOT_FOUND")
    ) {
      return NextResponse.json(
        { error: "No open reschedule request for this booking." },
        { status: 404 },
      );
    }

    if (!authority.allowed) return lostAuthorityResponse(authority.refusal);

    const result = await withdrawRescheduleRequest({
      rescheduleRequestId: open.id,
      withdrawnById: session.user.id,
      sameSideActor: authority.sameSideActor,
    });

    if (!result.withdrawn) {
      // PROPOSAL_NOT_OPEN means the other party answered while this request was
      // in flight — a 409, not a failure of the caller's input. NOT_INITIATOR
      // cannot reach here (the guard above already 404s), but the service is
      // callable from elsewhere, so it keeps its own answer.
      // ORIGINAL_TIME_TAKEN (#1846 SM-B15) is also a 409: the proposal stays
      // open, and agreeing a new time is the way forward.
      return NextResponse.json(
        {
          error:
            result.reason === "ORIGINAL_TIME_TAKEN"
              ? "The original time has since been booked, so this reschedule can't be withdrawn. Agree a new time instead."
              : "This reschedule can no longer be withdrawn.",
          code: result.reason,
        },
        { status: result.reason === "NOT_INITIATOR" ? 404 : 409 },
      );
    }

    return NextResponse.json({
      withdrawn: true,
      message: authority.sameSideActor
        ? "The request to move this booking has been withdrawn, so it keeps its original time."
        : "Your reschedule request has been withdrawn.",
    });
  } catch (error) {
    // #1583 A-P0-04 — the withdraw now serialises on the appointment atom;
    // lock outcomes are structured answers (423 / 503), as in respond.
    if (
      error instanceof AppointmentBusyError ||
      error instanceof BookingLockUnavailableError
    ) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.httpStatus },
      );
    }
    return apiError({ tag: "[Reschedule.Withdraw]", error });
  }
}
