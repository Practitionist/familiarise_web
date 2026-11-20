import { NextRequest, NextResponse } from "next/server";

import { requireApiAuth } from "@/lib/auth-helpers";
import { closeOrderForRequestAgain } from "@/lib/booking/request-again";
import {
  REQUEST_AGAIN_ALREADY_PAID,
  RequestAgainParamsSchema,
  type RequestAgainRefusal,
} from "@/lib/booking/request-again-rules";
import { apiError } from "@/lib/errors";
import { applyRateLimit, eventMutationLimiter } from "@/lib/rate-limit";
import {
  AppointmentBusyError,
  BookingLockUnavailableError,
} from "@/utils/appointmentlock";

const REFUSALS: Record<RequestAgainRefusal, { status: number; error: string }> =
  {
    NOT_FOUND: { status: 404, error: "No booking of yours was found here." },
    ALREADY_PAID: { status: 409, error: REQUEST_AGAIN_ALREADY_PAID },
    PAY_WINDOW_OPEN: {
      status: 409,
      error:
        "Your payment link for this booking is still open. Pay it, or cancel the booking, before requesting again.",
    },
    NOT_CLOSABLE: {
      status: 409,
      error:
        "This booking changed while you were on the page. Reload it to see where it stands.",
    },
  };

/**
 * POST /api/bookings/[bookingId]/request-again
 *
 * Closes the caller's order that is still PENDING after its pay window closed,
 * before "Request again" starts a new request. `bookingId` is the Appointment
 * id; the transaction lives in `lib/booking/request-again.ts`.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ bookingId: string }> },
) {
  try {
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;
    const { session } = authResult;
    // The same throttle as abandon: this path reaches the gateway.
    const limited = await applyRateLimit(eventMutationLimiter, session.user.id);
    if (limited) return limited;

    const parsed = RequestAgainParamsSchema.safeParse(await params);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "This booking link is not valid.", code: "INVALID_BOOKING" },
        { status: 400 },
      );
    }

    const result = await closeOrderForRequestAgain({
      appointmentId: parsed.data.bookingId,
      userId: session.user.id,
    });
    if (!result.ok) {
      const refusal = REFUSALS[result.code];
      return NextResponse.json(
        { error: refusal.error, code: result.code },
        { status: refusal.status },
      );
    }
    return NextResponse.json({ closed: result.closed });
  } catch (error) {
    if (
      error instanceof AppointmentBusyError ||
      error instanceof BookingLockUnavailableError
    ) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.httpStatus },
      );
    }
    return apiError({ tag: "[Booking.RequestAgain]", error });
  }
}
