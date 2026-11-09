import { PROFILE_WITH_USER_SELECT } from "@/lib/booking/list-selects";
import { applyRateLimit, eventMutationLimiter } from "@/lib/rate-limit";
import {
  recordParticipants,
  transitionParticipant,
} from "@/lib/booking/participants";
import { BookingRuleError } from "@/lib/booking/booking-rule-error";
import { bookingRuleResponse } from "@/lib/booking/booking-rule-response";
import { assertWindowMatchesPlanDuration } from "@/lib/booking/slot-validation";
import prisma, { type Tx } from "@/lib/prisma";
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
import { TrialStatus, AppointmentsType, Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import {
  lockSlotBatch,
  unlockSlotBooking,
  lockConsulteeBooking,
  unlockConsulteeBooking,
  BookingLockUnavailableError,
  ApprovalLock,
  AppointmentBusyError,
  withAppointmentLock,
} from "@/utils/appointmentlock";
import { isExclusionViolation } from "@/lib/db/pg-errors";
import { transitionTrial } from "@/lib/booking/transitions";
import { declineOpenReschedules } from "@/lib/booking/reschedule-decline";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import { isRefusal } from "@/lib/errors/refusal";
import {
  notifyTrialScheduled,
  notifyTrialCompleted,
  notifyTrialCancelled,
} from "@/lib/novu";
import { UpdateTrialSchema } from "@/schemas/trials";
import { requireApiAuth, isPrivileged } from "@/lib/auth-helpers";
import { trialWindowRefusal } from "@/lib/trials/slot-check";
import { consultantPublicScalars } from "@/lib/data/consultant-public";
import {
  prepareTrialScheduledEmail,
  stageTrialLifecycleEmail,
} from "@/lib/email/senders/booking";
import { stagePreparedEmails } from "@/lib/email/send-to-recipients";
import { flushNotificationsAfter } from "@/lib/novu/stage-then-attempt";
import { getAppUrl } from "@/lib/url";
import { reportSentryError } from "@/lib/observability/report";
import { goHref } from "@/lib/dashboard/go";

interface RouteContext {
  params: Promise<{ trialId: string }>;
}

/**
 * GET /api/trials/[trialId]
 * Get a specific trial session
 */
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

    return NextResponse.json({ data: trial });
  } catch (error) {
    console.error("Error fetching trial session:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching trial session" },
      { status: 500 },
    );
  }
}

// #1169 PR 1 — thrown inside the scheduling transaction so the availability
// check shares the transaction's snapshot instead of racing ahead of it
// (#1093 §1 check-then-act), and mapped to the same 409 the old pre-check
// returned.
class TrialSlotUnavailableError extends Error {
  constructor() {
    super(
      "Selected slot is no longer available. Please choose a different time.",
    );
    this.name = "TrialSlotUnavailableError";
  }
}

// #1319 review — the scheduling transition read `existingTrial.status` on the
// global client, outside the transaction that acts on it. Two accepts that both
// saw PENDING serialise on the consultee lock but pick DIFFERENT slots, so
// neither trips the availability check: the second created a second appointment
// and overwrote Trial.appointmentId, stranding the first one's slot hold
// with nothing pointing at it. Thrown when the CAS claim matches no row.
class TrialStateChangedError extends Error {
  constructor() {
    super(
      "This trial was already updated by another request. Refresh and try again.",
    );
    this.name = "TrialStateChangedError";
  }
}

// R7 (#1319) — a trial obeys the calendar like every other booking. The
// schedule arm only ever checked conflicts, so a trial could be pinned at
// 03:00 on a day the consultant publishes nothing. Distinct from the 409
// above: the slot is not taken, it was never on offer, which is a 400.
class OutsideAvailabilityWindowError extends Error {
  constructor() {
    super("The selected time is outside the expert's published availability");
    this.name = "OutsideAvailabilityWindowError";
  }
}

/**
 * PATCH /api/trials/[trialId]
 * Update a trial session (approve, reject, schedule, complete, etc.)
 */
export async function PATCH(request: NextRequest, context: RouteContext) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;
  // #1319 — accept mints a pay-link and takes a slot; it had no limiter.
  const limited = await applyRateLimit(eventMutationLimiter, session.user.id);
  if (limited) return limited;

  const { trialId } = await context.params;

  try {
    const body = await request.json();
    const parseResult = UpdateTrialSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parseResult.error.issues },
        { status: 400 },
      );
    }
    const { status, scheduledTime, slotData, notes, subscriptionId } =
      parseResult.data;

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

    // #1009 — set when this PATCH cancels or rejects the trial. The appointment
    // retirement and the refund both run after the status write commits.
    let deferredCancellation: {
      appointmentId: string | null;
      paymentId: string | null;
      isConsultantInitiated: boolean;
      /** #1846 — a CANCELLED here was quoted unpaid, so it refunds nothing. */
      quote?: null;
    } | null = null;
    // A declined paid trial's quote and owed marker, both taken in the PATCH commit.
    const declinedRefund: {
      quote: Awaited<ReturnType<typeof quoteTrialRefund>>;
      owed: RefundOwedMarker | null;
    } = { quote: null, owed: null };

    if (notes !== undefined) {
      updateData.notes = notes;
    }

    // Handle status transitions
    if (status) {
      // The doors this PATCH offers; the CAS in TRIAL_ALLOWED_FROM is the
      // state machine. A paid trial the buyer booked holds its time while
      // AWAITING_PAYMENT and only the capture webhook confirms it, so no
      // PATCH moves AWAITING_PAYMENT to SCHEDULED (that would confirm an
      // unpaid hold). PENDING is a trial with no time yet, which the
      // consultant schedules here.
      const validTransitions: Record<TrialStatus, TrialStatus[]> = {
        PENDING: ["SCHEDULED", "CANCELLED", "REJECTED"],
        AWAITING_PAYMENT: ["CANCELLED"],
        SCHEDULED: ["COMPLETED", "CANCELLED"],
        COMPLETED: ["CONVERTED"],
        CONVERTED: [],
        CANCELLED: [],
        REJECTED: [],
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

      // #1775 C-10 — a paid trial is charged at request, so the consultant
      // accepts only a trial whose payment has been captured.
      // The request-time placeholder marks it paid; the editable plan price
      // is only the fallback for rows that predate C-7.
      const hasPlaceholder =
        existingTrial.status === TrialStatus.PENDING &&
        existingTrial.appointmentId !== null;
      const paidTrial =
        hasPlaceholder ||
        Number(existingTrial.subscriptionPlan.trialPriceInPaise ?? 0) > 0;
      if (
        status === TrialStatus.SCHEDULED &&
        existingTrial.status === TrialStatus.PENDING &&
        paidTrial &&
        existingTrial.paymentId === null
      ) {
        return bookingRuleResponse(
          new BookingRuleError(
            "TRIAL_UNPAID",
            "This trial has not been paid yet — it can be accepted once the learner's payment is confirmed.",
          ),
        );
      }
      // The paid trial's placeholder from request time gets the session.
      const placeholderId = paidTrial ? existingTrial.appointmentId : null;

      // Handle scheduling with distributed locking
      if (status === TrialStatus.SCHEDULED) {
        // Support both new slotData and legacy scheduledTime
        if (!slotData && !scheduledTime) {
          return NextResponse.json(
            {
              error:
                "slotData or scheduledTime is required when scheduling a trial",
            },
            { status: 400 },
          );
        }

        let startTime: Date;
        let endTime: Date;

        if (slotData) {
          startTime = new Date(slotData.startsAt);
          endTime = new Date(slotData.endsAt);
          try {
            assertWindowMatchesPlanDuration(
              {
                trialDurationMinutes:
                  existingTrial.subscriptionPlan.trialDurationMinutes,
              },
              startTime,
              endTime,
            );
          } catch (err) {
            if (err instanceof BookingRuleError)
              return bookingRuleResponse(err);
            throw err;
          }
        } else {
          startTime = new Date(scheduledTime!);
          const durationMinutes =
            existingTrial.subscriptionPlan.trialDurationMinutes;
          endTime = new Date(startTime.getTime() + durationMinutes * 60 * 1000);
        }

        // 1. Acquire the shared locks in checkout's global order, consultee →
        // slot (#898). The GiST net and the slot atoms are both consultant-
        // keyed, so without the consultee lock two trials for the SAME
        // consultee with DIFFERENT consultants pass validation concurrently.
        // The slot lock itself is #1169 PR 1 — the same `slot-booking:` atom
        // keys checkout and request-for-approval take, so a trial finally
        // contends with every other writer for the minute.
        let consulteeLock: ApprovalLock | null = null;
        let lock: ApprovalLock[] | null = null;
        try {
          consulteeLock = await lockConsulteeBooking(
            existingTrial.consulteeProfile.user.id,
          );
          // Self atoms: a consultee who is an expert too is busy on their
          // own calendar, in the same all-or-nothing batch as the host's.
          const buyerProfile = await prisma.consultantProfile.findUnique({
            where: { userId: existingTrial.consulteeProfile.user.id },
            select: { id: true },
          });
          lock = await lockSlotBatch(
            [existingTrial.consultantProfileId, buyerProfile?.id]
              .filter((id): id is string => !!id)
              .map((consultantProfileId) => ({
                consultantProfileId,
                startsAt: startTime,
                endsAt: endTime,
              })),
          );
        } catch (error) {
          if (consulteeLock) {
            await unlockConsulteeBooking(consulteeLock);
          }
          // #1169 PR 1 — Redis-down is a fail-closed 503 outage, not the
          // retryable 423 contention below.
          if (error instanceof BookingLockUnavailableError) {
            return NextResponse.json(
              { error: error.message },
              { status: error.httpStatus },
            );
          }
          return NextResponse.json(
            {
              error:
                "This time slot is currently being processed. Please try again.",
            },
            { status: 423 }, // Locked
          );
        }

        try {
          // Rendered before the transaction: the schedule stages only its rows.
          const preparedEmails = await prepareTrialScheduledEmail({
            trialId,
            consulteeUserId: existingTrial.consulteeProfile.user.id,
            consultantUserId: existingTrial.consultantProfile.user.id,
            consulteeName: existingTrial.consulteeProfile.user.name || "User",
            consultantName:
              existingTrial.consultantProfile.user.name || "Consultant",
            planTitle: existingTrial.subscriptionPlan.title,
            startsAt: startTime,
            awaitingPayment: false,
            dashboardUrl: `${getAppUrl()}${goHref("auto", "appointments")}`,
            paymentUrl: null,
          });
          // 2+3. Validate and write in ONE transaction — the availability
          // check previously ran on the global client before the transaction
          // opened, a classic check-then-act window (#1093 §1).
          const scheduled = await prisma.$transaction(async (tx) => {
            // The published window and both calendars, on this transaction's
            // client: the same rule the buyer's pick and a reschedule obey.
            const refusal = await trialWindowRefusal(tx, {
              consultantProfileId: existingTrial.consultantProfileId,
              consultantUserId: existingTrial.consultantProfile.user.id,
              consulteeUserId: existingTrial.consulteeProfile.user.id,
              startsAt: startTime,
              endsAt: endTime,
              selfHoldAppointmentIds: placeholderId ? [placeholderId] : [],
            });
            if (refusal === "OUTSIDE_AVAILABILITY") {
              throw new OutsideAvailabilityWindowError();
            }
            if (refusal === "SLOT_TAKEN") {
              throw new TrialSlotUnavailableError();
            }

            // #1093 §1 — consultantProfileId keeps the session inside the
            // occurrence_no_confirmed_overlap exclusion constraint's WHERE.
            const trialOccurrence = {
              ordinal: 1,
              startsAt: startTime,
              endsAt: endTime,
              isTentative: false,
              consultantProfileId: existingTrial.consultantProfileId,
            };
            const appointment = placeholderId
              ? await acceptPaidTrial(tx, placeholderId, trialOccurrence)
              : await createFreeTrialAppointment(
                  tx,
                  existingTrial,
                  trialOccurrence,
                );

            // Update trial with appointment link and the resulting status.
            // SCHEDULED for BOTH rails: since #1775 a paid trial was paid at
            // request, so accept schedules it rather than parking it in
            // AWAITING_PAYMENT (the sentence this comment used to carry).
            // CAS (#1319): fromIn narrows the allowed-from map to the exact
            // status this request read outside the transaction. Two accepts
            // that both saw PENDING pick DIFFERENT slots, so neither trips the
            // availability check above; without this the loser overwrote
            // Trial.appointmentId and stranded the winner's slot hold.
            // Zero rows rolls the whole attempt back, appointment included.
            // Never wider than TRIAL_ALLOWED_FROM: the validTransitions gate
            // above only lets PENDING/AWAITING_PAYMENT reach this arm.
            try {
              await transitionTrial(tx, {
                where: { id: trialId },
                to: TrialStatus.SCHEDULED,
                fromIn: [existingTrial.status],
                data: { appointmentId: appointment.id, paymentDueAt: null },
                // #1775 C-10 — the capture must still be there at write time.
                ...(placeholderId
                  ? { whereAnd: { paymentId: { not: null } } }
                  : {}),
              });
            } catch (error) {
              // Narrowed from-state means a zero-row CAS is specifically "the
              // status moved under us", not "this edge is illegal".
              if (error instanceof IllegalTransitionError) {
                throw new TrialStateChangedError();
              }
              throw error;
            }
            const updatedTrial = await tx.trial.findUniqueOrThrow({
              where: { id: trialId },
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

            // The notices commit with the schedule, so a rollback takes them too.
            const bellPayload = {
              consultantName:
                existingTrial.consultantProfile.user.name || "Consultant",
              consulteeName: existingTrial.consulteeProfile.user.name || "User",
              planTitle: existingTrial.subscriptionPlan.title,
              dateTime: startTime.toISOString(),
              status: TrialStatus.SCHEDULED,
            };
            const consulteeBell = await notifyTrialScheduled(
              existingTrial.consulteeProfile.user.id,
              {
                ...bellPayload,
                dashboardUrl: goHref("client", "appointments"),
              },
              { deferAttempt: true, tx },
            );
            const consultantBell = await notifyTrialScheduled(
              existingTrial.consultantProfile.user.id,
              {
                ...bellPayload,
                dashboardUrl: goHref("expert", "appointments"),
              },
              { deferAttempt: true, tx },
            );
            const scheduledEmails = await stagePreparedEmails(
              tx,
              preparedEmails,
            );

            return {
              trial: updatedTrial,
              staged: { consulteeBell, consultantBell, scheduledEmails },
            };
          });
          const { consulteeBell, consultantBell, scheduledEmails } =
            scheduled.staged;
          const result = scheduled.trial;

          await flushNotificationsAfter(
            {
              bells: [consulteeBell?.staged, consultantBell?.staged],
              emails: [
                {
                  list: scheduledEmails,
                  emailType: "TRIAL_SESSION_SCHEDULED",
                },
              ],
            },
            "trial.scheduled",
          );

          return NextResponse.json({ data: result });
        } catch (error) {
          // R7 (#1319) — the time was never published, so it is a bad request
          // rather than a lost race.
          if (error instanceof OutsideAvailabilityWindowError) {
            return NextResponse.json({ error: error.message }, { status: 400 });
          }
          // In-transaction availability failure, or the #440 exclusion
          // constraint rejecting a concurrent overlap now that trial slots
          // carry consultantProfileId — both are "slot taken", a 409.
          if (error instanceof IllegalTransitionError) {
            return NextResponse.json(
              { error: error.message, code: error.code },
              { status: error.httpStatus },
            );
          }
          if (
            error instanceof TrialSlotUnavailableError ||
            isExclusionViolation(error)
          ) {
            return NextResponse.json(
              {
                error:
                  "Selected slot is no longer available. Please choose a different time.",
              },
              { status: 409 },
            );
          }
          // A lost CAS claim is the same class of answer — the caller acted on
          // a state that has since moved — but it is not the slot that went.
          if (error instanceof TrialStateChangedError) {
            return NextResponse.json({ error: error.message }, { status: 409 });
          }
          throw error;
        } finally {
          // 5. Always release locks, reverse of acquisition order
          if (lock) {
            await unlockSlotBooking(lock);
          }
          if (consulteeLock) {
            await unlockConsulteeBooking(consulteeLock);
          }
        }
      }

      // Handle completion
      if (status === TrialStatus.COMPLETED) {
        updateData.completedAt = new Date();

        // Notify both parties that the trial is completed
        afterCommit.push(async () => {
          const userIds = [
            existingTrial.consultantProfile.user.id,
            existingTrial.consulteeProfile.user.id,
          ];
          const consultantName =
            existingTrial.consultantProfile.user.name || "Consultant";
          const consulteeName =
            existingTrial.consulteeProfile.user.name || "User";
          const dashboardUrl = goHref("auto", "appointments");
          const [bells, completedEmails] = await Promise.all([
            Promise.resolve(
              notifyTrialCompleted(
                userIds,
                {
                  consultantName,
                  consulteeName,
                  planTitle: existingTrial.subscriptionPlan.title,
                  status: TrialStatus.COMPLETED,
                  dashboardUrl,
                },
                { deferAttempt: true },
              ),
            ).catch((err) => {
              console.error(
                "[trials] Failed to stage trial completion bell:",
                err,
              );
              return [];
            }),
            stageTrialLifecycleEmail(prisma, {
              trialId,
              userIds: [existingTrial.consulteeProfile.user.id],
              kind: "TRIAL_COMPLETED",
              planTitle: existingTrial.subscriptionPlan.title,
              consultantName,
              consulteeName,
              dashboardUrl,
            }).catch((err) => {
              console.error(
                "[trials] Failed to stage trial completion email:",
                err,
              );
              return [];
            }),
          ]);
          await flushNotificationsAfter(
            {
              bells: (bells ?? []).map((b) => b?.staged),
              emails: [
                {
                  list: completedEmails,
                  emailType: "TRIAL_COMPLETED",
                },
              ],
            },
            "trial.completed",
          );
        });
      }

      // Handle cancellation / rejection
      if (status === TrialStatus.CANCELLED || status === TrialStatus.REJECTED) {
        afterCommit.push(async () => {
          const isRejected = status === TrialStatus.REJECTED;
          const userIds = isRejected
            ? [existingTrial.consulteeProfile.user.id]
            : [
                existingTrial.consultantProfile.user.id,
                existingTrial.consulteeProfile.user.id,
              ].filter((id) => id !== session.user.id);
          const emailKind = isRejected ? "TRIAL_REJECTED" : "TRIAL_CANCELLED";
          const consultantName =
            existingTrial.consultantProfile.user.name || "Consultant";
          const consulteeName =
            existingTrial.consulteeProfile.user.name || "User";
          const dashboardUrl = goHref("auto", "appointments");
          const [bells, cancelledEmails] = await Promise.all([
            Promise.resolve(
              notifyTrialCancelled(
                userIds,
                {
                  consultantName,
                  consulteeName,
                  planTitle: existingTrial.subscriptionPlan.title,
                  status,
                  dashboardUrl,
                },
                { deferAttempt: true },
              ),
            ).catch((err) => {
              console.error(
                "[trials] Failed to stage trial cancellation bell:",
                err,
              );
              return [];
            }),
            stageTrialLifecycleEmail(prisma, {
              trialId,
              userIds,
              kind: emailKind,
              planTitle: existingTrial.subscriptionPlan.title,
              consultantName,
              consulteeName,
              dashboardUrl,
            }).catch((err) => {
              console.error(
                "[trials] Failed to stage trial cancellation email:",
                err,
              );
              return [];
            }),
          ]);
          await flushNotificationsAfter(
            {
              bells: (bells ?? []).map((b) => b?.staged),
              emails: [
                {
                  list: cancelledEmails,
                  emailType: emailKind,
                },
              ],
            },
            isRejected ? "trial.rejected" : "trial.cancelled",
          );
        });

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
          // REJECTED is always the consultant declining. On CANCELLED the
          // consultee is the only non-privileged actor the guards above let
          // through, so anyone else is cancelling on the consultant's side.
          isConsultantInitiated:
            status === TrialStatus.REJECTED || !isTrialConsultee,
          ...(status === TrialStatus.CANCELLED ? { quote: null } : {}),
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
          !["APPROVED", "SCHEDULED", "COMPLETED"].includes(subscription.status)
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
            !["APPROVED", "SCHEDULED", "COMPLETED"].includes(currentSub.status))
        ) {
          subscriptionBecameInactive = true;
          return null;
        }
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
      // A declined paid trial owes its refund from this commit: quoted on the
      // transaction's client and stamped beside the status move.
      if (deferredCancellation && deferredCancellation.quote !== null) {
        const quote = await quoteTrialRefund(
          {
            appointmentId: deferredCancellation.appointmentId,
            paymentId: deferredCancellation.paymentId,
            isConsultantInitiated: deferredCancellation.isConsultantInitiated,
          },
          tx,
        );
        const owed = trialRefundOwed({
          trialId,
          quote,
          isConsultantInitiated: deferredCancellation.isConsultantInitiated,
        });
        if (owed && !(await stampRefundOwed(tx, owed))) {
          throw await heldMarkerRefusal(tx, owed.paymentId, { trialId });
        }
        declinedRefund.quote = quote;
        declinedRefund.owed = owed;
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

    // #1009 — the trial has left SCHEDULED/AWAITING_PAYMENT, so its slot is
    // already free. Retire the appointment and settle the money.
    let refund: TrialRefundOutcome | null = null;
    if (deferredCancellation) {
      if (deferredCancellation.appointmentId) {
        await softCancelTrialAppointment(deferredCancellation.appointmentId);
      }
      refund = await refundCancelledTrial({
        trialId,
        initiatedByUserId: session.user.id,
        quote: declinedRefund.quote,
        owed: declinedRefund.owed,
      });
      // #1775 C-12 — a declined paid trial's learner hears "refunded" only
      // once the money actually moved.
      if (
        updatedTrial.status === TrialStatus.REJECTED &&
        refund &&
        !refund.failed &&
        refund.amountRefundedPaise > 0
      ) {
        const refundedBell = await stageTrialRefundedBell(prisma, {
          id: trialId,
          consulteeUserId: existingTrial.consulteeProfile.user.id,
          planTitle: existingTrial.subscriptionPlan.title,
          consultantName: existingTrial.consultantProfile.user.name,
        }).catch(() => undefined);
        await flushNotificationsAfter(
          { bells: [refundedBell] },
          "trial.refunded",
        );
      }
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

    // Only allow cancellation of PENDING, pay-link-live (AWAITING_PAYMENT) or
    // SCHEDULED trials. AWAITING_PAYMENT occupies the slot (occupancyPolicy)
    // and PATCH already allows AWAITING_PAYMENT → CANCELLED, so excluding it
    // here pinned the slot until the payment-expiry sweep released it.
    const cancellableStatuses: TrialStatus[] = [
      TrialStatus.PENDING,
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
    // The CAS narrows to the status the caller saw, so a trial accepted or
    // paid since the read 409s instead of being cancelled on a stale view,
    // and the tombstone and refund read the committed row, not the pre-read.
    const lockId = existingTrial.appointmentId;
    // Only the consultee reaches DELETE without privilege, so a privileged
    // caller is acting on the consultant's behalf.
    const isConsultantInitiated =
      session.user.consulteeProfileId !== existingTrial.consulteeProfileId;
    const confirmedRefundPaise = await readConfirmedRefund(request);
    const cancelTrial = (owed: RefundOwedMarker | null) =>
      prisma.$transaction(async (tx) => {
        await transitionTrial(tx, {
          actorUserId: session.user.id,
          where: { id: trialId },
          to: TrialStatus.CANCELLED,
          fromIn: [existingTrial.status],
        });
        const cancelled = await tx.trial.findUniqueOrThrow({
          where: { id: trialId },
        });
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
      const owed = trialRefundOwed({ trialId, quote, isConsultantInitiated });
      return { quote, owed, cancelled: await cancelTrial(owed) };
    };
    const {
      quote,
      owed,
      cancelled: updatedTrial,
    } = lockId
      ? await withAppointmentLock(lockId, quoteThenCancel)
      : await quoteThenCancel();

    const refund = await refundCancelledTrial({
      trialId,
      initiatedByUserId: session.user.id,
      quote,
      owed,
    });

    const userIds = [
      existingTrial.consultantProfile.user.id,
      existingTrial.consulteeProfile.user.id,
    ].filter((id) => id !== session.user.id);
    const consultantName =
      existingTrial.consultantProfile.user.name || "Consultant";
    const consulteeName = existingTrial.consulteeProfile.user.name || "User";
    const dashboardUrl = goHref("auto", "appointments");
    const [cancelledBells, cancelledEmails] = await Promise.all([
      Promise.resolve(
        notifyTrialCancelled(
          userIds,
          {
            consultantName,
            consulteeName,
            planTitle: existingTrial.subscriptionPlan.title,
            status: TrialStatus.CANCELLED,
            dashboardUrl,
          },
          { deferAttempt: true },
        ),
      ).catch((err) => {
        console.error(
          "[trials] Failed to stage trial delete cancellation bell:",
          err,
        );
        return [];
      }),
      stageTrialLifecycleEmail(prisma, {
        trialId,
        userIds,
        kind: "TRIAL_CANCELLED",
        planTitle: existingTrial.subscriptionPlan.title,
        consultantName,
        consulteeName,
        dashboardUrl,
      }).catch((err) => {
        console.error(
          "[trials] Failed to stage trial delete cancellation email:",
          err,
        );
        return [];
      }),
    ]);
    await flushNotificationsAfter(
      {
        bells: (cancelledBells ?? []).map((b) => b?.staged),
        emails: [
          {
            list: cancelledEmails,
            emailType: "TRIAL_CANCELLED",
          },
        ],
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

type TrialOccurrenceInput = {
  ordinal: number;
  startsAt: Date;
  endsAt: Date;
  isTentative: boolean;
  consultantProfileId: string;
};

/**
 * #1775 C-10 — a paid trial accepted: its session goes on the request-time
 * placeholder, and the seats capture confirmed stay (or become) CONFIRMED.
 */
async function acceptPaidTrial(
  tx: Tx,
  appointmentId: string,
  session: TrialOccurrenceInput,
) {
  await tx.appointmentOccurrence.create({
    data: { appointmentId, ...session },
  });
  await transitionParticipant(
    tx,
    { appointmentId, status: "HELD" },
    "CONFIRMED",
  );
  return tx.appointment.findUniqueOrThrow({
    where: { id: appointmentId },
    include: { occurrences: true },
  });
}

/** A free trial: the appointment and its session are created on accept. */
async function createFreeTrialAppointment(
  tx: Tx,
  trial: {
    organizationId: string | null;
    consulteeProfile: { user: { id: string } };
    consultantProfile: { user: { id: string } };
  },
  session: TrialOccurrenceInput,
) {
  const appointment = await tx.appointment.create({
    data: {
      appointmentType: AppointmentsType.TRIAL,
      occurrences: { create: session },
    },
    include: { occurrences: true },
  });
  await recordParticipants(
    tx,
    appointment.id,
    [
      { userId: trial.consulteeProfile.user.id, role: "CONSULTEE" },
      { userId: trial.consultantProfile.user.id, role: "CONSULTANT" },
    ],
    { organizationId: trial.organizationId ?? null, status: "CONFIRMED" },
  );
  return appointment;
}

/**
 * #1846 — the refund amount the caller confirmed from the cancel preview, in
 * paise, from an optional JSON body. Absent or malformed means unconfirmed.
 */
async function readConfirmedRefund(
  request: NextRequest,
): Promise<number | undefined> {
  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return undefined;
  const value = (body as { confirmedRefundPaise?: unknown })
    .confirmedRefundPaise;
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}
