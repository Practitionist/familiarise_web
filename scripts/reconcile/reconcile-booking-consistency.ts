/**
 * Booking consistency detector — READ-ONLY.
 *
 * One class of inconsistency, and a note on the two that were asked for and
 * deliberately NOT built, because the schema makes them unrepresentable. That
 * note is the finding; a detector for an impossible state is a detector that
 * only ever produces false confidence.
 *
 *   BUILT — PAID_WITHOUT_LIVE_SEAT: a SUCCEEDED payment on a webinar/class
 *   appointment whose payer holds no live `AppointmentParticipant` row.
 *
 * ## The two that are not built, and why
 *
 * **Double charge.** Every shape of it is blocked by a unique index, not by a
 * missing check:
 *
 *   - `Payment @@unique([userId, appointmentId])` — one user, one Payment per
 *     appointment. Two charges for one order cannot both exist.
 *   - `Payment.paymentIntent @unique` — the gateway ORDER id. Two Payment rows
 *     cannot describe one order.
 *   - `Payment.gatewayPaymentId @unique` — a second Payment can never claim the
 *     same gateway capture.
 *   - `Payment.clientIdempotencyKey @unique` — one key per logical checkout
 *     attempt, which is the race-proof dedupe for a double-submit.
 *   - `Appointment.webinarId @unique` and `Appointment.classId @unique` — ONE
 *     appointment per event. So the "same buyer on two bookings of one
 *     webinar" shape is also impossible, which is the variant that WOULD have
 *     been expressible had the appointment-per-event constraint not been there.
 *
 *   The legitimate shape the brief anticipated — two DIFFERENT users paying for
 *   one shared webinar/class appointment — is the product working, and any
 *   predicate written to catch it would fire on every multi-attendee event.
 *
 *   A double-submit that slipped past all of the above would have to arrive as
 *   two Payments with two distinct gateway order ids, i.e. two distinct
 *   checkout attempts, which is a checkout-conversion bug rather than a
 *   reconciliation gap. The webhook's `gatewayPaymentId` unique is what stops
 *   it, and a P2002 there is already a loud failure.
 *
 * **Missing Stream provisioning.** A `Meeting` row is minted LAZILY, on first
 * join: `createOrGetStreamSession` → `createDbMeeting` in
 * actions/stream/meetings/meeting.action.ts. There is no confirmation-time
 * provisioning step to have failed, so "a confirmed booking with no `Meeting`
 * row" is the expected steady state for every future booking and its absence
 * carries no information. A detector would fire on essentially every row it
 * read. `reconcile-orphaned-sessions` (closes meetings whose session ended) and
 * `reconcile-orphaned-confirmations` (repairs a missing chat channel) are not
 * silent on this by accident — they operate on rows that DO exist, because the
 * thing that can go missing is the channel or the session, not the meeting.
 *
 * ## Why this one IS buildable, and what it catches that nothing else does
 *
 * The capture webhook handles the live version of this inline: if the seat is
 * missing or already released at capture time, `reportUnseatedCapture` writes a
 * deduped `SystemEvent` and the payment is auto-refunded in the same pass.
 * That covers the seat being gone BEFORE the money landed.
 *
 * What it cannot cover is the seat being gone AFTER: a payment that captured
 * cleanly against a live seat and then lost it — a reschedule releasing the
 * seat in place (#1192), the tentative-occurrence sweeper tombstoning the slot,
 * a cancellation racing a late capture — where the refund either never ran or
 * failed and was never retried. Every one of those leaves a customer who paid,
 * holds no seat, and has no complaint route, because from the outside the
 * booking looks complete. Nothing looked for it.
 *
 * ## Read-only, like its sibling
 *
 * `reconcile-ledgers.ts` states it in its own header and this file holds to
 * it: no `create`/`update`/`delete` on any audited table, ever. The ONLY rows
 * written are `SystemEvent` rows describing what was found, deduped on
 * `correlationId` so a nightly re-run does not pile up. That is the same
 * posture `reconcile-occurrence-availability` and the webhook's
 * `reportUnseatedCapture` take, and it is what makes the job safe on a cadence:
 * a detector that mutates can turn a false positive into data damage.
 */

import prisma from "@/lib/prisma";
import { PaymentStatus, type Prisma } from "@prisma/client";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { recordSystemEventSafe } from "@/lib/enterprise/system-events";
import { reportSentryMessage } from "@/lib/observability/report";
import { LIVE_PARTICIPANT_STATUSES } from "@/lib/booking/participants";

/**
 * How far back the detector looks.
 *
 * Bounded on purpose: the predicate joins `Payment` to
 * `AppointmentParticipant` through an appointment and is not index-backed end
 * to end. A window wider than the longest plausible time for the condition to
 * go unresolved buys nothing — an unresolved row is remediated or still
 * unresolved, and a re-run finds it either way.
 */
const LOOKBACK_DAYS = 30;

/** Rows read per run, so one bad day cannot become an unbounded pass. */
const MAX_PAYMENTS_PER_RUN = 500;

export type FindingKind = "PAID_WITHOUT_LIVE_SEAT";

export interface BookingConsistencyFinding {
  kind: FindingKind;
  /** The payer who holds no seat. */
  userId: string;
  eventId: string | null;
  paymentId: string;
  appointmentId: string;
  /** What is still owed: the captured amount less any successful refund. */
  outstandingPaise: number;
  detail: Record<string, unknown>;
}

export interface ReconcileBookingConsistencyResult {
  success: boolean;
  paymentsChecked: number;
  paidWithoutLiveSeat: number;
  /** Rows written this run; a re-run over the same findings writes none. */
  newlyRecorded: number;
  findings: BookingConsistencyFinding[];
  errors: string[];
  timestamp: string;
}

/** The `SystemEvent.category` every row from this job is filed under. */
const EVENT_CATEGORY = "BOOKING";

/** Only these two seat many simultaneous payers, so only these two have a roster. */
const SHARED_EVENT_TYPES = ["WEBINAR", "CLASS"] as const;

/**
 * A SUCCEEDED, undeleted payment — the same predicate every other money sweep
 * uses. `deletedAt` matters: a soft-deleted payment is a row under
 * investigation, not money a customer is holding.
 */
const CHARGED: Prisma.PaymentWhereInput = {
  paymentStatus: PaymentStatus.SUCCEEDED,
  deletedAt: null,
};

/**
 * A refund that will have given the money back, or is on its way to.
 * FAILED/CANCELLED rows never will; PENDING counts deliberately, because a
 * customer whose refund is still in flight at the gateway is not an
 * unreconciled capture, and reporting one would page an operator on every
 * in-flight refund in the system. `deletedAt` for the same reason `CHARGED`
 * carries it: a tombstoned refund is a row under investigation, not one that
 * settled.
 */
const EFFECTIVE_REFUND: Prisma.RefundWhereInput = {
  status: { notIn: ["FAILED", "CANCELLED"] },
  deletedAt: null,
};

/**
 * One durable row per finding, deduped on a stable key.
 *
 * Stable rather than run-scoped on purpose: the condition is a persistent
 * inconsistency, not an event, so a nightly re-run must not mint a fresh row
 * for the same unresolved payment every night. The key is built from the
 * identifiers that DEFINE the finding, so a genuine second occurrence — a
 * different payment — still gets its own row.
 */
async function recordFinding(
  finding: BookingConsistencyFinding,
): Promise<boolean> {
  const correlationId = `booking-consistency:${finding.kind}:${finding.paymentId}`;
  const seen = await prisma.systemEvent.findFirst({
    where: { correlationId, category: EVENT_CATEGORY },
    select: { id: true },
  });
  if (seen) return false;

  await recordSystemEventSafe({
    category: EVENT_CATEGORY,
    // WARN, not ERROR: nothing is moving here and no money has left the
    // company. This is a customer-affecting inconsistency that needs a human to
    // choose between a refund and a roster write, which is the same class as
    // the webhook's own unseated-capture report and is deliberately one level
    // below it.
    severity: "WARN",
    message:
      `Payment ${finding.paymentId} is SUCCEEDED but its payer holds no live seat on the booking — ` +
      `charged ${finding.outstandingPaise} paise and not seated`,
    context: {
      userId: finding.userId,
      eventId: finding.eventId,
      paymentId: finding.paymentId,
      appointmentId: finding.appointmentId,
      outstandingPaise: finding.outstandingPaise,
      ...finding.detail,
    },
    correlationId,
  });
  return true;
}

async function detectPaidWithoutLiveSeat(windowStart: Date): Promise<{
  findings: BookingConsistencyFinding[];
  paymentsChecked: number;
}> {
  const charged = await prisma.payment.findMany({
    where: {
      ...CHARGED,
      createdAt: { gte: windowStart },
      appointment: {
        appointmentType: { in: [...SHARED_EVENT_TYPES] },
      },
    },
    select: {
      id: true,
      amount: true,
      userId: true,
      appointmentId: true,
      // Surfaces in the finding as `capturedAt`. Listed explicitly because a
      // `select` DROPS an unlisted field from the result type rather than
      // leaving it readable — there is no implicit fallback.
      createdAt: true,
      appointment: {
        select: {
          id: true,
          appointmentType: true,
          webinarId: true,
          classId: true,
        },
      },
      refunds: {
        where: EFFECTIVE_REFUND,
        // `amountPaise`, not `amount` — Refund carries the unit in the column
        // name (Payment is the one with a bare `amount`). Naming it wrong fails
        // the whole `findMany` argument, and Prisma then infers the
        // un-`select`ed Payment payload for the loop below, which surfaces as a
        // pile of unrelated "appointment / refunds does not exist" errors rather
        // than one honest complaint about this line.
        select: { amountPaise: true },
      },
    },
    // Newest first: a recent capture is the one most likely still to be
    // mid-flight (a late refund retry is queued behind it), and an old
    // unresolved row is by definition not getting any younger.
    orderBy: { createdAt: "desc" },
    take: MAX_PAYMENTS_PER_RUN,
  });

  const findings: BookingConsistencyFinding[] = [];
  let paymentsChecked = 0;

  for (const payment of charged) {
    // An appointment with no event relation behind it is a data shape this
    // predicate does not claim to understand; skipping beats guessing.
    if (!payment.appointment || !payment.appointmentId) continue;
    paymentsChecked += 1;

    // A full refund closes the question: the customer has their money back and
    // holds no seat, which is correct rather than drift.
    const refunded = payment.refunds.reduce(
      (sum, r) => sum + Number(r.amountPaise),
      0,
    );
    const outstanding = Number(payment.amount) - refunded;
    if (outstanding <= 0) continue;

    const seat = await prisma.appointmentParticipant.findUnique({
      where: {
        appointmentId_userId: {
          appointmentId: payment.appointmentId,
          userId: payment.userId,
        },
      },
      select: { status: true },
    });
    // A live seat is the whole condition, negated.
    if (seat && LIVE_PARTICIPANT_STATUSES.includes(seat.status)) continue;

    findings.push({
      kind: "PAID_WITHOUT_LIVE_SEAT",
      userId: payment.userId,
      eventId: payment.appointment.webinarId ?? payment.appointment.classId,
      paymentId: payment.id,
      appointmentId: payment.appointment.id,
      outstandingPaise: outstanding,
      detail: {
        appointmentType: payment.appointment.appointmentType,
        // null is itself the signal: "no participant row exists" and "the seat
        // was released" are different bugs with different fixes, and the
        // operator needs to know which one they are looking at.
        seatStatus: seat?.status ?? null,
        refundedPaise: refunded,
        capturedAt: payment.createdAt.toISOString(),
      },
    });
  }

  return { findings, paymentsChecked };
}

// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion. Fail-OPEN on purpose, and the reason is specific: a
// detector has no side effect to interleave, so a double-run under a Redis
// outage costs a few duplicate reads, while fail-closed would mean a Redis
// blip silently stops the fleet from looking for a customer who was charged and
// has no seat. Same reasoning as `stream-webhook-drift` in the lock registry's
// exemption list, applied here without needing the exemption.
export async function reconcileBookingConsistency(): Promise<ReconcileBookingConsistencyResult> {
  return withCronLock(
    "reconcile-booking-consistency",
    { failMode: "open" },
    () => reconcileBookingConsistencyUnlocked(),
  );
}

async function reconcileBookingConsistencyUnlocked(): Promise<ReconcileBookingConsistencyResult> {
  const errors: string[] = [];
  const windowStart = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  let findings: BookingConsistencyFinding[] = [];
  let paymentsChecked = 0;

  console.log("🔎 Starting booking consistency reconcile...");
  console.log(`   Lookback: ${LOOKBACK_DAYS} days`);

  try {
    const detected = await detectPaidWithoutLiveSeat(windowStart);
    findings = detected.findings;
    paymentsChecked = detected.paymentsChecked;
  } catch (error) {
    const msg = `Paid-without-seat detector failed: ${error instanceof Error ? error.message : String(error)}`;
    console.error(`❌ ${msg}`);
    errors.push(msg);
  }

  let newlyRecorded = 0;
  for (const finding of findings) {
    try {
      if (await recordFinding(finding)) newlyRecorded += 1;
    } catch (error) {
      const msg = `Failed to record ${finding.kind} for payment ${finding.paymentId}: ${error instanceof Error ? error.message : String(error)}`;
      console.error(`❌ ${msg}`);
      errors.push(msg);
    }
  }

  if (findings.length > 0) {
    // Fixed message so Sentry groups every night's run into one issue; the
    // detail rides in `extra`, capped. One report per RUN, never per finding —
    // a 50-finding night is one incident, not 50.
    reportSentryMessage(
      "Booking consistency: paid seats disagree with the roster",
      {
        subsystem: "bookings",
        op: "reconcile-booking-consistency",
        level: "warning",
        extra: {
          paidWithoutLiveSeat: findings.length,
          paymentsChecked,
          newlyRecorded,
          // Bounded: an unbounded cohort of ids in an event payload is how a
          // detector becomes the reason Sentry drops the event.
          sample: findings.slice(0, 20).map((f) => ({
            paymentId: f.paymentId,
            userId: f.userId,
            eventId: f.eventId,
            seatStatus: f.detail.seatStatus ?? null,
          })),
        },
      },
    );
  }

  console.log("\n📊 Booking Consistency Summary:");
  console.log(`   Payments checked: ${paymentsChecked}`);
  console.log(`   Paid without a live seat: ${findings.length}`);
  console.log(`   Newly recorded findings: ${newlyRecorded}`);
  if (errors.length > 0) {
    console.log("\n⚠️ Errors:");
    errors.forEach((e) => console.log(`   - ${e}`));
  }

  return {
    // A FINDING is not a failure — the same rule reconcile-occurrence-availability
    // follows, and for the same reason: failing nightly on known rows trains
    // everyone to ignore the job, which is part of how its absence went
    // unnoticed in the first place. Only a real error goes false.
    success: errors.length === 0,
    paymentsChecked,
    paidWithoutLiveSeat: findings.length,
    newlyRecorded,
    findings,
    errors,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Disconnect from database - call this when you're done
 */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
