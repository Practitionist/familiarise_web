import { applyRateLimit, eventMutationLimiter } from "@/lib/rate-limit";
import {
  liveParticipant,
  recordParticipants,
  setParticipantStatus,
} from "@/lib/booking/participants";
import { BookingRuleError } from "@/lib/booking/booking-rule-error";
import { bookingRuleResponse } from "@/lib/booking/booking-rule-response";
import prisma, { type Tx } from "@/lib/prisma";
import { stampTrialEarningsHold } from "@/lib/trials/earnings-hold";
import { stageTrialRefundedBell } from "@/lib/trials/refund-bell";
import {
  needsTrialPayLinkRemint,
  remintTrialPayLink,
} from "@/lib/trials/pay-link";
import {
  refundCancelledTrial,
  softCancelTrialAppointment,
  type TrialRefundOutcome,
} from "@/lib/trials/cancellation";
import { TrialStatus, AppointmentsType, Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import {
  logTrialCompleted,
  logTrialScheduled,
  logTrialConverted,
} from "@/lib/activity/log-activity";
import {
  lockSlotBooking,
  unlockSlotBooking,
  lockConsulteeBooking,
  unlockConsulteeBooking,
  BookingLockUnavailableError,
  ApprovalLock,
} from "@/utils/appointmentlock";
import { isExclusionViolation } from "@/lib/db/pg-errors";
import { transitionTrial } from "@/lib/booking/transitions";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import {
  notifyTrialScheduled,
  notifyTrialCompleted,
  notifyTrialCancelled,
} from "@/lib/novu";
import { UpdateTrialSchema } from "@/schemas/trials";
import { requireApiAuth, isPrivileged } from "@/lib/auth-helpers";
import {
  buildDeadHoldFilter,
  buildOccupiedAppointmentFilter,
} from "@/utils/scheduling-engine/occupancyPolicy";
import {
  findUncoveredAtom,
  loadPublishedCoverage,
  windowAtoms,
} from "@/utils/scheduling-engine/availabilityCoverage";
import { consultantPublicScalars } from "@/lib/data/consultant-public";
import { EMAIL_BUDGET_MS, sendTrialScheduledEmail } from "@/lib/email";
import { getAppUrl } from "@/lib/url";
import { reportSentryError } from "@/lib/observability/report";

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
 * Validates that a time slot is still available for BOTH participants.
 * Runs on the scheduling transaction's client — never the global one — so the
 * check and the slot write commit or fail together.
 */
async function validateSlotAvailability(
  db: Tx,
  consultantProfileId: string,
  consulteeUserId: string,
  startTime: Date,
  endTime: Date,
): Promise<boolean> {
  // Use canonical occupancy policy for consistent conflict detection
  const occupiedFilter = buildOccupiedAppointmentFilter(consultantProfileId);

  const overlapping = await db.appointmentOccurrence.findFirst({
    where: {
      appointment: {
        AND: [
          { OR: occupiedFilter },
          // #1319 — a lapsed checkout hold is not a booking (parity with checkout).
          { NOT: buildDeadHoldFilter(new Date()) },
        ],
      },
      // Canonical overlap predicate
      startsAt: { lt: endTime },
      endsAt: { gt: startTime },
    },
  });
  if (overlapping) return false;

  // #1093 §1 follow-through — the consultee's own calendar. The GiST
  // constraint is consultant-keyed, so a consultee double-booked across two
  // consultants is only ever caught here (mirrors validateNoConflicts).
  const consulteeConflict = await db.appointmentOccurrence.findFirst({
    where: {
      completionStatus: "SCHEDULED",
      appointment: {
        deletedAt: null,
        participants: { some: liveParticipant(consulteeUserId) },
      },
      startsAt: { lt: endTime },
      endsAt: { gt: startTime },
    },
  });

  return !consulteeConflict;
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
            user: true,
          },
        },
        consultantProfile: {
          include: {
            user: true,
          },
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
    } | null = null;

    if (notes !== undefined) {
      updateData.notes = notes;
    }

    // Handle status transitions
    if (status) {
      // State machine:
      //   free trial   PENDING → SCHEDULED → COMPLETED → CONVERTED
      //   paid trial   PENDING → AWAITING_PAYMENT → SCHEDULED → …
      // REJECTED = consultant declines, CANCELLED = consultee cancels or the
      // pay-link lapses past paymentDueAt.
      const validTransitions: Record<TrialStatus, TrialStatus[]> = {
        PENDING: ["AWAITING_PAYMENT", "SCHEDULED", "CANCELLED", "REJECTED"],
        // Only the webhook moves this to SCHEDULED (on payment capture); the
        // expiry job and the consultee move it to CANCELLED.
        AWAITING_PAYMENT: ["SCHEDULED", "CANCELLED"],
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

      updateData.status = status;

      // #1775 C-10 — a paid trial is charged at request, so the consultant
      // accepts only a trial whose payment has been captured.
      const trialPriceInPaise = Number(
        existingTrial.subscriptionPlan.trialPriceInPaise ?? 0,
      );
      if (
        status === TrialStatus.SCHEDULED &&
        existingTrial.status === TrialStatus.PENDING &&
        trialPriceInPaise > 0 &&
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
      const placeholderId =
        trialPriceInPaise > 0 ? existingTrial.appointmentId : null;

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
          lock = await lockSlotBooking(
            existingTrial.consultantProfileId,
            startTime.toISOString(),
            endTime.toISOString(),
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
          // 2+3. Validate and write in ONE transaction — the availability
          // check previously ran on the global client before the transaction
          // opened, a classic check-then-act window (#1093 §1).
          const result = await prisma.$transaction(async (tx) => {
            // The published window first — the same union coverage rule
            // checkout applies, on this transaction's client. Enforced even
            // when the consultant is the one scheduling: a trial is a booking.
            const { weeklyRows, customRows } = await loadPublishedCoverage(
              tx,
              existingTrial.consultantProfileId,
              startTime,
              endTime,
            );
            const uncovered = findUncoveredAtom(
              windowAtoms(startTime, endTime),
              weeklyRows,
              customRows,
            );
            if (uncovered) {
              throw new OutsideAvailabilityWindowError();
            }

            const isAvailable = await validateSlotAvailability(
              tx,
              existingTrial.consultantProfileId,
              existingTrial.consulteeProfile.user.id,
              startTime,
              endTime,
            );
            if (!isAvailable) {
              throw new TrialSlotUnavailableError();
            }

            // #1093 §1 — consultantProfileId keeps the session inside the
            // occurrence_no_confirmed_overlap exclusion constraint's WHERE.
            const trialSession = {
              ordinal: 1,
              startsAt: startTime,
              endsAt: endTime,
              isTentative: false,
              consultantProfileId: existingTrial.consultantProfileId,
            };
            const appointment = placeholderId
              ? await acceptPaidTrial(tx, placeholderId, trialSession)
              : await createFreeTrialAppointment(
                  tx,
                  existingTrial,
                  trialSession,
                );

            // Update trial with appointment link and the resulting status —
            // AWAITING_PAYMENT for a paid trial, SCHEDULED for a free one.
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

            return updatedTrial;
          });

          // 4. Log activity (outside transaction for non-critical operation)
          await logTrialScheduled(
            existingTrial.consultantProfileId,
            trialId,
            {
              id: existingTrial.consulteeProfile.user.id,
              name: existingTrial.consulteeProfile.user.name,
              image: existingTrial.consulteeProfile.user.image,
            },
            existingTrial.subscriptionPlan.title,
            startTime,
          );

          // #1775 C-10 — accepting never mints: a paid trial was paid at request.
          await notifyTrialScheduled(existingTrial.consulteeProfile.user.id, {
            consultantName:
              existingTrial.consultantProfile.user.name || "Consultant",
            consulteeName: existingTrial.consulteeProfile.user.name || "User",
            planTitle: existingTrial.subscriptionPlan.title,
            dateTime: startTime.toISOString(),
            status: TrialStatus.SCHEDULED,
            dashboardUrl: "/dashboard",
          });

          // #1653 — the email twin, to both parties: the consultee's CTA is
          // the pay link while the trial awaits payment. The sender never throws.
          await sendTrialScheduledEmail(
            {
              trialId,
              consulteeUserId: existingTrial.consulteeProfile.user.id,
              consultantUserId: existingTrial.consultantProfile.user.id,
              consulteeName: existingTrial.consulteeProfile.user.name || "User",
              consultantName:
                existingTrial.consultantProfile.user.name || "Consultant",
              planTitle: existingTrial.subscriptionPlan.title,
              startsAt: startTime,
              awaitingPayment: false,
              dashboardUrl: `${getAppUrl()}/dashboard`,
              paymentUrl: null,
            },
            EMAIL_BUDGET_MS.REQUEST,
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

        // Log activity
        afterCommit.push(() =>
          logTrialCompleted(
            existingTrial.consultantProfileId,
            trialId,
            {
              id: existingTrial.consulteeProfile.user.id,
              name: existingTrial.consulteeProfile.user.name,
              image: existingTrial.consulteeProfile.user.image,
            },
            existingTrial.subscriptionPlan.title,
          ),
        );

        // Notify both parties that the trial is completed
        afterCommit.push(() =>
          notifyTrialCompleted(
            [
              existingTrial.consultantProfile.user.id,
              existingTrial.consulteeProfile.user.id,
            ],
            {
              consultantName:
                existingTrial.consultantProfile.user.name || "Consultant",
              consulteeName: existingTrial.consulteeProfile.user.name || "User",
              planTitle: existingTrial.subscriptionPlan.title,
              status: TrialStatus.COMPLETED,
              dashboardUrl: "/dashboard",
            },
          ),
        );
      }

      // Handle cancellation / rejection
      if (status === TrialStatus.CANCELLED || status === TrialStatus.REJECTED) {
        afterCommit.push(() =>
          notifyTrialCancelled(
            [
              existingTrial.consultantProfile.user.id,
              existingTrial.consulteeProfile.user.id,
            ],
            {
              consultantName:
                existingTrial.consultantProfile.user.name || "Consultant",
              consulteeName: existingTrial.consulteeProfile.user.name || "User",
              planTitle: existingTrial.subscriptionPlan.title,
              status,
              dashboardUrl: "/dashboard",
            },
          ),
        );

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

        // Link the subscription to the trial
        updateData.convertedToSubscription = {
          connect: { id: subscriptionId },
        };

        // Log the conversion activity
        afterCommit.push(() =>
          logTrialConverted(
            existingTrial.consultantProfileId,
            trialId,
            subscriptionId,
            {
              id: existingTrial.consulteeProfile.user.id,
              name: existingTrial.consulteeProfile.user.name || "User",
              image: existingTrial.consulteeProfile.user.image,
            },
            existingTrial.subscriptionPlan.title,
          ),
        );
      }
    }

    // Update the trial session (status + any other fields)
    // #1319 — the status moves through the CAS helper inside the same tx as
    // the other fields, so a raced webhook/sweep matches zero rows and the
    // whole PATCH rolls back instead of clobbering it. The app-level
    // validTransitions check above is only the friendly error text.
    const { status: nextStatus, ...restUpdate } = updateData;
    const updatedTrial = await prisma.$transaction(async (tx) => {
      if (nextStatus !== undefined) {
        await transitionTrial(tx, {
          where: { id: trialId },
          to: nextStatus as TrialStatus,
        });
      }
      // #1775 C-12 — a declined paid trial is refunded in full; the learner
      // hears it from the same transaction that records the decline.
      if (nextStatus === TrialStatus.REJECTED && existingTrial.paymentId) {
        await stageTrialRefundedBell(tx, {
          id: trialId,
          consulteeUserId: existingTrial.consulteeProfile.user.id,
          planTitle: existingTrial.subscriptionPlan.title,
          consultantName: existingTrial.consultantProfile.user.name,
        });
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
        appointmentId: deferredCancellation.appointmentId,
        paymentId: deferredCancellation.paymentId,
        initiatedByUserId: session.user.id,
        isConsultantInitiated: deferredCancellation.isConsultantInitiated,
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
        consultantProfile: {
          include: { user: { select: { id: true, name: true } } },
        },
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
    await transitionTrial(prisma, {
      where: { id: trialId },
      to: TrialStatus.CANCELLED,
      fromIn: cancellableStatuses,
    });
    const updatedTrial = await prisma.trial.findUniqueOrThrow({
      where: { id: trialId },
    });

    if (existingTrial.appointmentId) {
      await softCancelTrialAppointment(existingTrial.appointmentId);
    }

    // Only the consultee reaches DELETE without privilege, so a privileged
    // caller is acting on the consultant's behalf.
    const refund = await refundCancelledTrial({
      trialId,
      appointmentId: existingTrial.appointmentId,
      paymentId: existingTrial.paymentId,
      initiatedByUserId: session.user.id,
      isConsultantInitiated:
        session.user.consulteeProfileId !== existingTrial.consulteeProfileId,
    });

    // FIX #554: Send cancellation notification (DELETE path was missing this)
    await notifyTrialCancelled(
      [
        existingTrial.consultantProfile.user.id,
        existingTrial.consulteeProfile.user.id,
      ],
      {
        consultantName:
          existingTrial.consultantProfile.user.name || "Consultant",
        consulteeName: existingTrial.consulteeProfile.user.name || "User",
        planTitle: existingTrial.subscriptionPlan.title,
        status: TrialStatus.CANCELLED,
        dashboardUrl: "/dashboard",
      },
    );

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

type TrialSession = {
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
  session: TrialSession,
) {
  await tx.appointmentOccurrence.create({
    data: { appointmentId, ...session },
  });
  await setParticipantStatus(
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
  session: TrialSession,
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
