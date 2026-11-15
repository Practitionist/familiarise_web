import { readJsonBody } from "@/lib/api/parse";
import {
  PROFILE_WITH_USER_SELECT,
  isStaffNonParty,
  publicRequester,
} from "@/lib/booking/list-selects";
import { applyRateLimit, eventMutationLimiter } from "@/lib/rate-limit";

import prisma from "@/lib/prisma";
import { stampTrialEarningsHold } from "@/lib/trials/earnings-hold";
import { stageTrialRefundedBell } from "@/lib/trials/refund-bell";
import {
  needsTrialPayLinkRemint,
  remintTrialPayLink,
} from "@/lib/trials/pay-link";
import {
  assertTrialQuoteConfirmed,
  quoteTrialRefund,
  trialCancelWindowRefusal,
  refundCancelledTrial,
  softCancelTrialAppointment,
  softCancelTrialAppointmentInTx,
  trialRefundOwed,
  TrialRefundQuoteError,
  type TrialRefundOutcome,
} from "@/lib/trials/cancellation";
import {
  heldMarkerRefusal,
  recordRefundNeedsSupport,
  stampRefundOwed,
  type RefundOwedMarker,
} from "@/lib/payments/operations/refund-owed";
import { TrialStatus, Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import {
  BookingLockUnavailableError,
  AppointmentBusyError,
  withAppointmentLock,
} from "@/utils/appointmentlock";
import { transitionTrial } from "@/lib/booking/transitions";
import { declineOpenReschedules } from "@/lib/booking/reschedule-decline";
import {
  cancelGatewayOrders,
  expirePendingPaymentsInTx,
  type GatewayCancel,
} from "@/lib/booking/pending-payment-expiry";
import { LIVE_SLOT_WHERE } from "@/lib/booking/cancellation-scope";
import { recordExpertStrike } from "@/lib/booking/expert-reliability";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import { isRefusal } from "@/lib/errors/refusal";
import { stageTrialCompletedNotices } from "@/lib/booking/trial-completed-notice";
import type { RequiredOverride } from "@/lib/notifications/required-notices";
import type { PreparedSpecEmails } from "@/lib/email/senders/shared";
import {
  prepareTrialCancelNotice,
  stageTrialCancelNotice,
  type TrialCancelNotice,
} from "@/lib/trials/cancel-notice";
import { TrialCancelBodySchema, UpdateTrialSchema } from "@/schemas/trials";
import { requireApiAuth, isPrivileged } from "@/lib/auth-helpers";
import { platformCancelDoorRefusal } from "@/lib/booking/platform-cancel";
import { consultantPublicScalars } from "@/lib/data/consultant-public";
import { flushNotificationsAfter } from "@/lib/novu/stage-then-attempt";
import { reportSentryError } from "@/lib/observability/report";
import { goHref } from "@/lib/dashboard/go";

interface RouteContext {
  params: Promise<{ trialId: string }>;
}

/**
 * GET /api/trials/[trialId]
 * Get a specific trial session
 */

/**
 * A trial the expert or staff cancelled reaches everyone else whatever their
 * switches say; the learner's own cancel stays switchable.
 */
function trialCancelOverride(
  isLearner: boolean,
  isExpert: boolean,
  isPrivilegedUser: boolean,
  recipients: string[],
): RequiredOverride | undefined {
  if (isLearner) return undefined;
  const kind = isExpert
    ? ("CANCELLED_BY_HOST" as const)
    : isPrivilegedUser
      ? ("CANCELLED_BY_STAFF" as const)
      : null;
  return kind && recipients.length > 0 ? { kind, recipients } : undefined;
}
export async function GET(request: NextRequest, context: RouteContext) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  const { trialId } = await context.params;

  try {
    const trial = await prisma.trial.findUnique({
      where: {
        id: trialId,
        ...(isPrivileged(session.user.role)
          ? {}
          : {
              OR: [
                {
                  consulteeProfileId:
                    session.user.consulteeProfileId ?? "__none__",
                },
                {
                  consultantProfileId:
                    session.user.consultantProfileId ?? "__none__",
                },
              ],
            }),
      },
      include: {
        consulteeProfile: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                image: true,
              },
            },
          },
        },
        consultantProfile: {
          select: {
            ...consultantPublicScalars,
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                image: true,
              },
            },
          },
        },
        subscriptionPlan: true,
        appointment: {
          include: {
            occurrences: {
              include: {
                meeting: true,
              },
            },
          },
        },
        convertedToSubscription: true,
      },
    });

    if (!trial) {
      return NextResponse.json(
        { error: "Trial session not found" },
        { status: 404 },
      );
    }

    // #1589 T-P1-02 — a lost link is re-minted on the consultee's own read
    // while the pay window is open, so "unavailable" is no longer terminal.
    if (
      trial.consulteeProfile.userId === session.user.id &&
      needsTrialPayLinkRemint(trial)
    ) {
      trial.pendingPaymentUrl = await remintTrialPayLink({
        ...trial,
        appointment: trial.appointment
          ? {
              id: trial.appointment.id,
              occurrences: trial.appointment.occurrences.map((o) => ({
                startsAt: o.startsAt,
                endsAt: o.endsAt,
              })),
            }
          : null,
      });
    }

    const isParty =
      trial.consulteeProfileId === session.user.consulteeProfileId ||
      trial.consultantProfileId === session.user.consultantProfileId;
    const data = isStaffNonParty(session.user.role, isParty)
      ? { ...trial, consulteeProfile: publicRequester(trial.consulteeProfile) }
      : trial;
    return NextResponse.json({ data });
  } catch (error) {
    console.error("Error fetching trial session:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching trial session" },
      { status: 500 },
    );
  }
}

/**
 * PATCH /api/trials/[trialId]
 * Update a trial: notes, cancel an unpaid one, complete or convert.
 */
export async function PATCH(request: NextRequest, context: RouteContext) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;
  // This PATCH reaches the cancel and conversion writes, so it is throttled.
  const limited = await applyRateLimit(eventMutationLimiter, session.user.id);
  if (limited) return limited;

  const { trialId } = await context.params;

  try {
    const read = await readJsonBody(request);
    if (read.error) return read.error;
    const body = read.body;
    const parseResult = UpdateTrialSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parseResult.error.issues },
        { status: 400 },
      );
    }
    const { status, notes, subscriptionId } = parseResult.data;

    // Fetch the existing trial session
    const existingTrial = await prisma.trial.findUnique({
      where: {
        id: trialId,
        ...(isPrivileged(session.user.role)
          ? {}
          : {
              OR: [
                {
                  consulteeProfileId:
                    session.user.consulteeProfileId ?? "__none__",
                },
                {
                  consultantProfileId:
                    session.user.consultantProfileId ?? "__none__",
                },
              ],
            }),
      },
      include: {
        consulteeProfile: {
          include: {
            user: { select: { id: true, name: true, image: true } },
          },
        },
        consultantProfile: {
          select: { id: true, user: { select: { id: true, name: true } } },
        },
        subscriptionPlan: true,
        appointment: true,
      },
    });

    if (!existingTrial) {
      return NextResponse.json(
        { error: "Trial session not found" },
        { status: 404 },
      );
    }

    const updateData: Prisma.TrialUpdateInput = {};

    // #1319 — status-dependent activity logs and notifications run only after

    // the CAS commits; a raced cancel or webhook must not leave a record of a

    // transition that never happened.

    const afterCommit: Array<() => unknown> = [];
    let cancelNotice: {
      notice: TrialCancelNotice;
      pre: PreparedSpecEmails | null;
    } | null = null;
    // A holder, not a `let`: the transaction callback assigns it.
    const cancelStaged: {
      current: Awaited<ReturnType<typeof stageTrialCancelNotice>> | null;
    } = { current: null };

    // Set when this PATCH cancels an unpaid trial; the appointment retirement
    // runs after the status write commits.
    let deferredCancellation: {
      appointmentId: string | null;
      paymentId: string | null;
      isConsultantInitiated: boolean;
    } | null = null;

    if (notes !== undefined) {
      updateData.notes = notes;
    }

    // Handle status transitions
    if (status) {
      // The doors this PATCH offers; the CAS in TRIAL_ALLOWED_FROM is the state
      // machine. Only the capture webhook confirms a trial awaiting payment.
      const validTransitions: Record<TrialStatus, TrialStatus[]> = {
        AWAITING_PAYMENT: ["CANCELLED"],
        SCHEDULED: ["COMPLETED", "CANCELLED"],
        COMPLETED: ["CONVERTED"],
        CONVERTED: [],
        CANCELLED: [],
      };

      const currentStatus = existingTrial.status;
      if (!validTransitions[currentStatus]?.includes(status)) {
        return NextResponse.json(
          { error: `Cannot transition from ${currentStatus} to ${status}` },
          { status: 400 },
        );
      }

      // Role-based transition guards
      const isTrialConsultant =
        session.user.consultantProfileId === existingTrial.consultantProfileId;
      const isTrialConsultee =
        session.user.consulteeProfileId === existingTrial.consulteeProfileId;
      const isPrivilegedUser = isPrivileged(session.user.role);

      if (!isTrialConsultant && !isTrialConsultee && !isPrivilegedUser) {
        return NextResponse.json(
          { error: "Not a participant of this trial" },
          { status: 403 },
        );
      }

      // An operator who is not a party moves no trial through this route.
      const doorRefusal = platformCancelDoorRefusal(request, {
        privileged: isPrivilegedUser,
        party: isTrialConsultant || isTrialConsultee,
      });
      if (doorRefusal) return doorRefusal;

      // Consultee can only cancel their trials
      if (isTrialConsultee && !isTrialConsultant && !isPrivilegedUser) {
        if (status !== TrialStatus.CANCELLED) {
          return NextResponse.json(
            { error: "Consultees can only cancel trial sessions" },
            { status: 403 },
          );
        }
      }

      // CONVERTED requires consultant or privileged
      if (
        status === TrialStatus.CONVERTED &&
        !isTrialConsultant &&
        !isPrivilegedUser
      ) {
        return NextResponse.json(
          { error: "Only the consultant can convert a trial" },
          { status: 403 },
        );
      }

      // A confirmed trial ends only through DELETE, the door that owns the
      // cancel window, the quoted refund, the strike and open reschedules.
      if (
        status === TrialStatus.CANCELLED &&
        currentStatus === TrialStatus.SCHEDULED
      ) {
        return NextResponse.json(
          {
            error:
              "Cancel a scheduled trial from its cancel dialog, which shows the refund first.",
            code: "USE_CANCEL_ENDPOINT",
          },
          { status: 409 },
        );
      }

      // #1846 — a paid trial's cancel shows its refund quote first, and only
      // the quoted DELETE refunds, so this PATCH refuses to cancel one.
      if (status === TrialStatus.CANCELLED) {
        const windowRefusal = await trialCancelWindowRefusal(
          existingTrial.appointmentId,
        );
        if (windowRefusal) {
          return NextResponse.json(
            { error: windowRefusal.userMessage, code: windowRefusal.code },
            { status: windowRefusal.httpStatus },
          );
        }
        const quote = await quoteTrialRefund({
          appointmentId: existingTrial.appointmentId,
          paymentId: existingTrial.paymentId,
          isConsultantInitiated: !isTrialConsultee,
        });
        if (quote) {
          return NextResponse.json(
            {
              error:
                "This trial was paid for. Cancel it from the cancel dialog, which shows the refund first.",
              code: "REFUND_QUOTE_REQUIRED",
              quote,
            },
            { status: 409 },
          );
        }
      }

      updateData.status = status;

      // Handle completion
      if (status === TrialStatus.COMPLETED) {
        updateData.completedAt = new Date();

        // The learner hears "Continue with {expert}"; the expert gets a bell only.
        afterCommit.push(async () => {
          const staged = await stageTrialCompletedNotices({
            trialId,
            consultantUserId: existingTrial.consultantProfile.user.id,
            consulteeUserId: existingTrial.consulteeProfile.user.id,
            consultantName:
              existingTrial.consultantProfile.user.name || "Consultant",
            consulteeName: existingTrial.consulteeProfile.user.name || "User",
            planTitle: existingTrial.subscriptionPlan.title,
            subscriptionPlanId: existingTrial.subscriptionPlan.id,
            dashboardUrl: goHref("auto", "appointments"),
          });
          await flushNotificationsAfter(
            {
              bells: staged.bells,
              emails: [{ list: staged.emails, emailType: "TRIAL_COMPLETED" }],
            },
            "trial.completed",
          );
        });
      }

      // Handle cancellation
      if (status === TrialStatus.CANCELLED) {
        const userIds = [
          existingTrial.consultantProfile.user.id,
          existingTrial.consulteeProfile.user.id,
        ].filter((id) => id !== session.user.id);
        const notice: TrialCancelNotice = {
          trialId,
          userIds,
          required: trialCancelOverride(
            isTrialConsultee,
            isTrialConsultant,
            isPrivilegedUser,
            userIds,
          ),
          consultantName:
            existingTrial.consultantProfile.user.name || "Consultant",
          consulteeName: existingTrial.consulteeProfile.user.name || "User",
          planTitle: existingTrial.subscriptionPlan.title,
          dashboardUrl: goHref("auto", "appointments"),
        };
        cancelNotice = { notice, pre: await prepareTrialCancelNotice(notice) };

        // #1009 — soft-cancel, never delete. This used to hard-delete the
        // appointment to free availability (FIX #579), which cascade-deleted the
        // payment along with it once paid trials shipped. The slot is released by
        // the status transition alone (see occupancyPolicy), which is what the
        // hourly expiry job has always relied on, so the appointment can stay for
        // audit and the money rows survive.
        //
        // Deferred until after the status write commits: refundPayment runs its
        // own Serializable transaction, and a gateway failure must not roll back
        // the cancellation.
        deferredCancellation = {
          appointmentId: existingTrial.appointmentId,
          paymentId: existingTrial.paymentId,
          // The consultee is the only non-privileged actor the guards let through.
          isConsultantInitiated: !isTrialConsultee,
        };
      }

      // Handle trial conversion — requires a linked subscription
      if (status === TrialStatus.CONVERTED) {
        if (!subscriptionId) {
          return NextResponse.json(
            {
              error:
                "subscriptionId is required when converting a trial to a subscription",
            },
            { status: 400 },
          );
        }

        // Validate the subscription exists and belongs to the same plan/consultee
        const subscription = await prisma.subscription.findUnique({
          where: { id: subscriptionId },
          select: {
            id: true,
            subscriptionPlanId: true,
            requestedById: true,
            status: true,
          },
        });

        if (!subscription) {
          return NextResponse.json(
            { error: "Subscription not found" },
            { status: 404 },
          );
        }

        if (
          subscription.subscriptionPlanId !== existingTrial.subscriptionPlanId
        ) {
          return NextResponse.json(
            {
              error: "Subscription must belong to the same plan as the trial",
            },
            { status: 400 },
          );
        }

        if (subscription.requestedById !== existingTrial.consulteeProfileId) {
          return NextResponse.json(
            {
              error:
                "Subscription must belong to the same consultee as the trial",
            },
            { status: 400 },
          );
        }

        if (
          subscription.status &&
          !["APPROVED", "COMPLETED"].includes(subscription.status)
        ) {
          return NextResponse.json(
            {
              error:
                "Subscription must be approved or active before converting a trial",
            },
            { status: 400 },
          );
        }

        // Link the subscription to the trial
        updateData.convertedToSubscription = {
          connect: { id: subscriptionId },
        };
      }
    }

    // Update the trial session (status + any other fields)
    // #1319 — the status moves through the CAS helper inside the same tx as
    // the other fields, so a raced webhook/sweep matches zero rows and the
    // whole PATCH rolls back instead of clobbering it. The app-level
    // validTransitions check above is only the friendly error text.
    const { status: nextStatus, ...restUpdate } = updateData;
    let subscriptionBecameInactive = false;
    let gatewayCancels: GatewayCancel[] = [];
    const updatedTrial = await prisma.$transaction(async (tx) => {
      if (
        nextStatus === TrialStatus.CONVERTED &&
        subscriptionId &&
        typeof tx.subscription?.findUnique === "function"
      ) {
        const currentSub = await tx.subscription.findUnique({
          where: { id: subscriptionId },
          select: { status: true, deletedAt: true },
        });
        if (
          !currentSub ||
          currentSub.deletedAt ||
          (currentSub.status &&
            !["APPROVED", "COMPLETED"].includes(currentSub.status))
        ) {
          subscriptionBecameInactive = true;
          return null;
        }
      }
      // An ending trial's unpaid order dies before the status move, in the
      // capture's lock order (payment → trial); a captured payment stays.
      if (deferredCancellation?.appointmentId) {
        ({ gatewayCancels } = await expirePendingPaymentsInTx(tx, {
          appointmentId: deferredCancellation.appointmentId,
          reason: "trial ended before payment",
        }));
      }
      if (nextStatus !== undefined) {
        await transitionTrial(tx, {
          where: { id: trialId },
          to: nextStatus as TrialStatus,
          // #1846 — this PATCH cancels only an unpaid trial (a paid one needs
          // the quoted DELETE). The status it read and "still unpaid" ride the
          // CAS, so a capture that commits first makes this a 409, and one
          // that lands after is the webhook's capture-after-release refund.
          ...(nextStatus === TrialStatus.CANCELLED
            ? {
                fromIn: [existingTrial.status],
                whereAnd: { paymentId: null },
              }
            : {}),
        });
      }
      // The cancel notices commit with the cancel; a staging failure rolls it back.
      if (nextStatus === TrialStatus.CANCELLED && cancelNotice) {
        cancelStaged.current = await stageTrialCancelNotice(
          tx,
          cancelNotice.notice,
          cancelNotice.pre,
        );
      }
      // #1775 C-9 — delivery starts the paid trial's earnings hold.
      if (nextStatus === TrialStatus.COMPLETED) {
        await stampTrialEarningsHold(
          tx,
          existingTrial.paymentId,
          updateData.completedAt as Date,
        );
      }
      return tx.trial.update({
        where: { id: trialId },
        data: restUpdate,
        include: {
          consulteeProfile: {
            include: {
              user: {
                select: {
                  id: true,
                  name: true,
                  email: true,
                  image: true,
                },
              },
            },
          },
          consultantProfile: {
            select: {
              ...consultantPublicScalars,
              user: {
                select: {
                  id: true,
                  name: true,
                  email: true,
                  image: true,
                },
              },
            },
          },
          subscriptionPlan: true,
          appointment: {
            include: {
              occurrences: {
                include: {
                  meeting: true,
                },
              },
            },
          },
          convertedToSubscription: true,
        },
      });
    });
    if (subscriptionBecameInactive || !updatedTrial) {
      return NextResponse.json(
        {
          error:
            "Subscription must be approved or active before converting a trial",
        },
        { status: 400 },
      );
    }
    // #1654 — awaited: an un-awaited trigger is dropped when the instance
    // freezes after the response; each effect still fails on its own.
    for (const effect of afterCommit) {
      try {
        await effect();
      } catch (err) {
        console.error("[trial] post-commit effect failed", trialId, err);
      }
    }
    if (cancelStaged.current) {
      await flushNotificationsAfter(
        {
          bells: cancelStaged.current.bells,
          emails: [
            { list: cancelStaged.current.emails, emailType: "TRIAL_CANCELLED" },
          ],
        },
        "trial.cancelled",
      );
    }

    // #1009 — the trial has left SCHEDULED/AWAITING_PAYMENT, so its slot is
    // already free. Retire the appointment and settle the money.
    let refund: TrialRefundOutcome | null = null;
    if (deferredCancellation) {
      if (deferredCancellation.appointmentId) {
        await softCancelTrialAppointment(deferredCancellation.appointmentId);
        await cancelGatewayOrders(gatewayCancels, {
          op: "trial.patch.gateway-cancel",
          appointmentId: deferredCancellation.appointmentId,
        });
      }
      refund = await refundCancelledTrial({
        trialId,
        initiatedByUserId: session.user.id,
        quote: null,
        owed: null,
      });
    }

    return NextResponse.json({
      data: updatedTrial,
      ...(refund ? { refund } : {}),
    });
  } catch (error) {
    // #1319 — the DB CAS refused the move (stale tab, raced webhook/sweep).
    if (error instanceof IllegalTransitionError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.httpStatus },
      );
    }
    if (isRefusal(error)) {
      await recordRefundNeedsSupport(error);
      return NextResponse.json(
        { error: error.userMessage, code: error.code },
        { status: error.httpStatus },
      );
    }
    console.error("Error updating trial session:", error);
    // The refund above runs after the trial writes commit, so a failure here
    // can leave a cancelled-but-unrefunded trial — alert on it (#1125).
    reportSentryError(error, {
      subsystem: "trials",
      op: "PATCH /api/trials/[trialId]",
      expected: false,
      extra: { trialId },
    });
    return NextResponse.json(
      { error: "An error occurred while updating trial session" },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/trials/[trialId]
 * Cancel a trial session
 */
export async function DELETE(request: NextRequest, context: RouteContext) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;
  // #1319 — the same throttle as PATCH: this path reaches the refund gateway.
  const limited = await applyRateLimit(eventMutationLimiter, session.user.id);
  if (limited) return limited;

  const { trialId } = await context.params;

  try {
    const existingTrial = await prisma.trial.findUnique({
      where: {
        id: trialId,
        ...(isPrivileged(session.user.role)
          ? {}
          : {
              OR: [
                {
                  consulteeProfileId:
                    session.user.consulteeProfileId ?? "__none__",
                },
                {
                  consultantProfileId:
                    session.user.consultantProfileId ?? "__none__",
                },
              ],
            }),
      },
      include: {
        consultantProfile: PROFILE_WITH_USER_SELECT,
        consulteeProfile: {
          include: { user: { select: { id: true, name: true } } },
        },
        subscriptionPlan: { select: { title: true } },
      },
    });

    if (!existingTrial) {
      return NextResponse.json(
        { error: "Trial session not found" },
        { status: 404 },
      );
    }

    // A cancel refunds the learner, so an operator who is not a party has no door here.
    const doorRefusal = platformCancelDoorRefusal(request, {
      privileged: isPrivileged(session.user.role),
      party:
        session.user.consulteeProfileId === existingTrial.consulteeProfileId ||
        session.user.consultantProfileId === existingTrial.consultantProfileId,
    });
    if (doorRefusal) return doorRefusal;

    // A trial holding its time awaiting payment, or a confirmed one, can be cancelled.
    const cancellableStatuses: TrialStatus[] = [
      TrialStatus.AWAITING_PAYMENT,
      TrialStatus.SCHEDULED,
    ];

    if (!cancellableStatuses.includes(existingTrial.status)) {
      return NextResponse.json(
        { error: `Cannot cancel a trial in ${existingTrial.status} status` },
        { status: 400 },
      );
    }

    // #1009 — same soft-cancel as the PATCH path. CANCELLED drops the trial out
    // of the occupancy filter, which is what frees the slot; the appointment is
    // tombstoned rather than deleted so the payment it carries survives.
    //
    // #1846 SM-D2 / SM-D5 — the status move and the tombstone commit in ONE
    // transaction on its own client (they were a global-client CAS and a
    // second transaction, so a crash between them left a CANCELLED trial with
    // a live session), under the appointment lock every other lifecycle
    // writer takes. A trial with no appointment yet has no atom to lock; its
    // CAS alone decides.
    //
    // The CAS narrows to the status the caller saw, so a trial captured or
    // moved since the read 409s instead of being cancelled on a stale view,
    // and the tombstone and refund read the committed row, not the pre-read.
    const lockId = existingTrial.appointmentId;
    // Anyone but the learner cancels on the consultant's side, so the learner
    // is refunded in full (`consultantInitiatedPct`). Only the trial's own
    // expert cancelling a confirmed trial earns a strike; an operator does not.
    const isConsultantInitiated =
      session.user.consulteeProfileId !== existingTrial.consulteeProfileId;
    const isTrialExpert =
      session.user.consultantProfileId === existingTrial.consultantProfileId;
    const isLearner = !isConsultantInitiated;
    const staffCancel =
      isPrivileged(session.user.role) && !isTrialExpert && !isLearner;
    const cancelSide = staffCancel
      ? "staff"
      : isConsultantInitiated
        ? "consultant"
        : "consultee";
    const isExpertCancel =
      isConsultantInitiated &&
      session.user.consultantProfileId === existingTrial.consultantProfileId &&
      existingTrial.status === TrialStatus.SCHEDULED;
    const confirmedRefundPaise = await readConfirmedRefund(request);
    const noticeUserIds = [
      existingTrial.consultantProfile.user.id,
      existingTrial.consulteeProfile.user.id,
    ].filter((id) => id !== session.user.id);
    const notice: TrialCancelNotice = {
      trialId,
      userIds: noticeUserIds,
      required: trialCancelOverride(
        isLearner,
        isTrialExpert,
        isPrivileged(session.user.role),
        noticeUserIds,
      ),
      consultantName: existingTrial.consultantProfile.user.name || "Consultant",
      consulteeName: existingTrial.consulteeProfile.user.name || "User",
      planTitle: existingTrial.subscriptionPlan.title,
      dashboardUrl: goHref("auto", "appointments"),
    };
    const noticePre = await prepareTrialCancelNotice(notice);
    let cancelStaged: Awaited<ReturnType<typeof stageTrialCancelNotice>> = {
      bells: [],
      emails: [],
    };
    let gatewayCancels: GatewayCancel[] = [];
    const cancelTrial = (owed: RefundOwedMarker | null) =>
      prisma.$transaction(async (tx) => {
        // A held time's unpaid order dies first, in the capture's lock order
        // (payment → trial); a captured payment is left to the quoted refund.
        if (lockId) {
          ({ gatewayCancels } = await expirePendingPaymentsInTx(tx, {
            appointmentId: lockId,
            reason: "trial cancelled before payment",
          }));
        }
        await transitionTrial(tx, {
          actorUserId: session.user.id,
          where: { id: trialId },
          to: TrialStatus.CANCELLED,
          fromIn: [existingTrial.status],
        });
        const cancelled = await tx.trial.findUniqueOrThrow({
          where: { id: trialId },
        });
        if (cancelled.appointmentId && isExpertCancel) {
          const cancelledSessions = await tx.appointmentOccurrence.findMany({
            where: {
              appointmentId: cancelled.appointmentId,
              ...LIVE_SLOT_WHERE,
            },
            select: { id: true },
          });
          await recordExpertStrike(tx, {
            consultantProfileId: existingTrial.consultantProfileId,
            cause: "EXPERT_CANCEL",
            appointmentId: cancelled.appointmentId,
            occurrenceIds: cancelledSessions.map((o) => o.id),
            organizationId: cancelled.organizationId,
          });
        }
        if (cancelled.appointmentId) {
          // An ending closes any open reschedule, freeing its reservation.
          await declineOpenReschedules(tx, cancelled.appointmentId, {
            actorUserId: session.user.id,
            reason: "trial cancelled",
          });
          await softCancelTrialAppointmentInTx(tx, cancelled.appointmentId);
        }
        // The confirmed refund commits with the cancel, so a death before the
        // refund leaves a marker the retry sweep drives.
        // Only the door that owns the marker drives it; another door's refund
        // still owed refuses the cancel with nothing committed.
        if (owed && !(await stampRefundOwed(tx, owed))) {
          throw await heldMarkerRefusal(tx, owed.paymentId, { trialId });
        }
        // The cancel notices commit with the cancel; a staging failure rolls it back.
        cancelStaged = await stageTrialCancelNotice(tx, notice, noticePre);
        return cancelled;
      });
    // #1846 — a paid trial refunds only the amount the caller confirmed from
    // the preview. The quote is taken under the lock, so nothing can move the
    // booking between the check and the cancel, and the refund below pays
    // exactly that quote.
    const quoteThenCancel = async () => {
      const windowRefusal = await trialCancelWindowRefusal(lockId);
      if (windowRefusal) throw windowRefusal;
      const quote = await quoteTrialRefund({
        appointmentId: existingTrial.appointmentId,
        paymentId: existingTrial.paymentId,
        isConsultantInitiated,
      });
      assertTrialQuoteConfirmed(quote, confirmedRefundPaise);
      const owed = trialRefundOwed({ trialId, quote, side: cancelSide });
      return { quote, owed, cancelled: await cancelTrial(owed) };
    };
    const {
      quote,
      owed,
      cancelled: updatedTrial,
    } = lockId
      ? await withAppointmentLock(lockId, quoteThenCancel)
      : await quoteThenCancel();
    await cancelGatewayOrders(gatewayCancels, {
      op: "trial.delete.gateway-cancel",
      appointmentId: lockId ?? trialId,
    });

    const refund = await refundCancelledTrial({
      trialId,
      initiatedByUserId: session.user.id,
      quote,
      owed,
    });
    // The learner hears "refunded" only once the money actually moved.
    if (
      isConsultantInitiated &&
      refund &&
      !refund.failed &&
      refund.amountRefundedPaise > 0
    ) {
      const refundedBell = await stageTrialRefundedBell(prisma, {
        id: trialId,
        consulteeUserId: existingTrial.consulteeProfile.user.id,
        planTitle: existingTrial.subscriptionPlan.title,
        consultantName: existingTrial.consultantProfile.user.name,
        required: staffCancel
          ? "REFUND_FROM_STAFF_CANCEL"
          : "REFUND_FROM_HOST_CANCEL",
      }).catch(() => undefined);
      await flushNotificationsAfter(
        { bells: [refundedBell] },
        "trial.refunded",
      );
    }

    await flushNotificationsAfter(
      {
        bells: cancelStaged.bells,
        emails: [{ list: cancelStaged.emails, emailType: "TRIAL_CANCELLED" }],
      },
      "trial.delete.cancelled",
    );

    return NextResponse.json({
      data: updatedTrial,
      ...(refund ? { refund } : {}),
    });
  } catch (error) {
    // #1319 — the DB CAS refused the move (stale tab, raced webhook/sweep).
    // #1846 — the quote was not confirmed, or it changed since it was shown;
    // the current quote rides the answer so the dialog can ask again.
    if (error instanceof TrialRefundQuoteError) {
      return NextResponse.json(
        { error: error.message, code: error.code, quote: error.quote },
        { status: error.httpStatus },
      );
    }
    if (isRefusal(error)) {
      await recordRefundNeedsSupport(error);
      return NextResponse.json(
        { error: error.userMessage, code: error.code },
        { status: error.httpStatus },
      );
    }
    // #1846 — a held appointment atom (423) or a Redis outage (503) is an
    // answer too, never a 500.
    if (
      error instanceof IllegalTransitionError ||
      error instanceof AppointmentBusyError ||
      error instanceof BookingLockUnavailableError
    ) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.httpStatus },
      );
    }
    console.error("Error cancelling trial session:", error);
    // Same money-alert gap as PATCH: the refund runs after the trial writes
    // commit, so a failure here can leave a cancelled-but-unrefunded trial (#1125).
    reportSentryError(error, {
      subsystem: "trials",
      op: "DELETE /api/trials/[trialId]",
      expected: false,
      extra: { trialId },
    });
    return NextResponse.json(
      { error: "An error occurred while cancelling trial session" },
      { status: 500 },
    );
  }
}

/**
 * #1846 — the refund amount the caller confirmed from the cancel preview, in
 * paise, from an optional JSON body. Absent or malformed means unconfirmed.
 */
async function readConfirmedRefund(
  request: NextRequest,
): Promise<number | undefined> {
  const body: unknown = await request.json().catch(() => null);
  const parsed = TrialCancelBodySchema.safeParse(body);
  return parsed.success ? parsed.data.confirmedRefundPaise : undefined;
}
