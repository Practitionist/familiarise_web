/**
 * Stale PENDING Request Expiration - Core Logic
 *
 * Auto-expires consultations and subscriptions stuck in PENDING state for too long.
 * This happens when:
 * - Consultant never responded to a request
 * - Consultee abandoned the request
 * - System error prevented status update
 *
 * This module exports the core expiration function.
 * It is imported by:
 * - jobs/expire-stale-requests.ts (GitHub Actions)
 * - app/api/cleanup/expire-stale-requests/route.ts (API endpoint)
 *
 * Schedule: Hourly (booking-journey audit B1 — a PENDING consultation holds
 * a tentative slot, so the old daily cadence plus a 30-day threshold let a
 * single account pin a consultant's calendar for a month).
 */

import prisma from "../../lib/prisma";
import {
  AppointmentStatus,
  PaymentStatus,
  OccurrenceCompletionStatus,
  Prisma,
} from "@prisma/client";
import { withCronLock } from "@/lib/cron/with-cron-lock";
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
// a booking with a LIVE reschedule proposal (PENDING_REVIEW / COUNTERED) is
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
  timestamp: string;
}

/**
 * Refund every SUCCEEDED payment attached to the given expired engagement's
 * appointments. Booking-journey audit gap #1: the sweep used to flip PAID
 * rows to EXPIRED with no money movement and no trace — buyer paid, got
 * nothing, silence. Every refund goes through the booking front door
 * (doctrine rule 3); failures are counted + logged, never thrown (a cron
 * must drain the cohort even when one gateway call fails).
 */
async function refundPaymentsForExpired(
  kind: "consultation" | "subscription",
  expiredIds: string[],
): Promise<{ issued: number; failures: number; failureMsgs: string[] }> {
  if (expiredIds.length === 0)
    return { issued: 0, failures: 0, failureMsgs: [] };
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

/**
 * Expire stale PENDING consultations and release the tentative slots they
 * pinned. The slot release happens HERE rather than waiting for the
 * tentative-slot sweeper: that sweep's parent guard skips PENDING
 * consultations by design (a consultant may legitimately be reviewing), so
 * before B1 a slot pinned by a stale request waited for the status flip and
 * then another sweeper cycle — 30+ days in the worst case.
 */
async function expirePendingConsultations(): Promise<{
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
        // Never reap a booking whose reschedule proposal is still live.
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
      take: MAX_REQUESTS_PER_RUN,
    });
    warnIfCapped("consultation", staleConsultations.length);

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
    let slotsReleased = 0;
    let skipped = 0;
    for (const stale of staleConsultations) {
      try {
        const releasedForOne = await prisma.$transaction(async (tx) => {
          await transitionConsultationRequest(tx, {
            where: {
              id: stale.id,
              // Repeat the cohort read's age predicate inside the CAS WHERE so
              // a reschedule-refreshed requestedAt between read and write
              // matches zero rows instead of expiring a live request.
              requestedAt: { lt: expirationDate },
              appointment: {
                rescheduleRequests: {
                  none: { status: { in: [...RESCHEDULE_OPEN_STATUSES] } },
                },
              },
            },
            to: AppointmentStatus.EXPIRED,
            fromIn: [AppointmentStatus.PENDING],
          });
          if (!stale.appointment) return 0;
          return transitionOccurrenceCompletion(tx, {
            where: {
              appointmentId: stale.appointment.id,
              isTentative: true,
              deletedAt: null,
            },
            to: OccurrenceCompletionStatus.CANCELLED,
            data: { deletedAt: new Date() },
            allowZero: true,
          });
        }, SLOT_TRANSITION_TX_OPTIONS);
        expiredIds.push(stale.id);
        slotsReleased += releasedForOne;
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
    const refunds = await refundPaymentsForExpired("consultation", expiredIds);
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
async function expirePendingSubscriptions(): Promise<{
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
      take: MAX_REQUESTS_PER_RUN,
    });
    warnIfCapped("subscription", staleSubscriptions.length);

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

    const refunds = await refundPaymentsForExpired("subscription", expiredIds);
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

async function releaseStaleRescheduledSlots(): Promise<{
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
      take: MAX_SLOT_RELEASES_PER_RUN,
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

async function expireApprovedUnallocatedSubscriptions(): Promise<{
  expired: number;
  issued: number;
  failures: number;
  errors: string[];
}> {
  const errors: string[] = [];
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
      take: MAX_REQUESTS_PER_RUN,
    });
    warnIfCapped("subscription", stale.length);

    if (stale.length === 0)
      return { expired: 0, issued: 0, failures: 0, errors };

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
    let skipped = 0;
    for (const subscription of stale) {
      try {
        await prisma.$transaction((tx) =>
          transitionSubscriptionRequest(tx, {
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
          }),
        );
        expiredIds.push(subscription.id);
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

    const refunds = await refundPaymentsForExpired("subscription", expiredIds);
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
  tx: Pick<Tx, "notificationOutbox">,
  row: {
    id: string;
    requestedBy: { user: { id: string; name: string | null } } | null;
    subscriptionPlan: {
      title: string;
      consultantProfile: { user: { id: string } };
    };
    appointment: { organizationId: string | null } | null;
  },
): Promise<void> {
  const consulteeId = row.requestedBy?.user.id;
  if (!consulteeId) return;
  await stageBell(tx, {
    workflowId: NOVU_WORKFLOWS.SUBSCRIPTION_UNALLOCATED_REFUNDED,
    recipients: [consulteeId, row.subscriptionPlan.consultantProfile.user.id],
    payload: {
      planTitle: row.subscriptionPlan.title,
      consulteeName: row.requestedBy?.user.name ?? "The buyer",
      dashboardUrl: notificationHref(
        row.appointment?.organizationId,
        "appointments",
      ),
    },
    dedupeKey: `sub-unalloc:${row.id}`,
  });
}

const unallocatedRefundKey = (paymentId: string) => `sub-unalloc:${paymentId}`;

/** Plans expired UNALLOCATED_48H in the last 14 days (the retry cohort). */
async function recentlyUnallocatedSubscriptionIds(): Promise<string[]> {
  const rows = await prisma.bookingStatusHistory.findMany({
    where: {
      entity: "SUBSCRIPTION",
      reason: "UNALLOCATED_48H",
      toStatus: AppointmentStatus.EXPIRED,
      createdAt: { gte: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) },
    },
    select: { entityId: true },
    take: MAX_REQUESTS_PER_RUN,
  });
  return rows?.map((r) => r.entityId) ?? [];
}

/**
 * #1775 C-3 — the full refund of each expired plan's SUCCEEDED payment,
 * keyed `sub-unalloc:<paymentId>`: a key already spent is skipped, so a retry
 * never refunds twice. Failures are counted, never thrown.
 */
async function refundUnallocatedPlans(subscriptionIds: string[]) {
  const out = { issued: 0, failures: 0, failureMsgs: [] as string[] };
  if (subscriptionIds.length === 0) return out;
  const payments = await prisma.payment.findMany({
    where: {
      appointment: { subscriptionId: { in: subscriptionIds } },
      paymentStatus: PaymentStatus.SUCCEEDED,
      deletedAt: null,
    },
    select: { id: true },
  });
  const spent = new Set(
    (
      await prisma.refund.findMany({
        where: {
          dedupeKey: { in: payments.map((p) => unallocatedRefundKey(p.id)) },
          status: { notIn: ["FAILED", "CANCELLED"] },
        },
        select: { dedupeKey: true },
      })
    ).map((r) => r.dedupeKey),
  );
  for (const payment of payments) {
    const dedupeKey = unallocatedRefundKey(payment.id);
    if (spent.has(dedupeKey)) continue;
    try {
      await refundBookingPayment({
        paymentId: payment.id,
        reason:
          "subscription not scheduled within 48 h — automatic full refund",
        initiatedByUserId: null,
        dedupeKey,
      });
      out.issued += 1;
    } catch (err) {
      out.failures += 1;
      out.failureMsgs.push(`Refund failed for payment ${payment.id}: ${err}`);
    }
  }
  return out;
}

/** #1775 C-3 — the 48 h cohort, re-stated in the CAS WHERE (#1423). */
function unallocatedCohort() {
  const cutoff = new Date(Date.now() - PAID_UNALLOCATED_HOURS * 60 * 60 * 1000);
  return {
    AND: [NO_LIVE_SESSION, noLiveProposal(), paidCapturedBefore(cutoff)],
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

/** The CAS and its bell for one plan; false when the plan left the cohort. */
async function expireOneUnallocated(
  subscription: Prisma.SubscriptionGetPayload<{
    select: typeof UNALLOCATED_SELECT;
  }>,
  cohort: ReturnType<typeof unallocatedCohort>,
): Promise<boolean> {
  try {
    await prisma.$transaction(async (tx) => {
      await transitionSubscriptionRequest(tx, {
        where: { id: subscription.id, ...cohort },
        to: AppointmentStatus.EXPIRED,
        fromIn: [AppointmentStatus.PENDING],
        actorUserId: null,
        reason: "UNALLOCATED_48H",
      });
      // #1775 C-6 — the bell rides the CAS: a lost race stages nothing.
      await stageUnallocatedRefundBell(tx, subscription);
    });
    return true;
  } catch (error) {
    if (!(error instanceof IllegalTransitionError)) throw error;
    return false;
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
}> {
  return withCronLock(
    "expire-stale-requests",
    { failMode: "closed" },
    async () => {
      const cohort = unallocatedCohort();
      const row = await prisma.subscription.findFirst({
        where: {
          id: subscriptionId,
          status: AppointmentStatus.PENDING,
          ...cohort,
        },
        select: UNALLOCATED_SELECT,
      });
      const expired = row ? await expireOneUnallocated(row, cohort) : false;
      const history = expired
        ? null
        : await prisma.bookingStatusHistory.findFirst({
            where: {
              entity: "SUBSCRIPTION",
              entityId: subscriptionId,
              reason: "UNALLOCATED_48H",
              toStatus: AppointmentStatus.EXPIRED,
            },
            select: { id: true },
          });
      if (!expired && !history) {
        return { expired: false, issued: 0, failures: 0, errors: [] };
      }
      const refunds = await refundUnallocatedPlans([subscriptionId]);
      return {
        expired,
        issued: refunds.issued,
        failures: refunds.failures,
        errors: refunds.failureMsgs,
      };
    },
  );
}

/**
 * #1775 C-3 — a paid plan (PENDING, SUCCEEDED payment captured more than 48 h
 * ago) with no live session and no live proposal expires with reason
 * UNALLOCATED_48H and is refunded in full through the front door. Failure
 * matrix: allocation first → the cohort CAS matches 0 rows; sweep first → the
 * allocation's PENDING→APPROVED CAS rolls back (409 to the consultant).
 */
async function expireUnallocatedPaidSubscriptions(): Promise<{
  expired: number;
  issued: number;
  failures: number;
  errors: string[];
}> {
  const errors: string[] = [];
  const cohort = unallocatedCohort();
  try {
    const stale = await prisma.subscription.findMany({
      where: { status: AppointmentStatus.PENDING, ...cohort },
      select: UNALLOCATED_SELECT,
      orderBy: { requestedAt: "asc" },
      take: MAX_REQUESTS_PER_RUN,
    });
    warnIfCapped("subscription", stale.length);

    const expiredIds: string[] = [];
    for (const subscription of stale) {
      if (await expireOneUnallocated(subscription, cohort)) {
        expiredIds.push(subscription.id);
      }
    }

    // Keyed per payment, and retried from the history for a refund that
    // failed after an earlier run's CAS (the row is EXPIRED by then).
    const retry = await recentlyUnallocatedSubscriptionIds();
    const refunds = await refundUnallocatedPlans([
      ...new Set([...expiredIds, ...retry]),
    ]);
    errors.push(...refunds.failureMsgs);
    return {
      expired: expiredIds.length,
      issued: refunds.issued,
      failures: refunds.failures,
      errors,
    };
  } catch (error) {
    const msg = `Failed to expire unallocated paid subscriptions: ${error}`;
    console.error(`❌ ${msg}`);
    errors.push(msg);
    return { expired: 0, issued: 0, failures: 0, errors };
  }
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
async function nudgeUnscheduledSubscriptions(): Promise<{
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
      take: MAX_REQUESTS_PER_RUN,
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

function warnIfCapped(kind: "consultation" | "subscription", read: number) {
  if (read < MAX_REQUESTS_PER_RUN) return;
  console.warn(
    JSON.stringify({
      event: "expire_payment_pending_capped",
      kind,
      cap: MAX_REQUESTS_PER_RUN,
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
async function expirePaymentPendingRequests(): Promise<{
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
      take: MAX_REQUESTS_PER_RUN,
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
    warnIfCapped("consultation", staleConsultations.length);

    let consultationsExpired = 0;
    let consultationsSkipped = 0;
    for (const consultation of staleConsultations) {
      // #1775 — the per-row lapse is the shared core the consultant's
      // Withdraw also calls; a lost CAS is `moved: 0`, never a throw.
      const { moved } = await prisma.$transaction(
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
      take: MAX_REQUESTS_PER_RUN,
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
    warnIfCapped("subscription", staleSubscriptions.length);

    let subscriptionsExpired = 0;
    let subscriptionsSkipped = 0;
    for (const subscription of staleSubscriptions) {
      const { moved } = await prisma.$transaction(
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
export async function expireStaleRequests(): Promise<ExpireStaleRequestsResult> {
  return withCronLock("expire-stale-requests", { failMode: "closed" }, () =>
    expireStaleRequestsUnlocked(),
  );
}

async function expireStaleRequestsUnlocked(): Promise<ExpireStaleRequestsResult> {
  const allErrors: string[] = [];

  console.log("🕐 Starting stale request expiration...");
  console.log(
    `   Consultation PENDING expiration threshold: ${PENDING_CONSULTATION_EXPIRATION_HOURS}h`,
    `   Subscription PENDING expiration threshold: ${PENDING_EXPIRATION_DAYS} days`,
  );
  console.log(
    `   APPROVED_PENDING_PAYMENT expiration: ${PAYMENT_PENDING_EXPIRATION_DAYS} days`,
  );

  // Expire PENDING consultations
  const consultationResult = await expirePendingConsultations();
  allErrors.push(...consultationResult.errors);

  // Expire PENDING subscriptions
  const subscriptionResult = await expirePendingSubscriptions();
  allErrors.push(...subscriptionResult.errors);

  // Expire APPROVED-unallocated paid subscriptions (PR 2c money fix)
  const approvedUnallocated = await expireApprovedUnallocatedSubscriptions();
  allErrors.push(...approvedUnallocated.errors);

  // #1775 C-3 — paid plans the consultant never allocated within 48 h.
  const paidUnallocated = await expireUnallocatedPaidSubscriptions();
  allErrors.push(...paidUnallocated.errors);

  // #1703 — nudge the consultant before that 30-day refund ever fires.
  const nudges = await nudgeUnscheduledSubscriptions();
  allErrors.push(...nudges.errors);

  // Release stale tentative-RESCHEDULED slots on APPROVED subscriptions
  // (PR 2e, #1192 — audit B-P2-02). A partial reschedule flips released
  // slots to tentative+RESCHEDULED but leaves the parent APPROVED; if the
  // consultant never allocates replacements those ghosts block the calendar
  // forever (no sweep cohort covered them). This pass deletes tentative-
  // RESCHEDULED slots past the threshold so the calendar frees up. The
  // parent stays APPROVED (it has confirmed sessions); only the ghosts go.
  const staleRescheduledReleased = await releaseStaleRescheduledSlots();
  allErrors.push(...staleRescheduledReleased.errors);

  // Expire APPROVED_PENDING_PAYMENT requests
  const paymentPendingResult = await expirePaymentPendingRequests();
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
    timestamp: new Date().toISOString(),
  };
}

/**
 * Disconnect from database - call this when done
 */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
