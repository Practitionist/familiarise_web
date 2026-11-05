import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireApiAuth } from "@/lib/auth-helpers";
import { applyRateLimit, eventMutationLimiter } from "@/lib/rate-limit";
import prisma from "@/lib/prisma";
import { apiError } from "@/lib/errors/api-error";
import { isHostOrgOperatorOf } from "@/lib/booking/cancel-actor";
import {
  REGULAR_TIME_PLAN_SELECT,
  readRegularTimeView,
  setRegularTime,
} from "@/lib/booking/regular-time/service";

const RegularTimeBody = z.object({
  slots: z
    .array(
      z.object({
        weekday: z.number().int().min(1).max(7),
        localStartMinutes: z.number().int().min(0).max(1439),
      }),
    )
    .min(1)
    .max(7),
});

/** The plan behind an appointment id (the wrapper, or the subscription itself). */
async function subscriptionIdOf(appointmentId: string): Promise<string | null> {
  const appointment = await prisma.appointment.findFirst({
    where: {
      deletedAt: null,
      OR: [{ id: appointmentId }, { subscriptionId: appointmentId }],
    },
    select: { subscriptionId: true },
  });
  return appointment?.subscriptionId ?? null;
}

const notFound = () =>
  NextResponse.json(
    { error: "This plan was not found.", code: "NOT_FOUND" },
    { status: 404 },
  );

/**
 * GET /api/appointments/[appointmentId]/regular-time
 *
 * The plan's Regular time and its next four plan weeks (placed sessions and
 * conflicts), for the consultant, a host-org operator, or the client (read-only).
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  try {
    const auth = await requireApiAuth();
    if (auth.error) return auth.error;
    const { session } = auth;
    const subscriptionId = await subscriptionIdOf((await params).appointmentId);
    if (!subscriptionId) return notFound();
    const plan = await prisma.subscription.findUnique({
      where: { id: subscriptionId },
      select: REGULAR_TIME_PLAN_SELECT,
    });
    if (!plan) return notFound();
    const mayRead =
      plan.requestedBy.user.id === session.user.id ||
      session.user.consultantProfileId ===
        plan.subscriptionPlan.consultantProfileId ||
      (await isHostOrgOperatorOf(
        session.user.id,
        plan.subscriptionPlan.organizationId,
      ));
    if (!mayRead) return notFound();
    return NextResponse.json(await readRegularTimeView(plan));
  } catch (error) {
    return apiError({
      tag: "regular-time.get",
      error,
      fallbackMessage: "Couldn't load the regular time. Please try again.",
    });
  }
}

/**
 * PUT /api/appointments/[appointmentId]/regular-time { slots }
 *
 * The consultant (or a host-org operator) sets the plan's weekly times. This
 * week is placed now; the next three fill within the hour. Re-sending the
 * same slots changes nothing.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  try {
    const auth = await requireApiAuth({ expectUser: true });
    if (auth.error) return auth.error;
    const { session } = auth;
    const limited = await applyRateLimit(eventMutationLimiter, session.user.id);
    if (limited) return limited;

    const body = RegularTimeBody.safeParse(
      await request.json().catch(() => null),
    );
    if (!body.success) {
      return NextResponse.json(
        {
          error: "Pick a day and a time for each session.",
          code: "INVALID_REGULAR_TIME",
        },
        { status: 400 },
      );
    }
    const subscriptionId = await subscriptionIdOf((await params).appointmentId);
    if (!subscriptionId) return notFound();

    const outcome = await setRegularTime(
      {
        userId: session.user.id,
        consultantProfileId: session.user.consultantProfileId ?? null,
      },
      subscriptionId,
      body.data.slots,
    );
    if (!outcome.ok) {
      return NextResponse.json(
        { error: outcome.error, code: outcome.code },
        { status: outcome.status },
      );
    }
    return NextResponse.json({
      validFrom: outcome.validFrom.toISOString(),
      slots: outcome.slots,
      placed: outcome.placed,
      replayed: outcome.replayed,
      message: outcome.replayed
        ? "Your regular time is already set."
        : "This week is booked; the next 3 weeks fill within the hour.",
    });
  } catch (error) {
    return apiError({
      tag: "regular-time.put",
      error,
      fallbackMessage:
        "Couldn't save the regular time. Check it, then try again.",
    });
  }
}
