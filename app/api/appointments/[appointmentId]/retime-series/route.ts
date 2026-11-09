import { NextResponse } from "next/server";
import { z } from "zod";

import { requireApiAuth, resolveEventHostActor } from "@/lib/auth-helpers";
import { applyRateLimit, eventMutationLimiter } from "@/lib/rate-limit";
import { reportSentryError } from "@/lib/observability/report";
import { ConsultantScheduleConflictError } from "@/lib/collaborators/availability";
import { BookingRuleError } from "@/lib/booking/booking-rule-error";
import { bookingRuleResponse } from "@/lib/booking/booking-rule-response";
import { readHostedClass } from "@/lib/booking/class-sessions";
import {
  movableClassSessions,
  retimeClassSeries,
} from "@/lib/booking/class-retime";
import { MAX_ALLOCATION_SLOTS } from "@/schemas/slotAllocation/validationSchemas";

const BodySchema = z.object({
  starts: z.array(z.string().datetime()).min(1).max(MAX_ALLOCATION_SLOTS),
});

type Params = Promise<{ appointmentId: string }>;

/** The plan's host (expert or host-org operator) of the class behind this appointment, or a response. */
async function hostedOrRefusal(appointmentId: string) {
  const auth = await requireApiAuth({ expectUser: true });
  if (auth.error) return { refusal: auth.error } as const;
  const hosted = await readHostedClass(appointmentId);
  if (!hosted.found) {
    return {
      refusal: NextResponse.json({ error: "Class not found" }, { status: 404 }),
    } as const;
  }
  const host = await resolveEventHostActor(auth.session, "class", hosted.cls.id);
  if (host !== "consultant" && host !== "host-org") {
    return {
      refusal: NextResponse.json(
        { error: "Only the class host can move its sessions" },
        { status: 403 },
      ),
    } as const;
  }
  return { session: auth.session, hosted } as const;
}

/**
 * GET — how many upcoming sessions a series move would touch (those at least
 * 24 hours away) and how long each is, so the host's picker asks for exactly
 * that many times.
 */
export async function GET(_request: Request, { params }: { params: Params }) {
  const { appointmentId } = await params;
  const gate = await hostedOrRefusal(appointmentId);
  if ("refusal" in gate) return gate.refusal;
  const movable = await movableClassSessions(appointmentId);
  return NextResponse.json(movable, {
    headers: { "Cache-Control": "private, no-store" },
  });
}

/**
 * POST { starts } — move every class session at least 24 hours away to the
 * given starts, in order. Attendees are told and may leave with a full
 * refund until `retimeBy`; nobody's exit-right count changes.
 */
export async function POST(request: Request, { params }: { params: Params }) {
  const { appointmentId } = await params;
  const gate = await hostedOrRefusal(appointmentId);
  if ("refusal" in gate) return gate.refusal;
  const limited = await applyRateLimit(
    eventMutationLimiter,
    gate.session.user.id,
  );
  if (limited) return limited;

  const body = BodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json(
      { error: "Send the new start times as ISO 8601 strings." },
      { status: 400 },
    );
  }
  try {
    const result = await retimeClassSeries({
      hosted: gate.hosted,
      starts: body.data.starts.map((iso) => new Date(iso)),
      actorUserId: gate.session.user.id,
    });
    return NextResponse.json(result);
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
      op: "class-series-retime",
      extra: { appointmentId },
    });
    return NextResponse.json(
      { error: "Couldn't move the class. Try again in a moment." },
      { status: 500 },
    );
  }
}
