import { AppointmentsType } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";

import { requireApiAuth } from "@/lib/auth-helpers";
import { applyRateLimit, eventMutationLimiter } from "@/lib/rate-limit";
import {
  listBackupInterest,
  registerBackupInterest,
  withdrawBackupInterest,
} from "@/lib/booking/backup-interest";
import { BookingRuleError } from "@/lib/booking/booking-rule-error";
import { bookingRuleResponse } from "@/lib/booking/booking-rule-response";
import { reportSentryError } from "@/lib/observability/report";

/**
 * #1778 — "Notify me if this time opens". POST registers (idempotent on the
 * window, three at most), DELETE withdraws one, GET lists the caller's own.
 * Consultee only; nothing here reserves a time.
 */

const RegisterSchema = z.object({
  consultantProfileId: z.string().min(1).max(64),
  windowStart: z.string().datetime(),
  windowEnd: z.string().datetime(),
  planKind: z.enum([
    AppointmentsType.CONSULTATION,
    AppointmentsType.SUBSCRIPTION,
  ]),
  planId: z.string().min(1).max(64).nullable().optional(),
});

const NO_STORE = { "Cache-Control": "no-store" };

async function consultee() {
  const auth = await requireApiAuth();
  if (auth.error) return { error: auth.error };
  if (!auth.session.user.consulteeProfileId) {
    return {
      error: NextResponse.json(
        { error: "Only a learner can wait on a time" },
        { status: 403 },
      ),
    };
  }
  return { userId: auth.session.user.id };
}

function answer(error: unknown, op: string) {
  if (error instanceof BookingRuleError) return bookingRuleResponse(error);
  reportSentryError(error, { subsystem: "bookings", op });
  return NextResponse.json(
    { error: "Something went wrong — please try again." },
    { status: 500 },
  );
}

export async function POST(request: Request) {
  const who = await consultee();
  if (who.error) return who.error;
  const limited = await applyRateLimit(eventMutationLimiter, who.userId);
  if (limited) return limited;
  const body = RegisterSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json(
      { error: "Invalid window", details: body.error.issues },
      { status: 400 },
    );
  }
  try {
    const row = await registerBackupInterest({
      userId: who.userId,
      consultantProfileId: body.data.consultantProfileId,
      windowStart: new Date(body.data.windowStart),
      windowEnd: new Date(body.data.windowEnd),
      planKind: body.data.planKind,
      planId: body.data.planId,
    });
    return NextResponse.json({ data: row });
  } catch (error) {
    return answer(error, "backup-interest-register");
  }
}

export async function DELETE(request: Request) {
  const who = await consultee();
  if (who.error) return who.error;
  const id = new URL(request.url).searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }
  try {
    const moved = await withdrawBackupInterest(who.userId, id);
    return NextResponse.json({ withdrawn: moved.count > 0 });
  } catch (error) {
    return answer(error, "backup-interest-withdraw");
  }
}

export async function GET() {
  const who = await consultee();
  if (who.error) return who.error;
  try {
    return NextResponse.json(
      { data: await listBackupInterest(who.userId) },
      { headers: NO_STORE },
    );
  } catch (error) {
    return answer(error, "backup-interest-list");
  }
}
