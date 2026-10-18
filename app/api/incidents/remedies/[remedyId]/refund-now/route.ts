import { NextRequest, NextResponse } from "next/server";

import { requireApiAuth } from "@/lib/auth-helpers";
import { applyRateLimit, eventMutationLimiter } from "@/lib/rate-limit";
import { scheduleAfter } from "@/lib/api/after-safe";
import { reportSentryError } from "@/lib/observability/report";
import { BookingRuleError } from "@/lib/booking/booking-rule-error";
import { bookingRuleResponse } from "@/lib/booking/booking-rule-response";
import { bringIncidentRefundForward } from "@/lib/booking/incident-rebook";
import { CronLockHeldError } from "@/lib/cron/with-cron-lock";
import { getMaintenanceState } from "@/lib/maintenance";
import { IncidentRefundNowSchema } from "@/schemas/appointments";
import { settlePlatformIncidentForOne } from "@/scripts/appointments/settle-platform-incidents";

/**
 * POST — the learner takes the 100 % refund now instead of waiting for dueAt.
 * Idempotent: the remedy's dueAt moves once, and the settle run issues the refund.
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

  const raw = await request.text();
  let body: unknown = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = IncidentRefundNowSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const result = await bringIncidentRefundForward({
      remedyId,
      userId: session.user.id,
    });
    if (!result.refunded) {
      // A settle run already in flight, or the next one after maintenance, picks it up.
      await scheduleAfter(async () => {
        const { phase } = await getMaintenanceState();
        if (phase === "DEGRADED" || phase === "OFFLINE") return;
        try {
          await settlePlatformIncidentForOne(result.incidentId);
        } catch (error) {
          if (!(error instanceof CronLockHeldError)) throw error;
        }
      }, "incident-refund-now.settle");
    }
    return NextResponse.json({
      dueAt: result.dueAt,
      refunded: result.refunded,
    });
  } catch (error) {
    if (error instanceof BookingRuleError) {
      return bookingRuleResponse(error);
    }
    reportSentryError(error, {
      subsystem: "bookings",
      op: "incident-refund-now",
      extra: { remedyId },
    });
    return NextResponse.json(
      { error: "Something went wrong — please try again." },
      { status: 500 },
    );
  }
}
