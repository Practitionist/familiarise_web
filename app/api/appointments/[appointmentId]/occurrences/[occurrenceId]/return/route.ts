import { NextRequest, NextResponse } from "next/server";

import { requireApiAuth } from "@/lib/auth-helpers";
import { applyRateLimit, eventMutationLimiter } from "@/lib/rate-limit";
import { withIdempotency } from "@/lib/api/idempotency";
import { reportSentryError } from "@/lib/observability/report";
import { BookingRuleError } from "@/lib/booking/booking-rule-error";
import { bookingRuleResponse } from "@/lib/booking/booking-rule-response";
import {
  returnSessionToPlan,
  SessionReturnForbiddenError,
  SessionReturnNotFoundError,
} from "@/lib/booking/session-return";
import { SessionReturnSchema } from "@/schemas/appointments";
import {
  AppointmentBusyError,
  BookingLockUnavailableError,
} from "@/utils/appointmentlock";

/**
 * POST — the consultee returns one live subscription session to the plan
 * (D8/D9). A repeated `Idempotency-Key` replays the first answer.
 */
export async function POST(
  request: NextRequest,
  {
    params,
  }: { params: Promise<{ appointmentId: string; occurrenceId: string }> },
) {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;
  const { session } = auth;
  const limited = await applyRateLimit(eventMutationLimiter, session.user.id);
  if (limited) return limited;
  const { appointmentId, occurrenceId } = await params;

  return await withIdempotency(
    request,
    { scope: "booking.session-return", userId: session.user.id },
    async (body) => {
      const parsed = SessionReturnSchema.safeParse(body ?? {});
      if (!parsed.success) {
        return NextResponse.json(
          { error: "Invalid request", details: parsed.error.flatten() },
          { status: 400 },
        );
      }
      try {
        const result = await returnSessionToPlan({
          appointmentId,
          occurrenceId,
          actorUserId: session.user.id,
          consulteeProfileId: session.user.consulteeProfileId ?? null,
        });
        return NextResponse.json(result);
      } catch (error) {
        if (error instanceof BookingRuleError) {
          return bookingRuleResponse(error);
        }
        if (error instanceof SessionReturnForbiddenError) {
          return NextResponse.json({ error: error.message }, { status: 403 });
        }
        if (error instanceof SessionReturnNotFoundError) {
          return NextResponse.json({ error: error.message }, { status: 404 });
        }
        if (
          error instanceof BookingLockUnavailableError ||
          error instanceof AppointmentBusyError
        ) {
          return NextResponse.json(
            { error: error.message, code: error.code },
            { status: error.httpStatus },
          );
        }
        reportSentryError(error, {
          subsystem: "bookings",
          op: "session-return",
          extra: { appointmentId, occurrenceId },
        });
        return NextResponse.json(
          { error: "Something went wrong — please try again." },
          { status: 500 },
        );
      }
    },
  );
}
