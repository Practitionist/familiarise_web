import { NextResponse } from "next/server";
import { z } from "zod";

import { requireApiAuth } from "@/lib/auth-helpers";
import { applyRateLimit, eventMutationLimiter } from "@/lib/rate-limit";
import {
  joinEventWaitlist,
  leaveEventWaitlist,
  listEventWaitlist,
} from "@/lib/booking/event-waitlist";
import { EventWaitlistListResponseSchema } from "@/schemas/interest";
import { BookingRuleError } from "@/lib/booking/booking-rule-error";
import { bookingRuleResponse } from "@/lib/booking/booking-rule-response";
import { reportSentryError } from "@/lib/observability/report";
import { apiError } from "@/lib/errors/api-error";
import { isRefusal } from "@/lib/errors/refusal";

/**
 * "Notify me" on a sold-out webinar or class. POST joins (idempotent), DELETE
 * leaves, GET lists the caller's open rows; nothing here reserves a seat.
 */

const BodySchema = z.object({
  kind: z.enum(["WEBINAR", "CLASS"]),
  eventId: z.string().min(1).max(64),
});

const NO_STORE = { "Cache-Control": "no-store" };

function answer(error: unknown, op: string) {
  if (error instanceof BookingRuleError) return bookingRuleResponse(error);
  if (isRefusal(error)) return apiError({ tag: `[${op}]`, error });
  reportSentryError(error, { subsystem: "bookings", op });
  return NextResponse.json(
    { error: "Something went wrong — please try again." },
    { status: 500, headers: NO_STORE },
  );
}

async function parse(request: Request) {
  const body = BodySchema.safeParse(await request.json().catch(() => null));
  if (body.success) return { data: body.data };
  return {
    error: NextResponse.json(
      { error: "Invalid event", details: body.error.issues },
      { status: 400, headers: NO_STORE },
    ),
  };
}

export async function POST(request: Request) {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;
  const userId = auth.session.user.id;
  const limited = await applyRateLimit(eventMutationLimiter, userId);
  if (limited) return limited;
  const body = await parse(request);
  if (body.error) return body.error;
  try {
    const row = await joinEventWaitlist({
      userId,
      viewerConsultantProfileId: auth.session.user.consultantProfileId ?? null,
      session: auth.session,
      kind: body.data.kind,
      eventId: body.data.eventId,
    });
    return NextResponse.json({ data: row }, { headers: NO_STORE });
  } catch (error) {
    return answer(error, "event-waitlist-join");
  }
}

export async function DELETE(request: Request) {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;
  const userId = auth.session.user.id;
  const limited = await applyRateLimit(eventMutationLimiter, userId);
  if (limited) return limited;
  const body = await parse(request);
  if (body.error) return body.error;
  try {
    const left = await leaveEventWaitlist(
      userId,
      body.data.kind,
      body.data.eventId,
    );
    return NextResponse.json({ left: left > 0 }, { headers: NO_STORE });
  } catch (error) {
    return answer(error, "event-waitlist-leave");
  }
}

export async function GET() {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;
  try {
    const rows = await listEventWaitlist(auth.session.user.id);
    const body = EventWaitlistListResponseSchema.parse({
      data: rows.map((row) => ({
        ...row,
        nextSessionAt: row.nextSessionAt?.toISOString() ?? null,
        notifiedAt: row.notifiedAt?.toISOString() ?? null,
      })),
    });
    return NextResponse.json(body, { headers: NO_STORE });
  } catch (error) {
    return answer(error, "event-waitlist-list");
  }
}
