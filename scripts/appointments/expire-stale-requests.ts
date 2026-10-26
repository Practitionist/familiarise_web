/** Stale-request expiry core, shared by the cleanup registry and admin recovery door. */

import prisma from "../../lib/prisma";
import {
  AppointmentStatus,
  PaymentStatus,
  OccurrenceCompletionStatus,
  Prisma,
} from "@prisma/client";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { startDeadline } from "@/lib/cron/run-deadline";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { refundableBalancePaiseSql } from "@/lib/payments/refundable-balance-sql";
import {
  driveRefundOwed,
  markerFromRow,
  MAX_REFUND_OWED_ATTEMPTS,
  REFUND_OWED_SELECT,
  stampRefundsOwed,
  type RefundOwedMarker,
} from "@/lib/payments/operations/refund-owed";
import { refundBookingPayment } from "@/lib/payments/operations/booking-refund";
import {
  RESCHEDULE_OPEN_STATUSES,
  transitionConsultationRequest,
  transitionOccurrenceCompletion,
  transitionSubscriptionRequest,
} from "@/lib/booking/transitions";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import {
  SLOT_TRANSITION_TX_OPTIONS,
  transitionSlotsInChunks,
} from "@/lib/booking/slot-release";
import { flushBackupInterestNotices } from "@/lib/booking/backup-interest";
import { lapseApprovedRequest } from "@/lib/booking/lapse-approved-request";
import {
  notifyConsulteeRequestExpired,
  PAY_LINK_LAPSED_REASON,
  UNANSWERED_REQUEST_REASON,
  UNSCHEDULED_SUBSCRIPTION_REASON,
  type RequestExpiredNotice,
} from "@/lib/booking/expiry-notices";
import { notifyUnscheduledSubscriptionNudge } from "@/lib/novu/service";
import { NOVU_WORKFLOWS, notificationScope } from "@/lib/novu/workflows";
import { deriveTransactionId } from "@/lib/novu/outbox";
import { stageBell } from "@/lib/novu/stage-bell";
import { flushNotificationsAfter } from "@/lib/novu/stage-then-attempt";
import { stageAppointmentCancelledEmail } from "@/lib/email/senders/booking";
import { expireBackupInterest } from "@/lib/booking/backup-interest";
import { notificationHref } from "@/lib/novu/resolve-href";
import type { Tx } from "@/lib/prisma";
import {
  EMAIL_BUDGET_MS,
  SUBSCRIPTION_UNSCHEDULED_NUDGE_EMAIL_TYPE,
  sendUnscheduledSubscriptionNudgeEmail,
  unscheduledNudgeEntityRef,
} from "@/lib/email";
import { getAppUrl } from "@/lib/url";

// The per-cohort WHERE guards below (PENDING by requestedAt,
// APPROVED_PENDING_PAYMENT by updatedAt) are deliberate subsets of
// REQUEST_ALLOWED_FROM.EXPIRED in lib/booking/transitions.ts (#836) —
// each cohort has its own cutoff, so they are not merged into one sweep.
//
// Belt-and-braces on top of the requestedAt refresh in the reschedule route:
// a booking with a LIVE reschedule proposal (RESCHEDULE_OPEN_STATUSES) is
// excluded from the PENDING cohorts entirely. The proposal system budgets its
// own lifetime (72h); the expiry sweep must never race it — an unanswered
// reschedule used to be auto-EXPIRED and fully refunded within the hour while
// its proposal was still open.

// Expire PENDING consultations after 48 hours. A PENDING consultation is not
// just paperwork — its request-for-approval tentative slots block the
// consultant's calendar, so the threshold is measured in hours, not days.
// Subscriptions hold no slots at request time (lazy allocation), so they
// keep the generous window below.
// Exported so the request email can name the same deadline (#1653).
export const PENDING_CONSULTATION_EXPIRATION_HOURS = 48;

// Expire requests in PENDING state for more than 30 days (subscriptions).
const PENDING_EXPIRATION_DAYS = 30;

// Also expire APPROVED_PENDING_PAYMENT after 7 days
const PAYMENT_PENDING_EXPIRATION_DAYS = 7;

// Per-run cap, same shape as cleanup-tentative-occurrences' MAX_SLOTS_PER_RUN:
// every arm now expires one request per transaction instead of one bulk
// statement, so an unbounded cohort times the function out before it pages.
// Oldest-first, so consecutive hourly runs drain a backlog.
const MAX_REQUESTS_PER_RUN = 500;
// Slot rows released per run by the stale-RESCHEDULED pass; the next run continues.
const MAX_SLOT_RELEASES_PER_RUN = 2000;

/**
 * Per-arm caps bound request reads. Only the paid-unallocated family also
 * bounds payment staging and shares an admission deadline across its phases.
 */
export interface StaleRequestRunLimits {
  /** Rows one cohort arm may read and transition this run. */
  maxRequests: number;
  /** Slot rows the stale-RESCHEDULED pass may release this run. */
  maxSlotReleases: number;
}

const DEFAULT_RUN_LIMITS: StaleRequestRunLimits = {
  maxRequests: MAX_REQUESTS_PER_RUN,
  maxSlotReleases: MAX_SLOT_RELEASES_PER_RUN,
};

/**
 * #1775 C-3 — a paid plan's consultant has 48 h from the capture to allocate
 * cycle 1, or the buyer is refunded in full. Pre-`capturedAt` rows use createdAt.
 */
export const PAID_UNALLOCATED_HOURS = 48;

// A full-subscription reschedule re-enters PENDING, and its open proposal must
// resolve through the reschedule machine, not be swept out from under it.
// Rides the CAS WHERE as well as the cohort read (#1554: one wrapper or none).
// Built per call: the status list is read at run time, not at import.
function noLiveProposal() {
  return {
    OR: [
      { appointment: null },
      {
        appointment: {
          rescheduleRequests: {
            none: { status: { in: [...RESCHEDULE_OPEN_STATUSES] } },
          },
        },
      },
    ],
  } satisfies Prisma.SubscriptionWhereInput;
}

// Zero live confirmed sessions on the booking; re-stated in every CAS WHERE so
// a session allocated between the read and the write leaves the cohort (#1423).
const NO_LIVE_SESSION = {
  NOT: {
    appointment: {
      occurrences: { some: { isTentative: false, deletedAt: null } },
    },
  },
} satisfies Prisma.SubscriptionWhereInput;

// P0-3 — no released occurrence still waiting for its replacement. A reschedule
// releases a slot IN PLACE (isTentative: true + RESCHEDULED), and a DECLINE
// restores it — the counterparty said no to the new time, not to the booking, so
// the original time is put back. What leaves a slot released after a decline is
// the case where the original time was taken while the proposal was open: the
// restore cannot land, the parent is parked, and a human must place the
// sessions. A whole-booking reschedule also leaves the parent PENDING, which is
// exactly the shape the 48 h arm below selects — so a paid plan parked by a
// decline (or by a restore that could not finish, because the original time was
// taken while the proposal was open) was EXPIRED and refunded in full with
// nobody having cancelled it. Stated on the LIVE SLOT rather than on the parent
// status, because the status is the reschedule work's decision to make and the
// slot says the same thing under any of them: a RESCHEDULED occurrence is a
// session that has not been re-placed, so a human owns this booking.
const NO_UNPLACED_SLOT = {
  NOT: {
    appointment: {
      occurrences: {
        some: {
          completionStatus: OccurrenceCompletionStatus.RESCHEDULED,
          deletedAt: null,
        },
      },
    },
  },
} satisfies Prisma.SubscriptionWhereInput;

/** A SUCCEEDED payment on the wrapper, captured before `cutoff` (#1775 C-3). */
function paidCapturedBefore(cutoff: Date): Prisma.SubscriptionWhereInput {
  return {
    appointment: {
      payment: {
        some: {
          paymentStatus: PaymentStatus.SUCCEEDED,
          deletedAt: null,
          OR: [
            { capturedAt: { lt: cutoff } },
            { capturedAt: null, createdAt: { lt: cutoff } },
          ],
        },
      },
    },
  };
}

const HAS_SUCCEEDED_PAYMENT = {
  appointment: {
    payment: {
      some: { paymentStatus: PaymentStatus.SUCCEEDED, deletedAt: null },
    },
  },
} satisfies Prisma.SubscriptionWhereInput;

export interface ExpireStaleRequestsResult {
  success: boolean;
  consultationsExpired: number;
  subscriptionsExpired: number;
  /** #1703 — consultant nudges sent for paid, still-unscheduled subscriptions. */
  subscriptionNudgesSent: number;
  paymentPendingExpired: number;
  /** Tentative slots freed by the consultation expiry (B1). */
  consultationSlotsReleased: number;
  /**
   * PR 2c money fix — SUCCEEDED payments refunded because their booking
   * expired unallocated/unanswered. Money must never leave without a
   * session AND silently: every refund routes through the booking front door.
   */
  refundsIssued: number;
  refundFailures: number;
  errors: string[];
  /** Remaining or held work in the 48-hour paid-unallocated family. */
  unallocatedHasMore: boolean;
  unallocatedRefundsDeferred: number;
  timestamp: string;
}

/**
 * The three arms that refund an expired engagement, by name. The name IS half
 * the dedupe key, and the wrapper it used to carry cannot be that half: two of
 * the three arms are subscription arms, so a key built from the wrapper would
 * let one arm's refund read back as another arm's already-done work — the
 * second arm would report "issued" while moving no money. The wrapper is
 * derived from the arm rather than passed beside it, so no caller can pair an
 * arm with the wrong relation.
 */
type ExpiredRefundArm =
  "pending-consultation" | "pending-subscription" | "approved-unallocated";

const ARM_WRAPPER: Record<ExpiredRefundArm, "consultation" | "subscription"> = {
  "pending-consultation": "consultation",
  "pending-subscription": "subscription",
  "approved-unallocated": "subscription",
};

/**
 * P0-4 — the one refund this arm owes this payment, and the unique index on
 * `Refund.dedupeKey` is what enforces "one". Unkeyed, the only guard left was
 * refundPayment's re-derivation of the refundable balance inside its own
 * Serializable transaction: a read-then-write, which two concurrent unkeyed
 * runs (exactly what an expired `cron:lock:` grant allows) both pass, because
 * `Refund` has no unique constraint on paymentId. with-cron-lock states that
 * the CAS guards, not the lock, are the correctness backstop; an unkeyed
 * refund was the one place that claim was false. Nothing here varies per run,
 * so a re-run produces the identical string and the index actually dedupes.
 */
const expiredRefundKey = (arm: ExpiredRefundArm, paymentId: string) =>
  `${arm}:${paymentId}`;

/**
 * Refund every SUCCEEDED payment attached to the given expired engagement's
 * appointments. Booking-journey audit gap #1: the sweep used to flip PAID
 * rows to EXPIRED with no money movement and no trace — buyer paid, got
 * nothing, silence. Every refund goes through the booking front door
 * (doctrine rule 3); failures are counted + logged, never thrown (a cron
 * must drain the cohort even when one gateway call fails).
 */
async function refundPaymentsForExpired(
  arm: ExpiredRefundArm,
  expiredIds: string[],
): Promise<{ issued: number; failures: number; failureMsgs: string[] }> {
  if (expiredIds.length === 0)
    return { issued: 0, failures: 0, failureMsgs: [] };
  const kind = ARM_WRAPPER[arm];
  const rel = kind === "consultation" ? "consultationId" : "subscriptionId";
  const appointments = await prisma.appointment.findMany({
    where: { [rel]: { in: expiredIds } },
    select: {
      id: true,
      payment: { select: { id: true, paymentStatus: true } },
    },
  });

  let issued = 0;
  let failures = 0;
  const failureMsgs: string[] = [];
  for (const appt of appointments) {
    for (const pay of appt.payment ?? []) {
      if (pay.paymentStatus !== "SUCCEEDED") continue;
      try {
        await refundBookingPayment({
          paymentId: pay.id,
          reason: `${kind} expired unallocated/unanswered — automatic full refund`,
          initiatedByUserId: null,
          dedupeKey: expiredRefundKey(arm, pay.id),
        });
        issued += 1;
      } catch (err) {
        failures += 1;
        const msg = `Refund failed for payment ${pay.id} (${kind} ${rel}): ${err}`;
        console.error(`❌ ${msg}`);
        failureMsgs.push(msg);
      }
    }
  }
  return { issued, failures, failureMsgs };
}

function expiredRefundMarker(
  arm: ExpiredRefundArm,
  paymentId: string,
): RefundOwedMarker {
  const kind = ARM_WRAPPER[arm];
  return {
    paymentId,
    amountPaise: null,
    key: expiredRefundKey(arm, paymentId),
    reason: `${kind} expired unallocated/unanswered — automatic full refund`,
  };
}

/** Stage an expiry arm's full-balance obligations in the winning CAS transaction. */
async function stageExpiredRefunds(
  tx: Tx,
  arm: ExpiredRefundArm,
  entityId: string,
): Promise<RefundOwedMarker[]> {
  const kind = ARM_WRAPPER[arm];
  const relation =
    kind === "consultation" ? "consultationId" : "subscriptionId";
  const payments = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT p.id
    FROM "Payment" p
    JOIN "Appointment" a ON a.id = p."appointmentId"
    WHERE a.${Prisma.raw(`"${relation}"`)} = ${entityId}
      AND p."paymentStatus" = 'SUCCEEDED'
      AND p."deletedAt" IS NULL
    ORDER BY p."createdAt" ASC, p.id ASC
  `);
  const markers = payments.map(({ id }) => expiredRefundMarker(arm, id));
  const stamped = await stampRefundsOwed(tx, markers);
  if (stamped !== markers.length) {
    throw new Error(`${arm} refund marker changed; expiry was rolled back`);
  }
  return markers;
}

/** Recover paid approved-subscription expiries whose exact history reason identifies this arm. */
async function stageLegacyApprovedUnallocatedRefunds(
  limit: number,
): Promise<RefundOwedMarker[]> {
  return withSerializableRetry(async () =>
    prisma.$transaction(
      async (tx) => {
        const reason = `Auto-expired: APPROVED with zero allocated sessions for more than ${PENDING_EXPIRATION_DAYS} days`;
        const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
          SELECT p.id
          FROM "Payment" p
          JOIN "Appointment" a ON a.id = p."appointmentId"
          JOIN "Subscription" request ON request.id = a."subscriptionId"
          WHERE request."requestStatus" = 'EXPIRED'
            AND p."paymentStatus" = 'SUCCEEDED'
            AND p."deletedAt" IS NULL
            AND p."refundOwedKey" IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM "Refund" prior
              WHERE prior."dedupeKey" = ${expiredRefundKey("approved-unallocated", "")} || p.id
                AND prior.status IN ('SUCCEEDED', 'PENDING')
            )
            AND ${refundableBalancePaiseSql(Prisma.sql`p.id`, Prisma.sql`p.amount`)} > 0
            AND EXISTS (
              SELECT 1 FROM "BookingStatusHistory" h
              WHERE h."entityId" = request.id
                AND h.entity = 'SUBSCRIPTION'
                AND h."fromStatus" = 'APPROVED'
                AND h."toStatus" = 'EXPIRED'
                AND h."actorUserId" IS NULL
                AND h.reason = ${reason}
            )
          ORDER BY p."createdAt" ASC, p.id ASC
          LIMIT ${limit + 1}
        `);
        const eligible = rows.slice(0, limit);
        const markers = eligible.map(({ id }) =>
          expiredRefundMarker("approved-unallocated", id),
        );
        const stamped = await stampRefundsOwed(tx, markers);
        if (stamped !== markers.length) {
          throw new Error("approved-unallocated legacy refund marker changed");
        }
        return markers;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

async function driveExpiredRefunds(markers: readonly RefundOwedMarker[]) {
  const out = { issued: 0, failures: 0, failureMsgs: [] as string[] };
  for (const marker of markers) {
    const outcome = await driveRefundOwed(marker);
    if (outcome.kind === "refunded") out.issued += 1;
    else if (outcome.kind === "failed") {
      out.failures += 1;
      out.failureMsgs.push(
        `Refund failed for payment ${marker.paymentId}: ${outcome.error}`,
      );
    }
  }
  return out;
}

/**
 * Expire stale PENDING consultations and release the tentative slots they
 * pinned. The slot release happens HERE rather than waiting for the
 * tentative-slot sweeper: that sweep's parent guard skips PENDING
 * consultations by design (a consultant may legitimately be reviewing), so
 * before B1 a slot pinned by a stale request waited for the status flip and
 * then another sweeper cycle — 30+ days in the worst case.
 */
async function expirePendingConsultations(
  limits: StaleRequestRunLimits,
): Promise<{
  expired: number;
  slotsReleased: number;
  issued: number;
  failures: number;
  errors: string[];
}> {
  const errors: string[] = [];
  const expirationDate = new Date(
    Date.now() - PENDING_CONSULTATION_EXPIRATION_HOURS * 60 * 60 * 1000,
  );

  try {
    // Find stale PENDING consultations (with their appointment ids so the
    // slot release below can target exactly the expired rows).
    const staleConsultations = await prisma.consultation.findMany({
      where: {
        status: AppointmentStatus.PENDING,
        requestedAt: { lt: expirationDate },
        // Never reap a booking whose reschedule proposal is still live or
        // that is parked with an unplaced RESCHEDULED slot awaiting placement.
        ...NO_UNPLACED_SLOT,
        appointment: {
          rescheduleRequests: {
            none: { status: { in: [...RESCHEDULE_OPEN_STATUSES] } },
          },
        },
      },
      select: {
        id: true,
        appointment: {
          select: {
            id: true,
            organizationId: true,
            occurrences: {
              where: { deletedAt: null },
              orderBy: { startsAt: "asc" as const },
              take: 1,
              select: { startsAt: true },
            },
          },
        },
        // #1703 D2 — what the consultee's expiry notice names.
        requestedBy: { select: { user: { select: { id: true, name: true } } } },
        consultationPlan: {
          select: {
            title: true,
            consultantProfile: { select: { user: { select: { name: true } } } },
          },
        },
      },
      orderBy: { requestedAt: "asc" },
      take: limits.maxRequests,
    });
    warnIfCapped("consultation", staleConsultations.length, limits);

    console.log(
      `Found ${staleConsultations.length} consultations in PENDING for >${PENDING_CONSULTATION_EXPIRATION_HOURS}h`,
    );

    if (staleConsultations.length === 0) {
      return { expired: 0, slotsReleased: 0, issued: 0, failures: 0, errors };
    }

    // One transaction per consultation: the EXPIRED transition and the release
    // of its tentative holds commit together, so a failed release can never
    // leave an EXPIRED request still holding the consultant's calendar. A
    // lost CAS (approved between the read and the write) is skipped, not fatal.
    const expiredIds: string[] = [];
    const markers: RefundOwedMarker[] = [];
    let slotsReleased = 0;
    let skipped = 0;
    for (const stale of staleConsultations) {
      try {
        const stagedForOne = await withSerializableRetry(() =>
          prisma.$transaction(
            async (tx) => {
              await transitionConsultationRequest(tx, {
                where: {
                  id: stale.id,
                  // Repeat the cohort read's age predicate inside the CAS WHERE so
                  // a reschedule-refreshed requestedAt between read and write
                  // matches zero rows instead of expiring a live request.
                  requestedAt: { lt: expirationDate },
                  ...NO_UNPLACED_SLOT,
                  appointment: {
                    rescheduleRequests: {
                      none: { status: { in: [...RESCHEDULE_OPEN_STATUSES] } },
                    },
                  },
                },
                to: AppointmentStatus.EXPIRED,
                fromIn: [AppointmentStatus.PENDING],
              });
              const owed = await stageExpiredRefunds(
                tx,
                "pending-consultation",
                stale.id,
              );
              if (!stale.appointment) return { released: 0, markers: owed };
              const released = await transitionOccurrenceCompletion(tx, {
                where: {
                  appointmentId: stale.appointment.id,
                  isTentative: true,
                  deletedAt: null,
                },
                to: OccurrenceCompletionStatus.CANCELLED,
                data: { deletedAt: new Date() },
                allowZero: true,
              });
              return { released, markers: owed };
            },
            {
              ...SLOT_TRANSITION_TX_OPTIONS,
              isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            },
          ),
        );
        expiredIds.push(stale.id);
        slotsReleased += stagedForOne.released;
        markers.push(...stagedForOne.markers);
        // #1703 D2 — after the commit: the consultee learns nobody answered.
        if (stale.appointment && stale.requestedBy?.user) {
          await notifyConsulteeRequestExpired({
            appointmentId: stale.appointment.id,
            organizationId: stale.appointment.organizationId,
            consulteeUserId: stale.requestedBy.user.id,
            consulteeName: stale.requestedBy.user.name ?? "Consultee",
            consultantName:
              stale.consultationPlan?.consultantProfile?.user?.name ??
              "Consultant",
            planTitle: stale.consultationPlan?.title ?? "Consultation",
            appointmentType: "CONSULTATION",
            startsAt: stale.appointment.occurrences?.[0]?.startsAt ?? null,
            reason: UNANSWERED_REQUEST_REASON,
          });
        }
      } catch (error) {
        if (!(error instanceof IllegalTransitionError)) throw error;
        skipped++;
      }
    }
    console.log(
      `✅ Expired ${expiredIds.length} PENDING consultations (${skipped} moved on before the write)`,
    );
    console.log(`✅ Released ${slotsReleased} tentative slots from them`);
    const refunds = await driveExpiredRefunds(markers);
    errors.push(...refunds.failureMsgs);

    return { expired: expiredIds.length, slotsReleased, ...refunds, errors };
  } catch (error) {
    const msg = `Failed to expire consultations: ${error}`;
    console.error(`❌ ${msg}`);
    errors.push(msg);
    return { expired: 0, slotsReleased: 0, issued: 0, failures: 0, errors };
  }
}

/**
 * Expire stale PENDING subscriptions
 */
async function expirePendingSubscriptions(
  limits: StaleRequestRunLimits,
): Promise<{
  expired: number;
  issued: number;
  failures: number;
  errors: string[];
}> {
  const errors: string[] = [];
  const expirationDate = new Date(
    Date.now() - PENDING_EXPIRATION_DAYS * 24 * 60 * 60 * 1000,
  );

  try {
    // Find stale PENDING subscriptions
    const staleSubscriptions = await prisma.subscription.findMany({
      where: {
        status: AppointmentStatus.PENDING,
        requestedAt: { lt: expirationDate },
        ...noLiveProposal(),
        // #1775 C-3 — a paid PENDING plan belongs to the 48 h arm.
        NOT: HAS_SUCCEEDED_PAYMENT,
      },
      include: {
        requestedBy: {
          include: { user: { select: { email: true, name: true } } },
        },
        subscriptionPlan: {
          include: {
            consultantProfile: {
              include: { user: { select: { email: true, name: true } } },
            },
          },
        },
      },
      // #1423 — this arm is now one transaction per subscription rather than a
      // single bulk statement, so it takes the same per-run cap and
      // oldest-first drain as every other cohort in this file.
      orderBy: { requestedAt: "asc" },
      take: limits.maxRequests,
    });
    warnIfCapped("subscription", staleSubscriptions.length, limits);

    console.log(
      `Found ${staleSubscriptions.length} subscriptions in PENDING for >${PENDING_EXPIRATION_DAYS} days`,
    );

    for (const subscription of staleSubscriptions) {
      console.log(`\nExpiring subscription ${subscription.id}`);
      console.log(
        `   Requested by: ${subscription.requestedBy.user.name || "Unknown"}`,
      );
      console.log(
        `   Consultant: ${subscription.subscriptionPlan.consultantProfile.user.name || "Unknown"}`,
      );
      console.log(`   Requested at: ${subscription.requestedAt.toISOString()}`);
    }

    // #1423 — the write used to re-run the 30-day predicate instead of naming
    // the rows the read returned, so the expired set and the refunded set were
    // different sets: a subscription that crossed the cutoff between the read
    // and the write was expired here, left out of refundPaymentsForExpired
    // below, and never seen again (the next run reads PENDING only) — paid,
    // expired, silently unrefunded. It also bypassed
    // transitionSubscriptionRequest, so no bookingStatusHistory row was
    // written for the expiry. Each row now moves through the CAS helper by id,
    // and only the ids the helper actually transitioned are refunded.
    const expiredIds: string[] = [];
    let skipped = 0;
    for (const subscription of staleSubscriptions) {
      try {
        await prisma.$transaction((tx) =>
          transitionSubscriptionRequest(tx, {
            // The cutoff and the proposal guard are repeated here because both
            // must still hold at write time (doctrine rule 1).
            where: {
              id: subscription.id,
              requestedAt: { lt: expirationDate },
              ...noLiveProposal(),
              NOT: HAS_SUCCEEDED_PAYMENT,
            },
            to: AppointmentStatus.EXPIRED,
            // Deliberate subset of REQUEST_ALLOWED_FROM.EXPIRED: this cohort
            // owns the PENDING cutoff only.
            fromIn: [AppointmentStatus.PENDING],
            actorUserId: null,
            reason: `Auto-expired: PENDING for more than ${PENDING_EXPIRATION_DAYS} days`,
          }),
        );
        expiredIds.push(subscription.id);
      } catch (error) {
        if (!(error instanceof IllegalTransitionError)) throw error;
        skipped++;
      }
    }

    console.log(
      `✅ Expired ${expiredIds.length} PENDING subscriptions` +
        (skipped > 0 ? ` (${skipped} moved on before the write)` : ""),
    );

    const refunds = await refundPaymentsForExpired(
      "pending-subscription",
      expiredIds,
    );
    errors.push(...refunds.failureMsgs);

    return {
      expired: expiredIds.length,
      issued: refunds.issued,
      failures: refunds.failures,
      errors,
    };
  } catch (error) {
    const msg = `Failed to expire subscriptions: ${error}`;
    console.error(`❌ ${msg}`);
    errors.push(msg);
    return { expired: 0, issued: 0, failures: 0, errors };
  }
}

/**
 * PR 2c money fix — the IMMORTAL cohort (audit gap #3): PAID subscriptions
 * whose consultant never allocated a single session. APPROVED was not in
 * EXPIRED's allowed-from and no sweep covered it, so a buyer could stay paid-
 * with-nothing forever. Cohort narrowed to APPROVED with ZERO live confirmed
 * slots (a booking mid-allocation is untouched); expiry refunds via the
 * front door. REQUEST_ALLOWED_FROM.EXPIRED was widened to APPROVED to make
 * this transition legal (lib/booking/transitions.ts).
 */
/**
 * PR 2e (#1192) — release tentative-RESCHEDULED slots on APPROVED
 * subscriptions past the same 30-day window as PENDING expiry. A partial
 * reschedule flips released slots to tentative+RESCHEDULED but leaves the
 * parent APPROVED with no transition edge back — so without this cleanup,
 * those ghost holds block availability forever.
 *
 * Scoped to isTentative AND completionStatus RESCHEDULED so confirmed and
 * SCHEDULED rows are never touched. The parent subscription is NOT expired
 * (it has live confirmed sessions).
 */
const STALE_RESCHEDULED_HOURS = PENDING_EXPIRATION_DAYS * 24;

async function releaseStaleRescheduledSlots(
  limits: StaleRequestRunLimits,
): Promise<{
  released: number;
  errors: string[];
}> {
  try {
    const cutoff = new Date(
      Date.now() - STALE_RESCHEDULED_HOURS * 60 * 60 * 1000,
    );
    const staleRescheduled = {
      isTentative: true as const,
      deletedAt: null,
      updatedAt: { lt: cutoff },
      appointment: {
        subscriptionId: { not: null },
        subscription: { status: AppointmentStatus.APPROVED },
      },
    };
    // Bounded, oldest first, released in chunked transactions; the CAS
    // re-states the cohort's guards on every chunk.
    const stale = await prisma.appointmentOccurrence.findMany({
      where: {
        ...staleRescheduled,
        completionStatus: OccurrenceCompletionStatus.RESCHEDULED,
      },
      select: { id: true },
      orderBy: { updatedAt: "asc" },
      take: limits.maxSlotReleases,
    });
    const released = await transitionSlotsInChunks(
      stale.map((s) => s.id),
      (idChunk) => ({
        where: { id: { in: idChunk }, ...staleRescheduled },
        to: OccurrenceCompletionStatus.CANCELLED,
        data: { deletedAt: new Date() },
        fromIn: [OccurrenceCompletionStatus.RESCHEDULED],
        allowZero: true,
      }),
    );
    console.log(
      `✅ Released ${released} stale RESCHEDULED tentative slots from APPROVED subscriptions`,
    );
    return { released, errors: [] };
  } catch (error) {
    const msg = `Failed to release stale rescheduled slots: ${error}`;
    console.error(`❌ ${msg}`);
    return { released: 0, errors: [msg] };
  }
}

// #1589 N-P0-03 — what a consultee notice names, read with the cohort so the
// notice can be staged after the CAS commits, as the PENDING arms already do.
const EXPIRY_NOTICE_SELECT = {
  id: true,
  appointment: {
    select: {
      id: true,
      organizationId: true,
      occurrences: {
        where: { deletedAt: null },
        orderBy: { startsAt: "asc" as const },
        take: 1,
        select: { startsAt: true },
      },
    },
  },
  requestedBy: { select: { user: { select: { id: true, name: true } } } },
} as const;
const EXPIRY_NOTICE_PLAN_SELECT = {
  select: {
    title: true,
    consultantProfile: { select: { user: { select: { name: true } } } },
  },
} as const;

type ExpiryNoticeRow = {
  appointment: {
    id: string;
    organizationId: string | null;
    occurrences: { startsAt: Date }[];
  } | null;
  requestedBy: { user: { id: string; name: string | null } } | null;
};
type ExpiryNoticePlan = {
  title: string;
  consultantProfile: { user: { name: string | null } } | null;
} | null;

function expiryNoticeFor(
  kind: "consultation" | "subscription",
  row: ExpiryNoticeRow,
  plan: ExpiryNoticePlan,
  reason: string,
): RequestExpiredNotice | null {
  const consultee = row.requestedBy?.user;
  if (!row.appointment || !consultee) return null;
  return {
    appointmentId: row.appointment.id,
    organizationId: row.appointment.organizationId,
    consulteeUserId: consultee.id,
    consulteeName: consultee.name ?? "Consultee",
    consultantName: plan?.consultantProfile?.user?.name ?? "Consultant",
    planTitle:
      plan?.title ??
      (kind === "consultation" ? "Consultation" : "Subscription"),
    appointmentType: kind === "consultation" ? "CONSULTATION" : "SUBSCRIPTION",
    startsAt: row.appointment.occurrences[0]?.startsAt ?? null,
    reason,
  };
}

async function expireApprovedUnallocatedSubscriptions(
  limits: StaleRequestRunLimits,
): Promise<{
  expired: number;
  issued: number;
  failures: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let legacy: RefundOwedMarker[] = [];
  try {
    legacy = await stageLegacyApprovedUnallocatedRefunds(limits.maxRequests);
  } catch (error) {
    errors.push(
      `Failed to stage legacy approved-unallocated refunds: ${error}`,
    );
  }
  const cutoff = new Date(
    Date.now() - PENDING_EXPIRATION_DAYS * 24 * 60 * 60 * 1000,
  );

  try {
    const stale = await prisma.subscription.findMany({
      where: {
        status: AppointmentStatus.APPROVED,
        updatedAt: { lt: cutoff },
        ...NO_LIVE_SESSION,
      },
      select: {
        ...EXPIRY_NOTICE_SELECT,
        subscriptionPlan: EXPIRY_NOTICE_PLAN_SELECT,
      },
      // Same per-run cap and oldest-first drain as the cohorts above, now that
      // this arm expires one subscription per transaction (#1423).
      orderBy: { updatedAt: "asc" },
      take: limits.maxRequests,
    });
    warnIfCapped("subscription", stale.length, limits);

    if (stale.length === 0) {
      const refunds = await driveExpiredRefunds(legacy);
      errors.push(...refunds.failureMsgs);
      return {
        expired: 0,
        issued: refunds.issued,
        failures: refunds.failures,
        errors,
      };
    }

    console.log(
      `Found ${stale.length} APPROVED subscriptions with zero allocated sessions for >${PENDING_EXPIRATION_DAYS} days`,
    );

    // #1423 — the bulk write bypassed transitionSubscriptionRequest, so a
    // refunded expiry left no bookingStatusHistory row, and `result.count`
    // could fall short of `staleIds` while every read id was refunded anyway —
    // a refund against a subscription this run never expired. Each row now
    // moves through the CAS helper, and the refund is handed exactly the ids
    // the helper transitioned.
    const expiredIds: string[] = [];
    const markers = [...legacy];
    let skipped = 0;
    for (const subscription of stale) {
      try {
        const stagedForOne = await withSerializableRetry(() =>
          prisma.$transaction(
            async (tx) => {
              await transitionSubscriptionRequest(tx, {
                where: {
                  id: subscription.id,
                  updatedAt: { lt: cutoff },
                  ...NO_LIVE_SESSION,
                },
                to: AppointmentStatus.EXPIRED,
                // Deliberate subset of REQUEST_ALLOWED_FROM.EXPIRED: this cohort
                // is the abandoned-APPROVED shape only.
                fromIn: [AppointmentStatus.APPROVED],
                actorUserId: null,
                reason: `Auto-expired: APPROVED with zero allocated sessions for more than ${PENDING_EXPIRATION_DAYS} days`,
              });
              return stageExpiredRefunds(
                tx,
                "approved-unallocated",
                subscription.id,
              );
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
          ),
        );
        expiredIds.push(subscription.id);
        markers.push(...stagedForOne);
        // #1589 N-P0-03 — after the commit: the consultee learns why, and
        // that the refund below follows.
        const notice = expiryNoticeFor(
          "subscription",
          subscription,
          subscription.subscriptionPlan,
          UNSCHEDULED_SUBSCRIPTION_REASON,
        );
        if (notice) await notifyConsulteeRequestExpired(notice);
      } catch (error) {
        if (!(error instanceof IllegalTransitionError)) throw error;
        skipped++;
      }
    }

    console.log(
      `✅ Expired ${expiredIds.length} APPROVED-unallocated subscriptions` +
        (skipped > 0 ? ` (${skipped} moved on before the write)` : ""),
    );

    const refunds = await driveExpiredRefunds(markers);
    errors.push(...refunds.failureMsgs);

    return {
      expired: expiredIds.length,
      issued: refunds.issued,
      failures: refunds.failures,
      errors,
    };
  } catch (error) {
    const msg = `Failed to expire APPROVED-unallocated subscriptions: ${error}`;
    console.error(`❌ ${msg}`);
    errors.push(msg);
    return { expired: 0, issued: 0, failures: 0, errors };
  }
}

/** #1775 C-6 — both parties hear that the unscheduled plan is refunded in full. */
async function stageUnallocatedRefundBell(
  tx: Tx,
  row: {
    id: string;
    requestedBy: { user: { id: string; name: string | null } } | null;
    subscriptionPlan: {
      title: true extends boolean ? string : string;
      consultantProfile: { user: { id: string } };
    };
    appointment: { organizationId: string | null } | null;
  },
) {
  const consulteeId = row.requestedBy?.user.id;
  if (!consulteeId) return { bell: null, emailArgs: null };
  const dashboardUrl = notificationHref(
    row.appointment?.organizationId,
    "appointments",
  );
  const bell = await stageBell(tx, {
    workflowId: NOVU_WORKFLOWS.SUBSCRIPTION_UNALLOCATED_REFUNDED,
    recipients: [consulteeId, row.subscriptionPlan.consultantProfile.user.id],
    payload: {
      planTitle: row.subscriptionPlan.title,
      consulteeName: row.requestedBy?.user.name ?? "The buyer",
      dashboardUrl,
    },
    dedupeKey: `sub-unalloc:${row.id}`,
  });
  return {
    bell,
    emailArgs: {
      appointmentId: row.id,
      userIds: [consulteeId, row.subscriptionPlan.consultantProfile.user.id],
      cancelledBy: "Familiarise",
      reason:
        "Subscription was not scheduled within 48 hours of payment and is being refunded in full.",
      refundText: "A full refund is being processed.",
      refundUserIds: [consulteeId],
      dashboardUrl,
    },
  };
}

const unallocatedRefundKey = (paymentId: string) => `sub-unalloc:${paymentId}`;

const UNALLOCATED_REFUND_REASON =
  "subscription not scheduled within 48 h — automatic full refund";

const unallocatedMarker = (paymentId: string): RefundOwedMarker => ({
  paymentId,
  amountPaise: null,
  key: unallocatedRefundKey(paymentId),
  reason: UNALLOCATED_REFUND_REASON,
});

// Payment status remains SUCCEEDED after refund. Exclude settled obligations
// before the page cap, including zero-paise credit restorations under another key.
function unstampedUnallocatedRefundPredicate(): Prisma.Sql {
  return Prisma.sql`
    p."paymentStatus" = 'SUCCEEDED' AND p."deletedAt" IS NULL
    AND p."refundOwedKey" IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM "Refund" spent
      WHERE spent."dedupeKey" = 'sub-unalloc:' || p.id
        AND spent.status IN ('SUCCEEDED', 'PENDING')
    )
    AND (
      (left(p."paymentIntent", 5) = 'free_' AND NOT EXISTS (
        SELECT 1 FROM "Refund" returned
        WHERE returned."paymentId" = p.id
          AND returned.status IN ('SUCCEEDED', 'PENDING')
      ))
      OR (left(p."paymentIntent", 5) <> 'free_'
        AND ${refundableBalancePaiseSql(Prisma.sql`p.id`, Prisma.sql`p.amount`)} > 0)
    )`;
}

async function stageUnallocatedRefunds(
  tx: Tx,
  paymentIds: readonly string[],
): Promise<RefundOwedMarker[]> {
  const markers = paymentIds.map(unallocatedMarker);
  const stamped = await stampRefundsOwed(tx, markers);
  if (stamped !== markers.length) {
    throw new Error(
      "Unallocated refund marker changed; expiry was rolled back",
    );
  }
  return markers;
}

// Raw SQL uses physical names: Subscription.status maps to requestStatus.
/** Bounded recovery of proven expiry obligations, with no liability age cutoff. */
async function stageLegacyUnallocatedRefunds(
  limit: number,
  pastDeadline: () => boolean,
  subscriptionId?: string,
) {
  return withSerializableRetry(async () => {
    if (pastDeadline()) return { markers: [], hasMore: true };
    return prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT p.id FROM "Payment" p
        JOIN "Appointment" a ON a.id = p."appointmentId"
        JOIN "Subscription" s ON s.id = a."subscriptionId"
        WHERE s."requestStatus" = 'EXPIRED'
          ${subscriptionId ? Prisma.sql`AND s.id = ${subscriptionId}` : Prisma.empty}
          AND ${unstampedUnallocatedRefundPredicate()}
          AND EXISTS (
            SELECT 1 FROM "BookingStatusHistory" h
            WHERE h."entityId" = s.id AND h.entity = 'SUBSCRIPTION'
              AND h.reason = 'UNALLOCATED_48H' AND h."toStatus" = 'EXPIRED'
          )
        ORDER BY p."createdAt" ASC, p.id ASC
        LIMIT ${limit + 1}
      `);
        return {
          markers: await stageUnallocatedRefunds(
            tx,
            rows.slice(0, limit).map((row) => row.id),
          ),
          hasMore: rows.length > limit,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  });
}

/** Retained obligations remain visible even when retired or owned by another refund door. */
async function unallocatedObligationsRemain(
  subscriptionId?: string,
): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT p.id FROM "Payment" p
    JOIN "Appointment" a ON a.id = p."appointmentId"
    JOIN "Subscription" s ON s.id = a."subscriptionId"
    WHERE s."requestStatus" = 'EXPIRED' AND p."paymentStatus" = 'SUCCEEDED'
      ${subscriptionId ? Prisma.sql`AND s.id = ${subscriptionId}` : Prisma.empty}
      AND p."deletedAt" IS NULL AND p."refundOwedKey" IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM "BookingStatusHistory" h
        WHERE h."entityId" = s.id AND h.entity = 'SUBSCRIPTION'
          AND h.reason = 'UNALLOCATED_48H' AND h."toStatus" = 'EXPIRED'
      )
    LIMIT ${1}
  `);
  return rows.length > 0;
}

async function driveUnallocatedRefunds(
  markers: readonly RefundOwedMarker[],
  limit: number,
  pastDeadline: () => boolean,
) {
  const out = {
    issued: 0,
    failures: 0,
    failureMsgs: [] as string[],
    deferred: 0,
  };
  let driven = 0;
  for (const marker of markers) {
    if (driven >= limit || pastDeadline()) {
      out.deferred += 1;
      continue;
    }
    driven += 1;
    const outcome = await driveRefundOwed(marker);
    if (outcome.kind === "refunded") {
      out.issued += 1;
      if (outcome.refund.status === "PENDING") out.deferred += 1;
    } else if (outcome.kind === "failed") {
      out.failures += 1;
      out.failureMsgs.push(
        `Refund failed for payment ${marker.paymentId}: ${outcome.error}`,
      );
    } else if (
      outcome.kind === "blocked" ||
      (outcome.kind === "replayed" && outcome.refund.status === "PENDING")
    ) {
      out.deferred += 1;
    }
  }
  return out;
}

/** #1775 C-3 — the 48 h cohort, re-stated in the CAS WHERE (#1423). */
function unallocatedCohort() {
  const cutoff = new Date(Date.now() - PAID_UNALLOCATED_HOURS * 60 * 60 * 1000);
  return {
    // Narrowest guard last, and every one of them rides the CAS WHERE as well
    // as this read: a booking whose slot was released between the two matches
    // zero rows and is left for the reschedule machine.
    AND: [
      NO_LIVE_SESSION,
      noLiveProposal(),
      paidCapturedBefore(cutoff),
      NO_UNPLACED_SLOT,
    ],
  } satisfies Prisma.SubscriptionWhereInput;
}

const UNALLOCATED_SELECT = {
  ...EXPIRY_NOTICE_SELECT,
  subscriptionPlan: {
    select: {
      title: true,
      consultantProfile: {
        select: { id: true, user: { select: { id: true, name: true } } },
      },
    },
  },
} satisfies Prisma.SubscriptionSelect;

class UnallocatedPaymentCapacityError extends Error {
  constructor(
    readonly kind: "envelope" | "allowance",
    subscriptionId: string,
    limit: number,
  ) {
    super(
      kind === "envelope"
        ? `Unallocated subscription ${subscriptionId} exceeds the payment envelope (${limit}); expiry held`
        : `Unallocated subscription ${subscriptionId} needs a fresh payment allowance`,
    );
  }
}

/** The CAS, refund markers and bell commit together; null when the cohort CAS loses. */
async function expireOneUnallocated(
  subscription: Prisma.SubscriptionGetPayload<{
    select: typeof UNALLOCATED_SELECT;
  }>,
  cohort: ReturnType<typeof unallocatedCohort>,
  paymentLimit: number,
  pastDeadline: () => boolean,
  remainingPaymentAllowance = paymentLimit,
): Promise<RefundOwedMarker[] | null> {
  try {
    const staged = await withSerializableRetry(async () => {
      if (pastDeadline()) return null;
      return prisma.$transaction(
        async (tx) => {
          await transitionSubscriptionRequest(tx, {
            where: { id: subscription.id, ...cohort },
            to: AppointmentStatus.EXPIRED,
            fromIn: [AppointmentStatus.PENDING],
            actorUserId: null,
            reason: "UNALLOCATED_48H",
          });
          const due = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT p.id FROM "Payment" p
        JOIN "Appointment" a ON a.id = p."appointmentId"
        WHERE a."subscriptionId" = ${subscription.id}
          AND ${unstampedUnallocatedRefundPredicate()}
        ORDER BY p."createdAt" ASC, p.id ASC
        LIMIT ${paymentLimit + 1}
      `);
          if (due.length > paymentLimit) {
            throw new UnallocatedPaymentCapacityError(
              "envelope",
              subscription.id,
              paymentLimit,
            );
          }
          if (due.length > remainingPaymentAllowance) {
            throw new UnallocatedPaymentCapacityError(
              "allowance",
              subscription.id,
              remainingPaymentAllowance,
            );
          }
          const markers = await stageUnallocatedRefunds(
            tx,
            due.map((row) => row.id),
          );
          const notice = await stageUnallocatedRefundBell(tx, subscription);
          return { ...notice, markers };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    });
    if (!staged) return null;
    const emailRows = staged?.emailArgs
      ? await stageAppointmentCancelledEmail(prisma, staged.emailArgs).catch(
          (err) => {
            console.error(
              "[expire-stale-requests] unallocated cancellation email stage failed:",
              err,
            );
            return [];
          },
        )
      : [];
    await flushNotificationsAfter(
      {
        bells: [staged?.bell],
        emails: [
          {
            rows: emailRows,
            emailType: "APPOINTMENT_CANCELLED",
          },
        ],
      },
      "expire-stale-requests.unallocated",
    );
    return staged.markers;
  } catch (error) {
    if (!(error instanceof IllegalTransitionError)) throw error;
    return null;
  }
}

/**
 * #1771 K-6 — the 48 h arm for ONE plan, from the ops console: the same
 * cohort CAS, bell and keyed refund, under the sweep's own lock. A plan that
 * already expired UNALLOCATED_48H only retries its refund.
 */
export async function expireUnallocatedPaidSubscriptionForOne(
  subscriptionId: string,
): Promise<{
  expired: boolean;
  issued: number;
  failures: number;
  errors: string[];
  hasMore: boolean;
}> {
  return withCronLock(
    "expire-stale-requests",
    { failMode: "closed" },
    async () => {
      const pastDeadline = startDeadline();
      const cohort = unallocatedCohort();
      const row = await prisma.subscription.findFirst({
        where: {
          id: subscriptionId,
          status: AppointmentStatus.PENDING,
          ...cohort,
        },
        select: UNALLOCATED_SELECT,
      });
      const markers = row
        ? await expireOneUnallocated(
            row,
            cohort,
            DEFAULT_RUN_LIMITS.maxRequests,
            pastDeadline,
          )
        : null;
      const legacy = await stageLegacyUnallocatedRefunds(
        DEFAULT_RUN_LIMITS.maxRequests,
        pastDeadline,
        subscriptionId,
      );
      const persisted = pastDeadline()
        ? []
        : await prisma.payment.findMany({
            where: {
              appointment: {
                subscriptionId,
                subscription: { status: AppointmentStatus.EXPIRED },
                statusHistory: {
                  some: {
                    entity: "SUBSCRIPTION",
                    entityId: subscriptionId,
                    reason: "UNALLOCATED_48H",
                    toStatus: AppointmentStatus.EXPIRED,
                  },
                },
              },
              paymentStatus: PaymentStatus.SUCCEEDED,
              deletedAt: null,
              refundOwedKey: { startsWith: "sub-unalloc:" },
              refundOwedAttempts: { lt: MAX_REFUND_OWED_ATTEMPTS },
            },
            orderBy: [{ refundOwedAt: "asc" }, { id: "asc" }],
            take: DEFAULT_RUN_LIMITS.maxRequests + 1,
            select: REFUND_OWED_SELECT,
          });
      const persistedMarkers = persisted
        .slice(0, DEFAULT_RUN_LIMITS.maxRequests)
        .flatMap((payment) =>
          payment.refundOwedKey === unallocatedRefundKey(payment.id)
            ? (markerFromRow(payment) ?? [])
            : [],
        );
      const refunds = await driveUnallocatedRefunds(
        persistedMarkers,
        DEFAULT_RUN_LIMITS.maxRequests,
        pastDeadline,
      );
      return {
        expired: markers !== null,
        issued: refunds.issued,
        failures: refunds.failures,
        errors: refunds.failureMsgs,
        hasMore:
          legacy.hasMore ||
          refunds.deferred > 0 ||
          refunds.failures > 0 ||
          persisted.length > DEFAULT_RUN_LIMITS.maxRequests ||
          pastDeadline() ||
          (await unallocatedObligationsRemain(subscriptionId)),
      };
    },
  );
}

async function stageFreshUnallocatedRefunds(
  limits: StaleRequestRunLimits,
  cohort: ReturnType<typeof unallocatedCohort>,
  pastDeadline: () => boolean,
) {
  const stale = await prisma.subscription.findMany({
    where: { status: AppointmentStatus.PENDING, ...cohort },
    select: UNALLOCATED_SELECT,
    orderBy: [{ requestedAt: "asc" }, { id: "asc" }],
    take: limits.maxRequests + 1,
  });
  const markers: RefundOwedMarker[] = [];
  const errors: string[] = [];
  const out = {
    expired: 0,
    markers,
    errors,
    hasMore: stale.length > limits.maxRequests,
  };
  let remainingPayments = limits.maxRequests;
  for (const subscription of stale.slice(0, limits.maxRequests)) {
    if (pastDeadline() || remainingPayments === 0) {
      out.hasMore = true;
      break;
    }
    try {
      const stamped = await expireOneUnallocated(
        subscription,
        cohort,
        limits.maxRequests,
        pastDeadline,
        remainingPayments,
      );
      if (stamped !== null) {
        out.expired += 1;
        remainingPayments -= stamped.length;
        out.markers.push(...stamped);
      }
    } catch (error) {
      out.hasMore = true;
      if (
        error instanceof UnallocatedPaymentCapacityError &&
        error.kind === "allowance"
      )
        break;
      out.errors.push(
        `Failed to expire unallocated subscription ${subscription.id}: ${error}`,
      );
    }
  }
  return out;
}

/** Legacy and fresh staging share admission with sequential refund delivery. */
async function expireUnallocatedPaidSubscriptions(
  limits: StaleRequestRunLimits,
) {
  const out = {
    expired: 0,
    issued: 0,
    failures: 0,
    errors: [] as string[],
    hasMore: false,
    deferred: 0,
  };
  // Shared by legacy staging, fresh expiries and inline drives; this is an
  // admission deadline for this family, not cancellation of work in flight.
  const pastDeadline = startDeadline();
  const cohort = unallocatedCohort();
  const markers: RefundOwedMarker[] = [];
  try {
    const legacy = await stageLegacyUnallocatedRefunds(
      limits.maxRequests,
      pastDeadline,
    );
    markers.push(...legacy.markers);
    out.hasMore = legacy.hasMore;
    if (pastDeadline()) {
      out.hasMore = true;
    } else {
      const fresh = await stageFreshUnallocatedRefunds(
        limits,
        cohort,
        pastDeadline,
      );
      out.expired += fresh.expired;
      out.hasMore ||= fresh.hasMore;
      out.errors.push(...fresh.errors);
      markers.push(...fresh.markers);
    }
  } catch (error) {
    out.errors.push(`Failed to stage unallocated refunds: ${error}`);
    out.hasMore = true;
  }
  const refunds = await driveUnallocatedRefunds(
    markers,
    limits.maxRequests,
    pastDeadline,
  );
  out.issued = refunds.issued;
  out.failures = refunds.failures;
  out.deferred = refunds.deferred;
  out.errors.push(...refunds.failureMsgs);
  out.hasMore ||=
    refunds.deferred > 0 || refunds.failures > 0 || pastDeadline();
  if (!out.hasMore) {
    try {
      out.hasMore = await unallocatedObligationsRemain();
    } catch (error) {
      out.errors.push(`Failed to check unallocated refund backlog: ${error}`);
      out.hasMore = true;
    }
  }
  return out;
}

/**
 * #1775 C-4 — the nudge stages, in hours since the plan's capture
 * (`capturedAt ?? createdAt`), inside the 48 h allocate-or-refund window. A
 * row gets the latest stage it has reached and nothing earlier, so a sweep
 * that missed hour 12 sends hour 24 once, not both.
 */
export const SUBSCRIPTION_NUDGE_HOURS = [12, 24, 36] as const;
export type SubscriptionNudgeStage = (typeof SUBSCRIPTION_NUDGE_HOURS)[number];

export function nudgeStageFor(ageMs: number): SubscriptionNudgeStage | null {
  const hours = ageMs / (60 * 60 * 1000);
  let stage: SubscriptionNudgeStage | null = null;
  for (const hour of SUBSCRIPTION_NUDGE_HOURS) {
    if (hours >= hour) stage = hour;
  }
  return stage;
}

/** The outbox key for one subscription's stage; the guard and the trigger share it. */
export function subscriptionNudgeDedupeKey(
  subscriptionId: string,
  stage: SubscriptionNudgeStage,
): string {
  return `subscription-unscheduled:${subscriptionId}:h${stage}`;
}

/**
 * Nudge the consultant of a paid subscription that still has no session
 * times. State-as-outbox (ADR 27): the NotificationOutbox row the bell
 * stages is the claim, keyed on the stage, so a re-run finds it and skips;
 * the email follows the bell and rides its own outbox. Nothing here writes
 * the subscription, so `updatedAt` stays the stable "since payment" clock.
 */
async function nudgeUnscheduledSubscriptions(
  limits: StaleRequestRunLimits,
): Promise<{
  nudged: number;
  errors: string[];
}> {
  const errors: string[] = [];
  const firstStageCutoff = new Date(
    Date.now() - SUBSCRIPTION_NUDGE_HOURS[0] * 60 * 60 * 1000,
  );

  try {
    const waiting = await prisma.subscription.findMany({
      // #1775 C-4 — the 48 h arm's cohort: a paid plan still waiting for cycle 1.
      where: {
        status: AppointmentStatus.PENDING,
        deletedAt: null,
        AND: [
          NO_LIVE_SESSION,
          noLiveProposal(),
          paidCapturedBefore(firstStageCutoff),
        ],
      },
      select: {
        id: true,
        requestedBy: { select: { user: { select: { name: true } } } },
        subscriptionPlan: {
          select: {
            title: true,
            consultantProfile: {
              select: { id: true, user: { select: { id: true } } },
            },
          },
        },
        appointment: {
          select: {
            id: true,
            organizationId: true,
            payment: {
              where: {
                paymentStatus: PaymentStatus.SUCCEEDED,
                deletedAt: null,
              },
              orderBy: { createdAt: "asc" },
              take: 1,
              select: { capturedAt: true, createdAt: true },
            },
          },
        },
      },
      orderBy: { requestedAt: "asc" },
      take: limits.maxRequests,
    });

    const candidates = waiting.flatMap((sub) => {
      const paid = sub.appointment?.payment[0];
      if (!paid) return [];
      const capturedAt = paid.capturedAt ?? paid.createdAt;
      const stage = nudgeStageFor(Date.now() - capturedAt.getTime());
      if (!stage || !sub.appointment) return [];
      const consultantUserId = sub.subscriptionPlan.consultantProfile.user.id;
      const dedupeKey = subscriptionNudgeDedupeKey(sub.id, stage);
      return [
        {
          sub,
          stage,
          consultantUserId,
          dedupeKey,
          transactionId: deriveTransactionId(
            NOVU_WORKFLOWS.NEW_BOOKING_REQUEST,
            [consultantUserId],
            {},
            dedupeKey,
          ),
        },
      ];
    });
    if (candidates.length === 0) return { nudged: 0, errors };

    // Two outboxes, two guards: the bell's NotificationOutbox row and the
    // email's FailedEmail row, so one arm's lapse never silences the other.
    const [bellStaged, emailStaged] = await Promise.all([
      prisma.notificationOutbox
        .findMany({
          where: {
            transactionId: { in: candidates.map((c) => c.transactionId) },
          },
          select: { transactionId: true },
        })
        .then((rows) => new Set(rows.map((row) => row.transactionId))),
      prisma.failedEmail
        .findMany({
          where: {
            emailType: SUBSCRIPTION_UNSCHEDULED_NUDGE_EMAIL_TYPE,
            entityRef: {
              in: candidates.map((c) =>
                unscheduledNudgeEntityRef(c.sub.id, c.stage),
              ),
            },
          },
          select: { entityRef: true },
        })
        .then((rows) => new Set(rows.map((row) => row.entityRef))),
    ]);

    let nudged = 0;
    for (const {
      sub,
      stage,
      consultantUserId,
      dedupeKey,
      transactionId,
    } of candidates) {
      const bellDone = bellStaged.has(transactionId);
      const emailDone = emailStaged.has(
        unscheduledNudgeEntityRef(sub.id, stage),
      );
      if (bellDone && emailDone) continue;
      const appointment = sub.appointment;
      if (!appointment) continue;
      try {
        const consulteeName = sub.requestedBy.user.name ?? "A consultee";
        const planTitle = sub.subscriptionPlan.title;
        const timingsUrl = `${getAppUrl()}/dashboard/consultant/${sub.subscriptionPlan.consultantProfile.id}/appointments/${appointment.id}/timings`;
        if (!bellDone) {
          await notifyUnscheduledSubscriptionNudge(
            consultantUserId,
            {
              ...notificationScope(appointment.organizationId),
              consulteeName,
              planTitle,
              appointmentType: "SUBSCRIPTION",
              dashboardUrl: timingsUrl,
              nudgeHours: stage,
            },
            dedupeKey,
          );
        }
        if (!emailDone) {
          const mailed = await sendUnscheduledSubscriptionNudgeEmail(
            {
              subscriptionId: sub.id,
              consultantUserId,
              consulteeName,
              planTitle,
              nudgeHours: stage,
              timingsUrl,
            },
            EMAIL_BUDGET_MS.JOB,
          );
          // Neither sent nor staged: no row guards it, so say so and let
          // the next run retry the email arm alone.
          if (mailed.failed > 0 && mailed.sent === 0) {
            throw new Error("nudge email neither sent nor staged");
          }
        }
        nudged += 1;
      } catch (error) {
        const msg = `Nudge failed for subscription ${sub.id} (hour ${stage}): ${error}`;
        console.error(`❌ ${msg}`);
        errors.push(msg);
      }
    }
    console.log(`✅ Sent ${nudged} unscheduled-subscription nudges`);
    return { nudged, errors };
  } catch (error) {
    const msg = `Failed to nudge unscheduled subscriptions: ${error}`;
    console.error(`❌ ${msg}`);
    errors.push(msg);
    return { nudged: 0, errors };
  }
}

function warnIfCapped(
  kind: "consultation" | "subscription",
  read: number,
  limits: StaleRequestRunLimits,
) {
  if (read < limits.maxRequests) return;
  console.warn(
    JSON.stringify({
      event: "expire_payment_pending_capped",
      kind,
      cap: limits.maxRequests,
      note: "backlog exceeds one run; the next scheduled run continues",
      timestamp: new Date().toISOString(),
    }),
  );
}

/**
 * Expire requests stuck in APPROVED_PENDING_PAYMENT.
 *
 * This was the counter-example to doctrine rule 1 rather than the pattern: a
 * bare bulk `updateMany` with neither the CAS from-set nor the money
 * predicate, so a capture recovered by `reconcile-payment-status` between the
 * scan and the write — which flips the Payment to SUCCEEDED without touching
 * the request — expired a booking the buyer had paid for, with no audit row
 * to show for it. Each request now moves through its guarded helper in its
 * own transaction; a raced capture matches zero rows and is skipped.
 */
async function expirePaymentPendingRequests(
  limits: StaleRequestRunLimits,
): Promise<{
  consultationsExpired: number;
  subscriptionsExpired: number;
  errors: string[];
}> {
  const errors: string[] = [];
  const expirationDate = new Date(
    Date.now() - PAYMENT_PENDING_EXPIRATION_DAYS * 24 * 60 * 60 * 1000,
  );

  // The money predicate is repeated in the lapse core's CAS WHERE, so these
  // read filters are an optimisation rather than the guard.
  const UNPAID_CONSULTATION = {
    appointment: {
      payment: { none: { paymentStatus: PaymentStatus.SUCCEEDED } },
    },
  };
  // #1554 — one wrapper per subscription, or none yet: either way no paid
  // payment hangs off it. The money predicate is repeated in the CAS WHERE.
  const UNPAID_SUBSCRIPTION = {
    OR: [
      { appointment: null },
      {
        appointment: {
          payment: { none: { paymentStatus: PaymentStatus.SUCCEEDED } },
        },
      },
    ],
  };

  try {
    const staleConsultations = await prisma.consultation.findMany({
      take: limits.maxRequests,
      orderBy: { updatedAt: "asc" },
      where: {
        status: AppointmentStatus.APPROVED_PENDING_PAYMENT,
        updatedAt: { lt: expirationDate },
        ...UNPAID_CONSULTATION,
      },
      select: {
        ...EXPIRY_NOTICE_SELECT,
        consultationPlan: EXPIRY_NOTICE_PLAN_SELECT,
      },
    });
    warnIfCapped("consultation", staleConsultations.length, limits);

    let consultationsExpired = 0;
    let consultationsSkipped = 0;
    for (const consultation of staleConsultations) {
      // #1775 — the per-row lapse is the shared core the consultant's
      // Withdraw also calls; a lost CAS is `moved: 0`, never a throw.
      const { moved, holdNotices } = await prisma.$transaction(
        (tx) =>
          lapseApprovedRequest(tx, {
            kind: "consultation",
            id: consultation.id,
            reason: "PAYMENT_LAPSED",
            actorUserId: null,
            // Repeat the cohort read's age predicate inside the CAS WHERE: an
            // updatedAt touch between read and write must match zero rows.
            olderThan: expirationDate,
          }),
        SLOT_TRANSITION_TX_OPTIONS,
      );
      if (moved === 0) {
        consultationsSkipped += 1;
        continue;
      }
      consultationsExpired += 1;
      await flushBackupInterestNotices(holdNotices);
      // #1589 N-P0-03 — the fallback lapse notifies like the 24 h sweep.
      const notice = expiryNoticeFor(
        "consultation",
        consultation,
        consultation.consultationPlan,
        PAY_LINK_LAPSED_REASON,
      );
      if (notice) await notifyConsulteeRequestExpired(notice);
    }

    console.log(
      `✅ Expired ${consultationsExpired} consultations awaiting payment` +
        (consultationsSkipped > 0
          ? ` (${consultationsSkipped} skipped — paid or moved on since the read)`
          : ""),
    );

    const staleSubscriptions = await prisma.subscription.findMany({
      take: limits.maxRequests,
      orderBy: { updatedAt: "asc" },
      where: {
        status: AppointmentStatus.APPROVED_PENDING_PAYMENT,
        updatedAt: { lt: expirationDate },
        ...UNPAID_SUBSCRIPTION,
      },
      select: {
        ...EXPIRY_NOTICE_SELECT,
        subscriptionPlan: EXPIRY_NOTICE_PLAN_SELECT,
      },
    });
    warnIfCapped("subscription", staleSubscriptions.length, limits);

    let subscriptionsExpired = 0;
    let subscriptionsSkipped = 0;
    for (const subscription of staleSubscriptions) {
      const { moved, holdNotices } = await prisma.$transaction(
        (tx) =>
          lapseApprovedRequest(tx, {
            kind: "subscription",
            id: subscription.id,
            reason: "PAYMENT_LAPSED",
            actorUserId: null,
            // Repeat the cohort read's age predicate inside the CAS WHERE: an
            // updatedAt touch between read and write must match zero rows.
            olderThan: expirationDate,
          }),
        SLOT_TRANSITION_TX_OPTIONS,
      );
      if (moved === 0) {
        subscriptionsSkipped += 1;
        continue;
      }
      subscriptionsExpired += 1;
      await flushBackupInterestNotices(holdNotices);
      const notice = expiryNoticeFor(
        "subscription",
        subscription,
        subscription.subscriptionPlan,
        PAY_LINK_LAPSED_REASON,
      );
      if (notice) await notifyConsulteeRequestExpired(notice);
    }

    console.log(
      `✅ Expired ${subscriptionsExpired} subscriptions awaiting payment` +
        (subscriptionsSkipped > 0
          ? ` (${subscriptionsSkipped} skipped — paid or moved on since the read)`
          : ""),
    );

    return {
      consultationsExpired,
      subscriptionsExpired,
      errors,
    };
  } catch (error) {
    const msg = `Failed to expire payment pending requests: ${error}`;
    console.error(`❌ ${msg}`);
    errors.push(msg);
    return { consultationsExpired: 0, subscriptionsExpired: 0, errors };
  }
}

/**
 * Main function to expire all stale requests
 */
// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion. #1341 — fail-closed: this sweep refunds SUCCEEDED
// payments through the refund front door, so an unlocked double-run risks a
// double refund; a missed run pages instead.
export async function expireStaleRequests(opts?: {
  limits?: Partial<StaleRequestRunLimits>;
}): Promise<ExpireStaleRequestsResult> {
  const limits: StaleRequestRunLimits = {
    maxRequests: Math.min(
      MAX_REQUESTS_PER_RUN,
      Math.max(
        1,
        Math.floor(opts?.limits?.maxRequests ?? DEFAULT_RUN_LIMITS.maxRequests),
      ),
    ),
    maxSlotReleases:
      opts?.limits?.maxSlotReleases ?? DEFAULT_RUN_LIMITS.maxSlotReleases,
  };
  return withCronLock("expire-stale-requests", { failMode: "closed" }, () =>
    expireStaleRequestsUnlocked(limits),
  );
}

async function expireStaleRequestsUnlocked(
  limits: StaleRequestRunLimits,
): Promise<ExpireStaleRequestsResult> {
  const allErrors: string[] = [];

  console.log("🕐 Starting stale request expiration...");
  console.log(
    `   Per-arm cap: ${limits.maxRequests} request(s), ${limits.maxSlotReleases} slot release(s)`,
  );
  console.log(
    `   Consultation PENDING expiration threshold: ${PENDING_CONSULTATION_EXPIRATION_HOURS}h`,
    `   Subscription PENDING expiration threshold: ${PENDING_EXPIRATION_DAYS} days`,
  );
  console.log(
    `   APPROVED_PENDING_PAYMENT expiration: ${PAYMENT_PENDING_EXPIRATION_DAYS} days`,
  );

  // Expire PENDING consultations
  const consultationResult = await expirePendingConsultations(limits);
  allErrors.push(...consultationResult.errors);

  // Expire PENDING subscriptions
  const subscriptionResult = await expirePendingSubscriptions(limits);
  allErrors.push(...subscriptionResult.errors);

  // Expire APPROVED-unallocated paid subscriptions (PR 2c money fix)
  const approvedUnallocated =
    await expireApprovedUnallocatedSubscriptions(limits);
  allErrors.push(...approvedUnallocated.errors);

  // #1775 C-3 — paid plans the consultant never allocated within 48 h.
  const paidUnallocated = await expireUnallocatedPaidSubscriptions(limits);
  allErrors.push(...paidUnallocated.errors);

  // #1703 — nudge the consultant before that 30-day refund ever fires.
  const nudges = await nudgeUnscheduledSubscriptions(limits);
  allErrors.push(...nudges.errors);

  // Release stale tentative-RESCHEDULED slots on APPROVED subscriptions
  // (PR 2e, #1192 — audit B-P2-02). A partial reschedule flips released
  // slots to tentative+RESCHEDULED but leaves the parent APPROVED; if the
  // consultant never allocates replacements those ghosts block the calendar
  // forever (no sweep cohort covered them). This pass deletes tentative-
  // RESCHEDULED slots past the threshold so the calendar frees up. The
  // parent stays APPROVED (it has confirmed sessions); only the ghosts go.
  const staleRescheduledReleased = await releaseStaleRescheduledSlots(limits);
  allErrors.push(...staleRescheduledReleased.errors);

  // Expire APPROVED_PENDING_PAYMENT requests
  const paymentPendingResult = await expirePaymentPendingRequests(limits);
  allErrors.push(...paymentPendingResult.errors);

  // #1778 — backup interest in a window that has passed can never be booked.
  const backupInterestExpired = await expireBackupInterest()
    .then((r) => r.count)
    .catch((error: unknown) => {
      allErrors.push(`Failed to expire backup interest: ${error}`);
      return 0;
    });
  console.log(`   Backup interest expired: ${backupInterestExpired}`);

  const totalPaymentPending =
    paymentPendingResult.consultationsExpired +
    paymentPendingResult.subscriptionsExpired;

  // Summary
  console.log("\n📊 Stale Request Expiration Summary:");
  console.log(
    `   Consultations expired (PENDING >${PENDING_CONSULTATION_EXPIRATION_HOURS}h): ${consultationResult.expired}`,
  );
  console.log(
    `   Tentative slots released with them: ${consultationResult.slotsReleased}`,
  );
  console.log(
    `   Subscriptions expired (PENDING): ${subscriptionResult.expired}`,
  );
  console.log(
    `   APPROVED-unallocated expired: ${approvedUnallocated.expired}`,
  );
  console.log(
    `   Paid plans unallocated >${PAID_UNALLOCATED_HOURS}h expired: ${paidUnallocated.expired}`,
  );
  console.log(`   Unscheduled-subscription nudges sent: ${nudges.nudged}`);
  console.log(
    `   Refunds issued/failed: ${consultationResult.issued + subscriptionResult.issued + approvedUnallocated.issued + paidUnallocated.issued}/${consultationResult.failures + subscriptionResult.failures + approvedUnallocated.failures + paidUnallocated.failures}`,
  );
  console.log(`   Payment pending expired: ${totalPaymentPending}`);

  if (allErrors.length > 0) {
    console.log("\n⚠️ Errors encountered:");
    allErrors.forEach((e) => console.log(`   - ${e}`));
  }

  return {
    success: allErrors.length === 0,
    consultationsExpired: consultationResult.expired,
    // #1423 — both subscription arms count here. The APPROVED-unallocated arm
    // used to be invisible in this field: the PENDING arm's bulk statement ran
    // unconditionally and its `count` was reported as the whole total, so the
    // summary never matched what the run actually expired.
    subscriptionsExpired:
      subscriptionResult.expired +
      approvedUnallocated.expired +
      paidUnallocated.expired,
    subscriptionNudgesSent: nudges.nudged,
    paymentPendingExpired: totalPaymentPending,
    consultationSlotsReleased: consultationResult.slotsReleased,
    refundsIssued:
      consultationResult.issued +
      subscriptionResult.issued +
      approvedUnallocated.issued +
      paidUnallocated.issued,
    refundFailures:
      consultationResult.failures +
      subscriptionResult.failures +
      approvedUnallocated.failures +
      paidUnallocated.failures,
    errors: allErrors,
    unallocatedHasMore: paidUnallocated.hasMore,
    unallocatedRefundsDeferred: paidUnallocated.deferred,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Disconnect from database - call this when done
 */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
