import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";

import { isPrivileged } from "@/lib/auth-helpers";
import { getSession } from "@/lib/auth-server";
import {
  bookingAppointmentFilter,
  resolveBookingRefundContext,
} from "@/lib/booking/cancellation-scope";
import { isOrgAdminOfAppointment } from "@/lib/booking/org-actor";
import {
  computeRefundPct,
  parsePolicySnapshot,
} from "@/lib/payments/operations/cancellation-policy";
import prisma from "@/lib/prisma";

/**
 * What cancelling this booking right now would pay back — computed, never
 * written.
 *
 * The confirmation dialog said "any refund follows the booking's cancellation
 * policy", which is true and useless: the number is knowable before the click,
 * and someone deciding whether to cancel is deciding about that number.
 *
 * Every input is the sibling POST route's own: the same context builder, the
 * same tier function, the same linear proration and the same clamp to the
 * refundable balance. Restating any of that here would let the quote and the
 * charge drift.
 *
 * TODO(#1174): `lib/booking/org-actor` is replicated from
 * fix/reschedule-cancel-lifecycle, which introduces it for the POST route.
 * Drop this note once the two have converged on one copy.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { appointmentId } = await params;

    const appointment = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      select: {
        id: true,
        organizationId: true,
        consultationId: true,
        subscriptionId: true,
        webinarId: true,
        classId: true,
        consultation: {
          select: {
            requestedById: true,
            requestedBy: { select: { userId: true } },
            consultationPlan: {
              select: {
                consultantProfileId: true,
                consultantProfile: { select: { userId: true } },
              },
            },
          },
        },
        subscription: {
          select: {
            requestedById: true,
            requestedBy: { select: { userId: true } },
            subscriptionPlan: {
              select: {
                consultantProfileId: true,
                consultantProfile: { select: { userId: true } },
              },
            },
          },
        },
        webinar: {
          select: {
            webinarPlan: {
              select: {
                consultantProfileId: true,
                consultantProfile: { select: { userId: true } },
              },
            },
          },
        },
        class: {
          select: {
            classPlan: {
              select: {
                consultantProfileId: true,
                consultantProfile: { select: { userId: true } },
              },
            },
          },
        },
      },
    });

    if (!appointment) {
      return NextResponse.json(
        { error: "Appointment not found" },
        { status: 404 },
      );
    }

    // Authorization mirrors the POST route exactly. A preview that answers
    // where the cancel would 403 is a quote for an action the viewer cannot
    // take — worse than no quote. Trials are absent from both for the same
    // reason: the POST route has no trial branch, so they fall through to the
    // privileged/org-admin checks here too.
    const actorConsultantProfileId = session.user.consultantProfileId;
    const actorConsulteeProfileId = session.user.consulteeProfileId;

    let isParticipant = false;
    let consultantUserId: string | null = null;
    let consulteeUserId: string | null = null;

    if (appointment.consultation) {
      const plan = appointment.consultation.consultationPlan;
      consultantUserId = plan?.consultantProfile?.userId ?? null;
      consulteeUserId = appointment.consultation.requestedBy?.userId ?? null;
      isParticipant =
        (!!actorConsultantProfileId &&
          actorConsultantProfileId === plan?.consultantProfileId) ||
        (!!actorConsulteeProfileId &&
          actorConsulteeProfileId === appointment.consultation.requestedById);
    } else if (appointment.subscription) {
      const plan = appointment.subscription.subscriptionPlan;
      consultantUserId = plan?.consultantProfile?.userId ?? null;
      consulteeUserId = appointment.subscription.requestedBy?.userId ?? null;
      isParticipant =
        (!!actorConsultantProfileId &&
          actorConsultantProfileId === plan?.consultantProfileId) ||
        (!!actorConsulteeProfileId &&
          actorConsulteeProfileId === appointment.subscription.requestedById);
    } else if (appointment.webinar) {
      const plan = appointment.webinar.webinarPlan;
      consultantUserId = plan?.consultantProfile?.userId ?? null;
      isParticipant =
        !!actorConsultantProfileId &&
        actorConsultantProfileId === plan?.consultantProfileId;
    } else if (appointment.class) {
      const plan = appointment.class.classPlan;
      consultantUserId = plan?.consultantProfile?.userId ?? null;
      isParticipant =
        !!actorConsultantProfileId &&
        actorConsultantProfileId === plan?.consultantProfileId;
    }

    const isPrivilegedUser = isPrivileged(session.user.role);
    const isOrgAdminActor =
      !isParticipant &&
      !isPrivilegedUser &&
      (await isOrgAdminOfAppointment(
        session.user.id,
        appointment.organizationId,
      ));

    if (!isParticipant && !isPrivilegedUser && !isOrgAdminActor) {
      return NextResponse.json(
        { error: "You are not authorized to cancel this appointment" },
        { status: 403 },
      );
    }

    const bookingRef = {
      appointmentId: appointment.id,
      consultationId: appointment.consultationId,
      subscriptionId: appointment.subscriptionId,
      classId: appointment.classId,
      webinarId: appointment.webinarId,
    };
    // On a group event every attendee's payment and seat hang off the same
    // appointment, so the estimate has to be scoped to the viewer's own.
    const isGroupEvent = !!appointment.webinarId || !!appointment.classId;
    const ctx = await resolveBookingRefundContext(
      bookingRef,
      isGroupEvent ? session.user.id : undefined,
    );

    // The context deliberately ignores zero-amount payments, so a booking paid
    // entirely in referral credits reads as unpaid there. Its `free_` intent is
    // the only signal that value was exchanged at all (#1161).
    const bookingPayment = await prisma.payment.findFirst({
      where: {
        appointment: bookingAppointmentFilter(bookingRef),
        paymentStatus: "SUCCEEDED",
        deletedAt: null,
        ...(isGroupEvent ? { userId: session.user.id } : {}),
      },
      orderBy: { createdAt: "asc" },
      select: { currency: true, paymentIntent: true },
    });

    const isConsultantInitiated =
      (!!actorConsultantProfileId && consultantUserId === session.user.id) ||
      (isPrivilegedUser && session.user.id !== consulteeUserId);

    // A booking that was never scheduled has no session to give notice on, so
    // it sits in the top tier rather than the "already started" floor.
    const neverScheduled = ctx.slotsTotal === 0;
    // Cancelling a group event refunds every seat in full
    // (`refundWholeEventPayments`) — the notice tiers never run there.
    const refundPct = isGroupEvent
      ? 100
      : computeRefundPct(
          parsePolicySnapshot(ctx.policySnapshot),
          neverScheduled
            ? Number.POSITIVE_INFINITY
            : (ctx.hoursUntilNextSession ?? -1),
          isConsultantInitiated,
        );

    const grossPaise = ctx.paidPayment?.amountPaise ?? 0;
    const totalSessions = ctx.sessionsCompleted + ctx.sessionsRemaining;
    // #1006 — the refundable base is the undelivered share of the plan price.
    const isProratable = !!appointment.subscriptionId && totalSessions > 0;
    const proratedBasePaise = isProratable
      ? Math.floor((grossPaise * ctx.sessionsRemaining) / totalSessions)
      : grossPaise;
    const estimatedRefundPaise = ctx.paidPayment
      ? Math.min(
          Math.floor((proratedBasePaise * refundPct) / 100),
          ctx.paidPayment.refundablePaise,
        )
      : 0;

    return NextResponse.json({
      refundPct,
      estimatedRefundPaise,
      currency: bookingPayment?.currency ?? "INR",
      hoursUntilNextSession: ctx.hoursUntilNextSession,
      // Only true when proration actually moves the number — an untouched
      // subscription refunds off the whole price, like every other booking.
      prorated: isProratable && ctx.sessionsCompleted > 0,
      creditFunded: bookingPayment?.paymentIntent.startsWith("free_") ?? false,
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
    return NextResponse.json(
      { error: "Could not estimate the refund" },
      { status: 500 },
    );
  }
}
