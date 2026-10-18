import { NextRequest, NextResponse } from "next/server";

import { requireApiAuth } from "@/lib/auth-helpers";
import { applyRateLimit, eventMutationLimiter } from "@/lib/rate-limit";
import { withIdempotency } from "@/lib/api/idempotency";
import { reportSentryError } from "@/lib/observability/report";
import { BookingRuleError } from "@/lib/booking/booking-rule-error";
import { bookingRuleResponse } from "@/lib/booking/booking-rule-response";
import { rebookIncidentRemedy } from "@/lib/booking/incident-rebook";
import { IncidentRebookSchema } from "@/schemas/appointments";
import {
  AppointmentBusyError,
  BookingLockUnavailableError,
  ConsulteeBookingBusyError,
} from "@/utils/appointmentlock";
import { SlotLockError } from "@/utils/errors/SlotLockError";

/**
 * POST — the learner rebooks an outage-voided 1:1 free with the same expert.
 * A repeated `Idempotency-Key` replays the first answer.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ remedyId: string }> },
) {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;
  const { session } = auth;
  const limited = await applyRateLimit(eventMutationLimiter, session.user.id);
  if (limited) return limited;
  const { remedyId } = await params;

  return await withIdempotency(
    request,
    {
      scope: `booking.incident-rebook:${remedyId}`,
      userId: session.user.id,
    },
    async (body) => {
      const parsed = IncidentRebookSchema.safeParse(body ?? {});
      if (!parsed.success) {
        return NextResponse.json(
          { error: "Invalid request", details: parsed.error.flatten() },
          { status: 400 },
        );
      }
      try {
        const result = await rebookIncidentRemedy({
          remedyId,
          userId: session.user.id,
          startsAt: new Date(parsed.data.startsAt),
        });
        return NextResponse.json(result);
      } catch (error) {
        if (error instanceof BookingRuleError) {
          return bookingRuleResponse(error);
        }
        if (
          error instanceof BookingLockUnavailableError ||
          error instanceof AppointmentBusyError ||
          error instanceof ConsulteeBookingBusyError
        ) {
          return NextResponse.json(
            { error: error.message, code: error.code },
            { status: error.httpStatus },
          );
        }
        if (error instanceof SlotLockError) {
          return NextResponse.json(
            {
              error:
                "Someone is booking that time right now. Try again shortly.",
              code: "SLOT_LOCKED",
            },
            { status: 409 },
          );
        }
        reportSentryError(error, {
          subsystem: "bookings",
          op: "incident-rebook",
          extra: { remedyId },
        });
        return NextResponse.json(
          { error: "Something went wrong — please try again." },
          { status: 500 },
        );
      }
    },
  );
}
