import { NextResponse } from "next/server";

import { requireApiAuth, resolveEventHostActor } from "@/lib/auth-helpers";
import { applyRateLimit, eventMutationLimiter } from "@/lib/rate-limit";
import { reportSentryError } from "@/lib/observability/report";
import { ConsultantScheduleConflictError } from "@/lib/collaborators/availability";
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
  const auth = await requireApiAuth({ expectUser: true });
  if (auth.error) return auth.error;
  const { session } = auth;
  const limited = await applyRateLimit(eventMutationLimiter, session.user.id);
  if (limited) return limited;

  const { appointmentId, occurrenceId } = await params;
  const actor: ClassActor = {
    userId: session.user.id,
    consultantProfileId: session.user.consultantProfileId ?? null,
  };
  try {
    const hosted = await readHostedClass(appointmentId);
    if (!hosted.found) {
      return NextResponse.json(
        { error: "Class not found", code: "NOT_FOUND" },
        { status: 404 },
      );
    }
    if (opts.hostOnly) {
      // The same host side as cancel and reschedule: the plan's expert or an
      // operator of its host org.
      const host = await resolveEventHostActor(session, "class", hosted.cls.id);
      if (host === "staff") {
        return NextResponse.json(
          {
            error: "Do this from the back office so the change is audited.",
            code: "PLATFORM_CLASS_DOOR_REQUIRED",
          },
          { status: 403 },
        );
      }
      if (host !== "consultant" && host !== "host-org") {
        return NextResponse.json(
          { error: "Only the class host can do this", code: "FORBIDDEN" },
          { status: 403 },
        );
      }
    }
    return await handler({ actor, appointmentId, occurrenceId }, hosted);
  } catch (error) {
    if (error instanceof BookingRuleError) return bookingRuleResponse(error);
    if (error instanceof ConsultantScheduleConflictError) {
      return NextResponse.json(
        { error: error.message, code: "SCHEDULE_CONFLICT" },
        { status: 409 },
      );
    }
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
