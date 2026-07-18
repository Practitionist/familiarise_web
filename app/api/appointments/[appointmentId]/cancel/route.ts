import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { CancellationReason } from "@prisma/client";
import { notifyAppointmentCancelled } from "@/lib/novu";
import { CancelAppointmentSchema } from "@/schemas/appointments";
import {
  logConsultationCancelled,
  logSubscriptionCancelled,
} from "@/lib/activity/log-activity";

import { getSession } from "@/lib/auth-server";
import { isPrivileged } from "@/lib/auth-helpers";
import { refundPayment } from "@/lib/payments/operations/refund";
import {
  refundWholeEventPayments,
  type WholeEventRefundSummary,
} from "@/lib/payments/operations/event-refunds";
import { hasActiveDisputeForAppointment } from "@/lib/payments/dispute-guard";
import {
  computeRefundPct,
  parsePolicySnapshot,
} from "@/lib/payments/operations/cancellation-policy";
import {
  CANCELLABLE_FROM,
  CLASS_EVENT_ALLOWED_FROM,
  EVENT_ALLOWED_FROM,
} from "@/lib/booking/transitions";
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { appointmentId } = await params;

    // Parse optional request body for cancellation reason
    let validatedData: { reason?: string; notes?: string } = {};
    try {
      const text = await request.text();
      if (text) {
        const parsed = JSON.parse(text);
        const result = CancelAppointmentSchema.safeParse(parsed);
        if (!result.success) {
          return NextResponse.json(
            { error: "Validation failed", details: result.error.issues },
            { status: 400 },
          );
        }
        validatedData = result.data;
      }
    } catch {
      // Body parsing is optional - continue without it
    }

    // Fetch appointment BEFORE transaction to avoid timeout on heavy queries
    const appointment = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: {
        consultation: {
          include: {
            consultationPlan: {
              include: {
                consultantProfile: {
                  include: { user: { select: { id: true, name: true } } },
                },
              },
            },
            requestedBy: {
              include: { user: { select: { id: true, name: true } } },
            },
          },
        },
        subscription: {
          include: {
            subscriptionPlan: {
              include: {
                consultantProfile: {
                  include: { user: { select: { id: true, name: true } } },
                },
              },
            },
            requestedBy: {
              include: { user: { select: { id: true, name: true } } },
            },
          },
        },
        webinar: {
          include: {
            webinarPlan: true,
          },
        },
        class: {
          include: {
            classPlan: true,
          },
        },
        // Earliest slot decides the refund tier — without orderBy the DB
        // returns an arbitrary slot (review catch on #844).
        slotsOfAppointment: {
          take: 1,
          orderBy: { startsAt: "asc" },
          select: { startsAt: true },
        },
        // B1 — refund terms frozen at booking + the payment to refund.
        payment: {
          select: { id: true, amount: true, paymentStatus: true },
        },
      },
    });

    if (!appointment) {
      return NextResponse.json(
        { error: "Appointment not found" },
        { status: 404 },
      );
    }

    // Participant authorization check
    const consultantProfileId = session.user.consultantProfileId;
    const consulteeProfileId = session.user.consulteeProfileId;

    let isParticipant = false;

    if (appointment.consultation) {
      const planConsultantProfileId =
        appointment.consultation.consultationPlan?.consultantProfileId;
      isParticipant =
        consultantProfileId === planConsultantProfileId ||
        consulteeProfileId === appointment.consultation.requestedById;
    } else if (appointment.subscription) {
      const planConsultantProfileId =
        appointment.subscription.subscriptionPlan?.consultantProfileId;
      isParticipant =
        consultantProfileId === planConsultantProfileId ||
        consulteeProfileId === appointment.subscription.requestedById;
    } else if (appointment.webinar) {
      // Only the consultant (organizer) can cancel a group event
      const webinarConsultantId =
        appointment.webinar.webinarPlan?.consultantProfileId;
      isParticipant = consultantProfileId === webinarConsultantId;
    } else if (appointment.class) {
      // Only the consultant (organizer) can cancel a group event
      const classConsultantId =
        appointment.class.classPlan?.consultantProfileId;
      isParticipant = consultantProfileId === classConsultantId;
    }

    const isPrivilegedUser = isPrivileged(session.user.role);

    if (!isParticipant && !isPrivilegedUser) {
      return NextResponse.json(
        { error: "You are not authorized to cancel this appointment" },
        { status: 403 },
      );
    }

    // Extract notification data BEFORE transaction (appointment will be deleted)
    let consultantUserId: string | undefined;
    let consulteeUserId: string | undefined;
    let consultantName: string | undefined;
    let consulteeName: string | undefined;
    let planTitle: string | undefined;
    const appointmentType: string = appointment.appointmentType;
    const dateTime =
      appointment.slotsOfAppointment?.[0]?.startsAt?.toISOString();

    if (appointment.consultation) {
      consultantUserId =
        appointment.consultation.consultationPlan?.consultantProfile?.user?.id;
      consulteeUserId = appointment.consultation.requestedBy?.user?.id;
      consultantName =
        appointment.consultation.consultationPlan?.consultantProfile?.user
          ?.name || undefined;
      consulteeName =
        appointment.consultation.requestedBy?.user?.name || undefined;
      planTitle = appointment.consultation.consultationPlan?.title;
    } else if (appointment.subscription) {
      consultantUserId =
        appointment.subscription.subscriptionPlan?.consultantProfile?.user?.id;
      consulteeUserId = appointment.subscription.requestedBy?.user?.id;
      consultantName =
        appointment.subscription.subscriptionPlan?.consultantProfile?.user
          ?.name || undefined;
      consulteeName =
        appointment.subscription.requestedBy?.user?.name || undefined;
      planTitle = appointment.subscription.subscriptionPlan?.title;
    }

    // #1008 — refuse to cancel while a dispute is live on this appointment: the
    // cancel would fire refunds that double-pay against a gateway chargeback.
    if (await hasActiveDisputeForAppointment(appointmentId)) {
      return NextResponse.json(
        {
          error:
            "This appointment has an open payment dispute and can't be cancelled until it resolves.",
          code: "DISPUTE_ACTIVE",
        },
        { status: 409 },
      );
    }

    // Prepare cancellation data
    const cancellationData = {
      status: "CANCELLED" as const,
      cancellationReason: (validatedData.reason as CancellationReason) || null,
      cancellationNotes: validatedData.notes || null,
      cancelledAt: new Date(),
      cancelledBy: session.user.id,
    };

    // Cancellable from-states: never COMPLETED (history), never CANCELLED
    // (idempotency — a double-cancel must not re-run refunds), never
    // REJECTED/EXPIRED (nothing to cancel). The guard rides the WHERE and is
    // re-evaluated under the row lock (B2/B16 — the #825 CAS doctrine), so a
    // cancel racing the capture webhook resolves to exactly one winner.
    // The set lives in lib/booking/transitions.ts so the map is canonical (#836).

    // Transaction for critical database operations only (with increased timeout)
    const result = await prisma.$transaction(
      async (tx) => {
        // Update appointment status based on type — CAS-guarded.
        let moved = 0;
        if (appointment.consultation) {
          moved = (
            await tx.consultation.updateMany({
              where: {
                id: appointment.consultation.id,
                status: { in: [...CANCELLABLE_FROM] },
              },
              data: cancellationData,
            })
          ).count;
        } else if (appointment.subscription) {
          moved = (
            await tx.subscription.updateMany({
              where: {
                id: appointment.subscription.id,
                status: { in: [...CANCELLABLE_FROM] },
              },
              data: cancellationData,
            })
          ).count;
        } else if (appointment.webinar) {
          // Explicit allowed-from (was notIn) — robust against future enum
          // additions (#837).
          moved = (
            await tx.webinar.updateMany({
              where: {
                id: appointment.webinar.id,
                status: { in: EVENT_ALLOWED_FROM.CANCELLED },
              },
              data: { status: "CANCELLED" },
            })
          ).count;
        } else if (appointment.class) {
          moved = (
            await tx.class.updateMany({
              where: {
                id: appointment.class.id,
                status: { in: CLASS_EVENT_ALLOWED_FROM.CANCELLED },
              },
              data: { status: "CANCELLED" },
            })
          ).count;
        }
        if (moved === 0) {
          throw Object.assign(
            new Error(
              "This appointment can no longer be cancelled (already cancelled, completed, or expired).",
            ),
            { httpStatus: 409, code: "NOT_CANCELLABLE" },
          );
        }

        // Soft-cancel: mark slots as CANCELLED instead of deleting.
        // CRITICAL: Do NOT delete appointments — Payment records have onDelete: Cascade
        // and deleting appointments would permanently destroy payment/refund/dispute audit trail.
        if (appointment.subscription) {
          await tx.slotOfAppointment.updateMany({
            where: {
              appointment: { subscriptionId: appointment.subscription.id },
              completionStatus: "SCHEDULED",
            },
            data: { completionStatus: "CANCELLED" },
          });
        } else if (appointment.class) {
          await tx.slotOfAppointment.updateMany({
            where: {
              appointment: { classId: appointment.class.id },
              completionStatus: "SCHEDULED",
            },
            data: { completionStatus: "CANCELLED" },
          });
        } else {
          // Consultation/webinar/trial — single appointment
          await tx.slotOfAppointment.updateMany({
            where: { appointmentId, completionStatus: "SCHEDULED" },
            data: { completionStatus: "CANCELLED" },
          });
        }

        return {
          success: true,
          cancellationReason: validatedData.reason,
          cancelledAt: cancellationData.cancelledAt,
          webinarId: appointment.webinar?.id,
          classId: appointment.class?.id,
        };
      },
      {
        maxWait: 10000, // Max time to wait for connection
        timeout: 30000, // 30 second transaction timeout (was 5s default)
      },
    );

    // B1 — policy-driven refund, AFTER the cancel tx commits (refundPayment
    // runs its own Serializable tx; the CAS above guarantees this block runs
    // at most once per appointment — a second cancel 409s before reaching it).
    // Scope here: consultation/subscription (single-payment, policy-tiered).
    // Whole-event class/webinar refunds are handled just below via the
    // reversal engine (#776 §C).
    let refund: { amountRefundedPaise: number; refundPct: number } | null =
      null;
    const isExclusiveType =
      !!appointment.consultation || !!appointment.subscription;
    const paidPayment = appointment.payment?.find(
      (p) => p.paymentStatus === "SUCCEEDED" && p.amount > 0,
    );
    if (isExclusiveType && paidPayment) {
      const startsAt = appointment.slotsOfAppointment?.[0]?.startsAt;
      const hoursUntilStart = startsAt
        ? (startsAt.getTime() - Date.now()) / 3_600_000
        : -1;
      const isConsultantInitiated =
        session.user.consultantProfileId !== null &&
        session.user.consultantProfileId !== undefined &&
        session.user.id !== undefined &&
        consultantUserId === session.user.id;
      const refundPct = computeRefundPct(
        parsePolicySnapshot(appointment.cancellationPolicySnapshot),
        hoursUntilStart,
        isConsultantInitiated,
      );
      const refundAmount = Math.floor(
        (Number(paidPayment.amount) * refundPct) / 100,
      );
      if (refundAmount > 0) {
        try {
          const r = await refundPayment({
            paymentId: paidPayment.id,
            amountPaise: refundAmount,
            reason: `cancellation (${refundPct}% per booking-time policy, ${
              isConsultantInitiated ? "consultant" : "consultee"
            }-initiated)`,
            initiatedByUserId: session.user.id,
          });
          refund = { amountRefundedPaise: r.amountRefundedPaise, refundPct };
        } catch (refundErr) {
          // The cancellation itself stands; a failed refund must be visible,
          // not silently swallowed — surface for ops + tell the caller.
          Sentry.captureException(refundErr instanceof Error ? refundErr : new Error(String(refundErr)), { tags: { subsystem: "appointments" } });
          console.error(
            `[cancel] refund failed for payment ${paidPayment.id}:`,
            refundErr,
          );
          refund = { amountRefundedPaise: 0, refundPct };
        }
      } else {
        refund = { amountRefundedPaise: 0, refundPct };
      }
    }

    // #776 §C — whole-event (class/webinar) cancellation refunds every attendee
    // in full through the reversal engine: org-funded seats reverse in-ledger
    // (CLASS_MULTI), card/mock seats credit the gateway. Same at-most-once CAS
    // guarantee as the block above. Attendees didn't leave voluntarily (the
    // event was cancelled on them), so this is a full refund, not policy-tiered.
    let eventRefund: WholeEventRefundSummary | null = null;
    if (appointment.class || appointment.webinar) {
      const eventKind = appointment.class ? "class" : "webinar";
      const eventId = appointment.class?.id ?? appointment.webinar!.id;
      eventRefund = await refundWholeEventPayments(
        eventKind,
        eventId,
        `whole-event ${eventKind} cancellation (${validatedData.reason ?? "cancelled"})`,
        session.user.id,
      );
    }

    // Notification metadata (for fire-and-forget notifications after transaction)
    const notificationMeta = {
      consultantUserId,
      consulteeUserId,
      consultantName,
      consulteeName,
      planTitle,
      appointmentType,
      dateTime,
      cancelledBy: session.user.id,
    };

    // Fire-and-forget: notify both parties about cancellation
    const userIds = [
      notificationMeta.consultantUserId,
      notificationMeta.consulteeUserId,
    ].filter((id): id is string => !!id);
    if (userIds.length > 0) {
      void notifyAppointmentCancelled(userIds, {
        appointmentType: notificationMeta.appointmentType,
        consultantName: notificationMeta.consultantName || "Consultant",
        consulteeName: notificationMeta.consulteeName || "Consultee",
        planTitle: notificationMeta.planTitle || "N/A",
        dateTime: notificationMeta.dateTime,
        dashboardUrl: "/dashboard",
        reason: validatedData.reason || undefined,
        cancelledBy:
          notificationMeta.cancelledBy === notificationMeta.consultantUserId
            ? "consultant"
            : "consultee",
      });
    }

    // Log cancellation activity for consultant dashboard (awaited — DB write
    // that should not be dropped in serverless; logActivity swallows errors)
    const actor = {
      id: session.user.id,
      name: session.user.name || "User",
      image: session.user.image,
    };
    const cancelledBy =
      session.user.id === notificationMeta.consultantUserId
        ? ("consultant" as const)
        : ("consultee" as const);

    if (appointment.consultation) {
      const cpId =
        appointment.consultation.consultationPlan?.consultantProfileId;
      if (cpId) {
        await logConsultationCancelled(
          cpId,
          appointment.consultation.id,
          actor,
          planTitle || "Consultation",
          cancelledBy,
        );
      }
    } else if (appointment.subscription) {
      const cpId =
        appointment.subscription.subscriptionPlan?.consultantProfileId;
      if (cpId) {
        await logSubscriptionCancelled(
          cpId,
          appointment.subscription.id,
          actor,
          planTitle || "Subscription",
          cancelledBy,
        );
      }
    }

    // Note: This route cancels the entire event (sets parent to CANCELLED),
    // so we do NOT notify waitlisted users — there is no "spot" to offer.
    // Waitlist notifications should only fire when a participant leaves an
    // otherwise-active event (handled in participant removal flow).

    return NextResponse.json({ ...result, refund, eventRefund });
  } catch (error) {
    if (error instanceof Error && "httpStatus" in error) {
      const status =
        typeof (error as { httpStatus?: number }).httpStatus === "number"
          ? (error as { httpStatus: number }).httpStatus
          : 500;
      const code =
        "code" in error && typeof (error as { code?: string }).code === "string"
          ? (error as { code: string }).code
          : undefined;
      return NextResponse.json(
        { error: error.message, ...(code && { code }) },
        { status },
      );
    }
    if (error instanceof Error && error.message === "Appointment not found") {
      return NextResponse.json(
        { error: "Appointment not found" },
        { status: 404 },
      );
    }

    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "appointments" } });
    console.error("Error canceling appointment:", error);
    return NextResponse.json(
      { error: "Failed to cancel appointment" },
      { status: 500 },
    );
  }
}
