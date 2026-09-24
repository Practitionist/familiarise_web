import { NextResponse } from "next/server";

import { isPrivileged, requireApiAuth } from "@/lib/auth-helpers";
import { applyRateLimit, eventMutationLimiter } from "@/lib/rate-limit";
import { reportSentryError } from "@/lib/observability/report";
import { BookingRuleError } from "./booking-rule-error";
import { bookingRuleResponse } from "./booking-rule-response";
import {
  readHostedClass,
  type ClassActor,
  type HostedClass,
} from "./class-sessions";

type Params = Promise<{ appointmentId: string; occurrenceId: string }>;

export interface ClassSessionContext {
  actor: ClassActor;
  appointmentId: string;
  occurrenceId: string;
}

/**
 * #1780 row 4 — the shared shell of the per-session class routes: auth, the
 * mutation limiter, the typed refusals as 409s, and (for host actions) the
 * host-of-the-plan check. The handler answers the happy path.
 */
export async function classSessionRoute(
  params: Params,
  opts: { hostOnly: boolean; op: string },
  handler: (
    ctx: ClassSessionContext,
    hosted: HostedClass,
  ) => Promise<NextResponse>,
): Promise<NextResponse> {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;
  const { session } = auth;
  const limited = await applyRateLimit(eventMutationLimiter, session.user.id);
  if (limited) return limited;

  const { appointmentId, occurrenceId } = await params;
  const actor: ClassActor = {
    userId: session.user.id,
    consultantProfileId: session.user.consultantProfileId ?? null,
    isPrivileged: isPrivileged(session.user.role),
  };
  try {
    const hosted = await readHostedClass(appointmentId, actor);
    if (!hosted.found) {
      return NextResponse.json({ error: "Class not found" }, { status: 404 });
    }
    if (opts.hostOnly && !hosted.isHost) {
      return NextResponse.json(
        { error: "Only the class host can do this" },
        { status: 403 },
      );
    }
    return await handler({ actor, appointmentId, occurrenceId }, hosted);
  } catch (error) {
    if (error instanceof BookingRuleError) return bookingRuleResponse(error);
    reportSentryError(error, {
      subsystem: "bookings",
      op: opts.op,
      extra: { appointmentId, occurrenceId },
    });
    return NextResponse.json(
      { error: "Something went wrong — please try again." },
      { status: 500 },
    );
  }
}
