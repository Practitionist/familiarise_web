import { NextRequest, NextResponse } from "next/server";

import { requireApiAuth } from "@/lib/auth-helpers";
import { abandonBooking } from "@/lib/booking/abandon";
import { apiError } from "@/lib/errors";
import { applyRateLimit, eventMutationLimiter } from "@/lib/rate-limit";
import {
  AppointmentBusyError,
  BookingLockUnavailableError,
} from "@/utils/appointmentlock";

const REFUSALS = {
  NOT_FOUND: {
    status: 404,
    error: "No unpaid booking of yours was found here.",
  },
  NOT_ABANDONABLE: {
    status: 409,
    error: "This booking has already moved on and can no longer be abandoned.",
  },
  ALREADY_PAID: {
    status: 409,
    error:
      "This booking is already paid for, so cancelling it goes through Cancel, which quotes your refund.",
  },
} as const;

/**
 * POST /api/bookings/[bookingId]/abandon
 *
 * #1527 decision 11 — the buyer walks away from a booking they have not paid
 * for: a consultation or subscription request, a trial, or a webinar or class
 * seat hold. `bookingId` is the Appointment id every booking surface already
 * carries. The dispatch, the money predicate and the slot release live in
 * `lib/booking/abandon.ts`; this route only authenticates and answers.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ bookingId: string }> },
) {
  try {
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;
    const { session } = authResult;
    // The same throttle as cancel: this path reaches the gateway.
    const limited = await applyRateLimit(eventMutationLimiter, session.user.id);
    if (limited) return limited;

    const { bookingId } = await params;
    const result = await abandonBooking({
      appointmentId: bookingId,
      userId: session.user.id,
    });

    if (!result.ok) {
      const refusal = REFUSALS[result.code];
      return NextResponse.json(
        { error: refusal.error, code: result.code },
        { status: refusal.status },
      );
    }

    return NextResponse.json({
      abandoned: true,
      kind: result.kind,
      paymentsExpired: result.paymentsExpired,
      slotsReleased: result.slotsReleased,
    });
  } catch (error) {
    // The appointment atom is held or Redis is down: structured 423 / 503, as
    // on every other lifecycle route.
    if (
      error instanceof AppointmentBusyError ||
      error instanceof BookingLockUnavailableError
    ) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.httpStatus },
      );
    }
    return apiError({ tag: "[Booking.Abandon]", error });
  }
}
