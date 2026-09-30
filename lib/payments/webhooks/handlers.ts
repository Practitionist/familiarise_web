/**
 * Payment Webhook Handlers
 * Core business logic for processing payment events
 * Can be used by both webhook API routes and direct checkout flows
 */

import {
  reportSentryError,
  reportSentryMessage,
} from "@/lib/observability/report";
import {
  liveParticipant,
  recordParticipants,
  transitionParticipant,
  RELEASED_PARTICIPANT_STATUSES,
} from "@/lib/booking/participants";
import { markBackupInterestBooked } from "@/lib/booking/backup-interest";
import prisma, { type Tx } from "@/lib/prisma";
import { collaboratorUserIds } from "@/lib/collaborators/recipients";
import {
  AppointmentsType,
  PaymentStatus,
  Prisma,
  AppointmentStatus,
  OccurrenceCompletionStatus,
  TrialStatus,
} from "@prisma/client";
import { firstCycleWindow } from "@/lib/booking/entitlement";
import {
  buildDeadHoldFilter,
  buildOccupiedAppointmentFilter,
} from "@/utils/scheduling-engine/occupancyPolicy";
import {
  REQUEST_ALLOWED_FROM,
  appendCreationHistory,
  transitionClassEvent,
  transitionConsultationRequest,
  transitionOccurrenceCompletion,
  transitionSubscriptionRequest,
  transitionTrial,
  transitionWebinarEvent,
} from "@/lib/booking/transitions";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import { isExclusionViolation } from "@/lib/db/pg-errors";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { resolveSchedulingTimezone } from "@/lib/scheduling/schedulingTimezone";
import {
  buildOccurrenceForWindow,
  liveOccurrenceWhere,
} from "@/lib/appointments/occurrences";
import {
  recordSystemError,
  recordSystemErrorSafe,
} from "@/lib/enterprise/system-events";
import { refundPayment } from "@/lib/payments/operations/refund";
import { refundBookingPayment } from "@/lib/payments/operations/booking-refund";
import { refundRemovedAttendeeSeat } from "@/lib/payments/operations/event-refunds";
import {
  getClassCapacity,
  getWebinarCapacity,
} from "@/lib/events/capacity";
import {
  AUTO_REFUND_PENDING_PREFIX,
  DOUBLE_BOOKING_BLOCKED_NOTE,
  autoRefundPendingDescription,
  settledAutoRefundDescription,
} from "@/lib/payments/webhooks/auto-refund-marker";
import { mintConsumerInvoiceBestEffort } from "@/lib/payments/billing/consumer-invoice";
import {
  normalizeLegacySlotKeys,
  validateWebhookMetadata,
} from "@/schemas/webhooks/metadata";
import { ZodError } from "zod";
import {
  attempt as attemptEmail,
  attemptStaged,
  EMAIL_BUDGET_MS,
  renderPaymentFailedEmail,
  renderPaymentSuccessEmail,
  stage as stageEmail,
  stageAppointmentBookedEmail,
  type RenderedEmail,
  type StagedEmail,
  type StagedRecipientEmail,
} from "@/lib/email";
import {
  createEarningsFromPayment,
  resolvePaymentForEarnings,
} from "@/lib/payments/payouts";
import {
  attemptTrigger,
  notifyPaymentSuccess,
  notifyPaymentFailed,
  notifyAppointmentBooked,
} from "@/lib/novu";
import { notificationScope } from "@/lib/novu/workflows";
import { notificationHref } from "@/lib/novu/resolve-href";
import { goHref } from "@/lib/dashboard/go";
import { planTitleOrSessionLabel } from "@/lib/novu/humanize";
import {
  processQualifyingAction,
  processConsultantBookingReferral,
} from "@/lib/referrals/service";
import { notifyReferralQualificationBestEffort } from "@/lib/referrals/referral-notify";
import { scheduleAfter } from "@/lib/api/after-safe";
import { ensureChannelsForAppointment } from "@/lib/payments/webhooks/ensure-channels";
import { streamLogger } from "@/lib/stream-logger";
import { getAppUrl } from "@/lib/url";
import {
  isOrgFundedPaymentMethod,
  seatPayerOrganizationId,
} from "@/lib/data/org-sponsored-seats";

// ============================================================================
// Type Definitions
// ============================================================================

// #780/#781 — the extended client converts every BigInt column (and the FX
// Decimal snapshots) to number on read, but GetPayload (incl. nested
// includes) still says bigint/Decimal. Deep-map to match runtime;
// Date/Bytes pass through untouched.
type MoneyAsNumber<T> = T extends bigint
  ? number
  : T extends Prisma.Decimal
    ? number
    : T extends Date | Uint8Array
      ? T
      : T extends Array<infer U>
        ? Array<MoneyAsNumber<U>>
        : T extends object
          ? { [K in keyof T]: MoneyAsNumber<T[K]> }
          : T;

/**
 * Payment type with user and consultee profile included
 * Matches the Prisma query includes used in handlePaymentSuccess
 */
type PaymentWithUser = MoneyAsNumber<
  Prisma.PaymentGetPayload<{
    include: {
      user: {
        include: { consulteeProfile: true };
      };
    };
  }>
>;

/**
 * Data required to create a consultation appointment
 */
interface ConsultationData {
  planId: string;
  startsAt: string;
  endsAt: string;
  notes?: string;
  consulteeProfileId: string;
  userId: string;
}

/**
 * Data required to create a subscription appointment
 */
interface SubscriptionData {
  planId: string;
  startsAt?: string;
  endsAt?: string;
  schedulingPeriodStartsAt?: string;
  schedulingPeriodEndsAt?: string;
  notes?: string;
  consulteeProfileId: string;
  userId: string;
}

/**
 * Data required to create webinar/class appointments
 */
interface EventData {
  eventId: string;
  userId: string;
  /** #1852 — the payer org, stamped on the seat (null for a B2C seat). */
  organizationId: string | null;
}

// ============================================================================
// Payment Success/Failure Handlers
// ============================================================================

/**
 * Handle successful payment - confirms or creates appointments
 *
 * TWO FLOWS SUPPORTED:
 * 1. NEW FLOW (Race Condition Fix): Appointment created during checkout (tentative)
 *    - payment.appointmentId exists
 *    - Just confirm appointment by setting isTentative = false
 *    - This prevents race conditions by making validation see tentative bookings
 *
 * 2. LEGACY FLOW: Appointment NOT created during checkout
 *    - payment.appointmentId is null
 *    - Create appointment from webhook metadata
 *    - Used for backwards compatibility and older payment flows
 *
 * Used by both webhook handlers and mock payment flows
 */
// #837 — discriminated Phase-1 outcomes so Phase 2 can auto-refund the two
// captured-but-blocked cases (amount mismatch, double-booking loser) instead of
// parking the funds on manual ops. `null` = already-processed / metadata-fail.
type PaymentSuccessTxResult =
  | {
      outcome: "amount_mismatch";
      paymentId: string;
      gatewayAmountPaise: number;
      expectedAmount: number;
    }
  | {
      // #1695 — the hold this capture paid for is already gone (the abandoned
      // sweep, a supersede, a `payment.failed`, or the unpaid-trial sweep won);
      // the money is real and the booking is not, so Phase 2 refunds it.
      outcome: "captured_after_release";
      paymentId: string;
      releasedBy: string;
    }
  | {
      outcome: "confirmed";
      paymentId: string;
      appointmentId: string;
      appointmentType: string;
      userId: string;
      userName: string | null;
      amount: number;
      currency: string;
      capturedAfterTerminal: boolean;
      doubleBookingBlocked: boolean;
      // The seat the capture could not confirm, when the booking died under it
      // (a leave that released the row before the money landed). Phase 2 gives
      // the money back through the SEAT front door, which is the only one that
      // knows the org wallet / credit rails; absent, the generic terminal arm
      // runs exactly as before.
      seatRefund: ReleasedSeatRefund | null;
      // #1654 — the receipt row staged inside Phase 1; Phase 2 attempts it.
      successEmail: StagedOutboxEmail | null;
      // #1653 — the booked-confirmation rows, staged and attempted the same way.
      bookedEmails: StagedRecipientEmail[];
    };

/** #1654 — an outbox row plus the rendered message the inline attempt sends. */
type StagedOutboxEmail = { staged: StagedEmail; message: RenderedEmail };

/**
 * A capture that landed on a webinar/class seat which is no longer there. The
 * seat is the refund's subject, so Phase 2 addresses it by the same triple the
 * seat front door takes (`kind`, `eventId`, buyer) instead of by payment id —
 * and the `participantId` is what keys the refund, exactly as the seat-leave
 * rule keyed its own (a later leave of the same sale must find this refund, not
 * pay a second time). Null only when the row is missing entirely.
 */
type ReleasedSeatRefund = {
  kind: "class" | "webinar";
  eventId: string;
  participantId: string | null;
};

/**
 * #1446 — Phase 2 runs inside `after()`, on the same warm instance that is
 * already serving the next inbound request, and PG_POOL_MAX=1 means the two
 * share one Prisma connection. Two unawaited 39 s Novu triggers held the event
 * loop and the socket while the chat-channel step waited for that connection
 * and died at the 3 s connect timeout. So every outbound Phase-2 step is
 * bounded and the notifications are awaited before the channel read begins.
 * Money is committed by this point, so a step that runs out of time is dropped
 * rather than retried inline: the reconcile sweep re-drives what is durable.
 */
const PHASE_2_DEADLINE_MS = 5_000;

/**
 * Resolve to `undefined` when `work` outlives the deadline, never throwing for
 * the timeout itself. The underlying call is not cancelled — nothing here can
 * cancel a socket — it is simply no longer waited on, which is what keeps the
 * connection free for the step behind it.
 */
async function withPhase2Deadline<T>(
  work: Promise<T>,
  label: string,
  ms: number = PHASE_2_DEADLINE_MS,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      console.warn(
        `⚠️ Phase 2 step exceeded its ${ms}ms deadline and was abandoned: ${label}`,
      );
      resolve(undefined);
    }, ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Report a capture that landed on a payment which is no longer PENDING.
 *
 * Every status stamp below rides a CAS (`updateMany` with `paymentStatus` in
 * the WHERE), so a zero count means the row reached a terminal state — EXPIRED,
 * FAILED or SUCCEEDED — before this webhook arrived. The caller writes nothing
 * and still acknowledges the delivery; this records the evidence an operator
 * needs to reconcile the captured funds by hand.
 *
 * The status is re-read rather than taken from the caller's pre-read, following
 * the same doctrine confirmApprovalStatus already applies below (#844): the
 * pre-read can have raced the very transition that made the CAS miss, and the
 * state named in this report is what an operator reconciles against. Callers
 * pass their own client — `tx` inside the Serializable transaction, `prisma`
 * for the post-rollback GiST branch — because a global-client read inside a
 * transaction deadlocks on a single-connection pool (#1435).
 */
async function reportTerminalCaptureRace(params: {
  db: Tx | typeof prisma;
  paymentId: string;
  orderId: string;
  /** Pre-read status; used only when the re-read finds nothing. */
  observedStatus: PaymentStatus;
  reason: string;
}): Promise<void> {
  const fresh = await params.db.payment.findUnique({
    where: { id: params.paymentId },
    select: { paymentStatus: true },
  });
  const currentStatus = fresh?.paymentStatus ?? params.observedStatus;
  // #1582 B-P1-02 — written through the caller's client (PG_POOL_MAX=1): a
  // global-client insert inside the tx would queue and die at the connect timeout.
  await recordSystemErrorSafe({
    organizationId: null,
    category: "PAYMENT",
    summary: `Capture for order ${params.orderId} landed on a ${currentStatus} payment — status left alone, refund by hand`,
    err: new Error("CAPTURE_AFTER_TERMINAL_PAYMENT"),
    context: {
      paymentId: params.paymentId,
      orderId: params.orderId,
      currentStatus,
      reason: params.reason,
    },
    db: params.db,
  });
  reportSentryMessage(
    "Capture landed on a terminal payment — status not restamped",
    {
      subsystem: "payments",
      level: "warning",
      extra: {
        paymentId: params.paymentId,
        orderId: params.orderId,
        currentStatus,
        reason: params.reason,
      },
    },
  );
}

/**
 * #1440 — thrown when a recovery's link write matches no row: another
 * recovery (or the webhook itself) linked the appointment first. Rolls the
 * tx back so the appointment built here never commits unlinked.
 */
export class RecoveryAlreadyDoneError extends Error {
  readonly code = "ALREADY_RECOVERED" as const;
  readonly httpStatus = 409 as const;
  constructor(paymentId: string) {
    super(`Payment ${paymentId} already has an appointment linked`);
    this.name = "RecoveryAlreadyDoneError";
  }
}

export async function handlePaymentSuccess(
  paymentIntentId: string,
  rawMetadata: Record<string, string>,
  gatewayAmountPaise?: number,
  gatewayPaymentId?: string,
  /**
   * #1440 — `recover: true` (admin recovery route only) lets a SUCCEEDED row
   * with NO appointment skip the idempotency short-circuit and run the
   * LEGACY appointment build with the supplied metadata. Every other state
   * keeps the webhook behaviour exactly; the link write's CAS predicate is
   * the single-writer guard (ADR 21).
   */
  options?: { recover?: boolean },
): Promise<PaymentSuccessTxResult["outcome"] | null> {
  const recovering = options?.recover === true;
  // #679 transition dual-read (see normalizeLegacySlotKeys) — in-flight
  // Razorpay orders created pre-rename replay webhooks with legacy slot
  // keys; normalize ONCE here so validation AND the legacy create flow
  // read the same new-key shape.
  const metadata = normalizeLegacySlotKeys(rawMetadata);
  // #1353 — the gateway's `pay_…` id is persisted by THIS pipeline and nowhere
  // else, because Phase 1 is already the single writer of the Payment row's
  // capture truth (ADR 21) and the id is part of that truth. Spread rather than
  // assigned unconditionally: `order.paid` carries no payment id, and writing
  // `undefined` from that path would erase an id a `payment.captured` had
  // already recorded.
  const capturedGatewayId = gatewayPaymentId ? { gatewayPaymentId } : {};
  // C1 FIX: Split into two phases:
  //   Phase 1 (transaction): Critical payment + appointment processing
  //   Phase 2 (post-tx): Earnings, invoice, notifications
  //
  // Previously, earnings/invoice creation used the global `prisma` client
  // inside the transaction, meaning they ran outside isolation but errors
  // were swallowed. Now they run explicitly post-transaction with proper
  // error logging. The `sync-payment-earnings` background job serves as
  // a safety net for any failures in Phase 2.

  // Phase 1: Critical transaction — payment confirmation + appointment.
  // Serializable (#827 review): two concurrent capture webhooks for
  // overlapping slots both pass the confirm-time conflict findFirst at READ
  // COMMITTED (each sees the other's slots still tentative). Under SSI the
  // rw-antidependency aborts one side with P2034; the retry then sees the
  // winner confirmed and blocks. The SUCCEEDED early-return keeps the retry
  // idempotent.
  let txResult: PaymentSuccessTxResult | null;
  try {
    txResult = await withSerializableRetry(() =>
      prisma.$transaction(
        async (tx): Promise<PaymentSuccessTxResult | null> => {
          const payment = await tx.payment.findUnique({
            where: { paymentIntent: paymentIntentId },
            include: { user: { include: { consulteeProfile: true } } },
          });

          if (!payment) {
            const err = new Error(
              `Payment record not found for intent: ${paymentIntentId}`,
            );
            reportSentryError(err, { subsystem: "payments" });
            throw err;
          }

          const recoverable =
            recovering &&
            payment.paymentStatus === PaymentStatus.SUCCEEDED &&
            payment.appointmentId === null;
          if (
            payment.paymentStatus === PaymentStatus.SUCCEEDED &&
            !recoverable
          ) {
            console.log(
              `Payment ${paymentIntentId} has already been processed.`,
            );
            // Idempotency short-circuit — a redelivered webhook. The system
            // working as designed.
            reportSentryMessage("Payment webhook idempotency short-circuit", {
              subsystem: "payments",
              expected: true,
              extra: { paymentIntentId },
            });
            return null; // Signal: already processed, skip Phase 2
          }

          // #1695 — EXPIRED means the abandoned sweep (or a supersede) already
          // released the hold; FAILED means a `payment.failed` did. Either way
          // the gateway holds real money that funds nothing, and nothing used
          // to move it back (#1439 reported it and stopped). Claim the row as
          // SUCCEEDED — gateway truth — so Phase 2 can refund through the
          // front door; the CAS keeps a concurrent writer honest (ADR 21).
          if (
            payment.paymentStatus === PaymentStatus.EXPIRED ||
            payment.paymentStatus === PaymentStatus.FAILED
          ) {
            const claimed = await tx.payment.updateMany({
              where: { id: payment.id, paymentStatus: payment.paymentStatus },
              data: {
                paymentStatus: PaymentStatus.SUCCEEDED,
                ...capturedGatewayId,
                capturedAt: new Date(), // #1775 C-2
                description: `Auto-refund pending: capture landed on a ${payment.paymentStatus} payment whose hold was already released. Booking NOT confirmed.`,
              },
            });
            if (claimed.count === 0) {
              await reportTerminalCaptureRace({
                db: tx,
                paymentId: payment.id,
                orderId: paymentIntentId,
                observedStatus: payment.paymentStatus,
                reason:
                  "capture arrived after the payment reached a terminal state",
              });
              return null;
            }
            return {
              outcome: "captured_after_release",
              paymentId: payment.id,
              releasedBy: `payment ${payment.paymentStatus}`,
            };
          }

          // #677 — defence-in-depth amount parity (mirrors handleOrgPaymentSuccess).
          // The gateway order is created at checkout for exactly Payment.amount and the
          // webhook is HMAC-verified, so a captured amount that differs is a gateway
          // anomaly or our-own bug — never silently confirm a booking for the wrong
          // money. Mark for manual recovery + page (like the metadata-failure path) and
          // skip confirmation; the captured funds are reconciled by hand.
          if (
            gatewayAmountPaise !== undefined &&
            gatewayAmountPaise !== payment.amount
          ) {
            reportSentryError(
              new Error(
                `Capture amount mismatch for ${paymentIntentId}: gateway=${gatewayAmountPaise} expected=${payment.amount}`,
              ),
              {
                subsystem: "payments",
                level: "fatal",
                contexts: {
                  payment: {
                    paymentIntentId,
                    paymentId: payment.id,
                    userId: payment.userId,
                  },
                },
              },
            );
            // #837 — mark SUCCEEDED (gateway truth) + stamp the auto-refund
            // marker. Phase 2 auto-refunds the wrong-amount capture; if that
            // call throws, the marker keeps it in retry-auto-refunds' queue
            // (#1846 N2).
            // #1439 — the stamp is a CAS: a late capture on an EXPIRED order
            // resurrected it to SUCCEEDED and its tentative hold leaked, so the
            // status rides the WHERE (ADR 21). Count 0 = already terminal:
            // write nothing, report, and still acknowledge the webhook.
            const stamped = await tx.payment.updateMany({
              where: { id: payment.id, paymentStatus: PaymentStatus.PENDING },
              data: {
                paymentStatus: PaymentStatus.SUCCEEDED,
                // #1353 — this branch auto-refunds in Phase 2, so it is the one
                // that MOST needs the id: the refund webhook that comes back
                // carries only `pay_…`, and without the column it cannot find
                // the Payment it is reversing.
                ...capturedGatewayId,
                description: autoRefundPendingDescription(
                  `capture amount ${gatewayAmountPaise}p ≠ expected ${payment.amount}p`,
                ),
              },
            });
            if (stamped.count === 0) {
              await reportTerminalCaptureRace({
                db: tx,
                paymentId: payment.id,
                orderId: paymentIntentId,
                observedStatus: payment.paymentStatus,
                reason: `capture amount ${gatewayAmountPaise}p ≠ expected ${payment.amount}p`,
              });
            }
            console.error(
              JSON.stringify({
                event: "CRITICAL_PAYMENT_AMOUNT_MISMATCH",
                alert_priority: "P1",
                payment_id: payment.id,
                payment_intent: paymentIntentId,
                user_id: payment.userId,
                gateway_amount_paise: gatewayAmountPaise,
                expected_amount_paise: payment.amount,
                action_required:
                  "auto-refund attempted; reconcile only if it failed",
                timestamp: new Date().toISOString(),
              }),
            );
            // Signal Phase 2 to auto-refund post-commit — the gateway refund call must
            // not run inside this Serializable tx.
            return {
              outcome: "amount_mismatch",
              paymentId: payment.id,
              gatewayAmountPaise,
              expectedAmount: payment.amount,
            };
          }

          // VALIDATION: Check metadata before processing
          try {
            validateWebhookMetadata(metadata);
          } catch (validationError) {
            // #1440 — a recovery with bad metadata is the operator's error;
            // the row is already SUCCEEDED, so there is nothing to restamp.
            if (recoverable) throw validationError;
            const errorMessage =
              validationError instanceof ZodError
                ? validationError.errors
                    .map((e) => `${e.path.join(".")}: ${e.message}`)
                    .join("; ")
                : validationError instanceof Error
                  ? validationError.message
                  : String(validationError);

            reportSentryError(validationError, {
              subsystem: "payments",
              level: "fatal",
              contexts: {
                payment: {
                  paymentIntentId,
                  paymentId: payment.id,
                  userId: payment.userId,
                },
              },
            });
            console.error(
              `❌ Metadata validation failed for payment ${paymentIntentId}:`,
              errorMessage,
            );

            // FIX Issue #8: Enhanced alerting for metadata validation failures
            // This is a CRITICAL condition - customer charged but no appointment created!
            // #1439 — the stamp is a CAS: a late capture on an EXPIRED order
            // resurrected it to SUCCEEDED and its tentative hold leaked, so the
            // status rides the WHERE (ADR 21). Count 0 = already terminal:
            // write nothing, report, and still acknowledge the webhook.
            const recoveryStamped = await tx.payment.updateMany({
              where: { id: payment.id, paymentStatus: PaymentStatus.PENDING },
              data: {
                paymentStatus: PaymentStatus.SUCCEEDED,
                // #1353 — a manual recovery here usually ends in a refund; give
                // that refund's webhook the id it needs to match this row.
                ...capturedGatewayId,
                description: `REQUIRES_MANUAL_RECOVERY: Metadata validation failed: ${errorMessage}. Customer charged but appointment NOT created.`,
              },
            });
            if (recoveryStamped.count === 0) {
              await reportTerminalCaptureRace({
                db: tx,
                paymentId: payment.id,
                orderId: paymentIntentId,
                observedStatus: payment.paymentStatus,
                reason: `metadata validation failed: ${errorMessage}`,
              });
            }

            // CRITICAL ALERT - Log in structured format for monitoring systems
            console.error(
              JSON.stringify({
                event: "CRITICAL_PAYMENT_WITHOUT_APPOINTMENT",
                alert_priority: "P1",
                payment_id: payment.id,
                payment_intent: paymentIntentId,
                user_id: payment.userId,
                user_email: payment.user.email,
                amount: payment.amount,
                currency: payment.currency,
                error: errorMessage,
                action_required:
                  "IMMEDIATE: Manual appointment creation or full refund required",
                dashboard_url: `${getAppUrl()}/admin/payments/${payment.id}`,
                timestamp: new Date().toISOString(),
              }),
            );

            console.error(
              `
================================================================================
                    CRITICAL ALERT: PAYMENT WITHOUT APPOINTMENT
================================================================================
Payment ID:      ${payment.id}
Payment Intent:  ${paymentIntentId}
User ID:         ${payment.userId}
User Email:      ${payment.user.email || "N/A"}
Amount:          ${payment.currency} ${payment.amount / 100}
Error:           ${errorMessage}

ACTION REQUIRED: Customer was charged but appointment was NOT created!
                 Either create appointment manually or issue full refund.
================================================================================
        `,
            );

            return null; // Exit early — requires manual intervention
          }

          // #1439 — the confirmation stamp is a CAS for the same reason as the
          // two recovery branches above, and it is the one a REPLAY now reaches
          // (the dev replay route used to fail metadata validation). Confirming
          // an EXPIRED payment would flip a hold the abandoned-payments sweep
          // has already released, so a terminal row is reported, not booked.
          // #1440 — a recovery starts from SUCCEEDED; its guard is the link
          // write's CAS in createAppointmentFromWebhook, not this stamp.
          const confirmed = recoverable
            ? { count: 1 }
            : await tx.payment.updateMany({
                where: { id: payment.id, paymentStatus: PaymentStatus.PENDING },
                data: {
                  paymentStatus: PaymentStatus.SUCCEEDED,
                  ...capturedGatewayId,
                  // #1775 C-2 — the allocate-or-refund clock; the SUCCEEDED
                  // short-circuit above never reaches here, so a replay keeps it.
                  capturedAt: new Date(),
                },
              });
          if (confirmed.count === 0) {
            await reportTerminalCaptureRace({
              db: tx,
              paymentId: payment.id,
              orderId: paymentIntentId,
              observedStatus: payment.paymentStatus,
              reason:
                "capture arrived after the payment reached a terminal state",
            });
            return null; // Signal: nothing to confirm, skip Phase 2
          }

          let appointment;
          if (payment.appointmentId) {
            // NEW FLOW: Appointment already created during checkout (tentative)
            appointment = await tx.appointment.findUnique({
              where: { id: payment.appointmentId },
            });

            console.log(
              JSON.stringify({
                event: "webhook_confirming_existing_appointment",
                paymentIntent: paymentIntentId,
                appointmentId: payment.appointmentId,
                timestamp: new Date().toISOString(),
              }),
            );
          } else {
            // LEGACY FLOW: Appointment not created during checkout
            appointment = await createAppointmentFromWebhook(
              tx,
              metadata,
              payment,
            );

            // The event creators refuse a capture they cannot seat (the event
            // filled between checkout and capture) and return null rather than
            // overselling. The money is captured and nothing was booked, so
            // this is the release outcome Phase 2 already refunds — NOT a
            // throw: throwing would roll the SUCCEEDED stamp back with the
            // rest of the transaction and the gateway would re-drive the
            // webhook into the same wall forever.
            if (!appointment) {
              // #1846 N2 — the pending-refund marker rides the same transaction
              // that decides the refund, so a Phase 2 refund that dies at the
              // gateway is still a row retry-auto-refunds re-drives.
              await tx.payment.update({
                where: { id: payment.id },
                data: {
                  description: autoRefundPendingDescription(
                    `capture could not be seated — ${metadata.appointmentType.toLowerCase()} ${metadata.eventId} is full`,
                  ),
                },
              });
              return {
                outcome: "captured_after_release",
                paymentId: payment.id,
                releasedBy: `event full (${metadata.appointmentType.toLowerCase()} ${metadata.eventId})`,
              };
            }

            console.log(
              JSON.stringify({
                event: "webhook_creating_new_appointment",
                paymentIntent: paymentIntentId,
                appointmentId: appointment.id,
                appointmentType: metadata.appointmentType,
                timestamp: new Date().toISOString(),
              }),
            );
          }

          if (!appointment) {
            throw new Error("Failed to create or find appointment");
          }

          // TRIAL: the session is AWAITING_PAYMENT with its slot already held, so
          // capture is what schedules it. Scoped to AWAITING_PAYMENT via
          // updateMany so a re-delivered webhook is a no-op rather than
          // resurrecting a trial the learner cancelled or the expiry job closed.
          // #1695 — runs BEFORE the slot confirmation: a trial the unpaid-trial
          // sweep already cancelled must not get confirmed occurrences and
          // kept money. A miss on a non-SCHEDULED trial is a released hold —
          // Phase 2 refunds it in full (the learner never cancelled; the
          // platform closed the trial before the money arrived).
          if (metadata.trialId) {
            // #1846 SM-B13 — the same CAS through the helper, which appends
            // the history row; its zero-row throw is the old `count === 0`.
            let scheduled = { count: 0 };
            try {
              await transitionTrial(tx, {
                reason: "payment captured",
                appointmentId: appointment.id,
                where: { id: metadata.trialId },
                to: TrialStatus.SCHEDULED,
                fromIn: [TrialStatus.AWAITING_PAYMENT],
                data: {
                  paymentId: payment.id,
                  pendingPaymentUrl: null,
                  paymentDueAt: null,
                },
              });
              scheduled = { count: 1 };
            } catch (err) {
              if (!(err instanceof IllegalTransitionError)) throw err;
            }

            console.log(
              JSON.stringify({
                event: scheduled.count
                  ? "webhook_trial_scheduled"
                  : "webhook_trial_not_awaiting_payment",
                paymentIntent: paymentIntentId,
                trialId: metadata.trialId,
                timestamp: new Date().toISOString(),
              }),
            );

            // #1775 C-8 — a trial charged at request: capture stamps it paid
            // and it stays PENDING for the consultant to accept (or refund).
            const paidAtRequest =
              scheduled.count === 0
                ? await tx.trial.updateMany({
                    where: {
                      id: metadata.trialId,
                      status: TrialStatus.PENDING,
                      paymentId: null,
                    },
                    data: {
                      paymentId: payment.id,
                      pendingPaymentUrl: null,
                      paymentDueAt: null,
                    },
                  })
                : { count: 0 };

            if (scheduled.count === 0 && paidAtRequest.count === 0) {
              const trial = await tx.trial.findUnique({
                where: { id: metadata.trialId },
                select: { status: true, paymentId: true },
              });
              // A replay of this capture; a trial bound to another payment is not ours.
              const alreadyOurs =
                trial?.paymentId === payment.id
                  ? trial.status === TrialStatus.SCHEDULED ||
                    trial.status === TrialStatus.PENDING
                  : trial?.status === TrialStatus.SCHEDULED &&
                    trial.paymentId === null;
              if (!alreadyOurs) {
                await tx.payment.update({
                  where: { id: payment.id },
                  data: {
                    description: `Auto-refund pending: capture landed on a ${trial?.status ?? "missing"} trial. Booking NOT confirmed.`,
                  },
                });
                return {
                  outcome: "captured_after_release",
                  paymentId: payment.id,
                  releasedBy: `trial ${trial?.status ?? "missing"}`,
                };
              }
            }
          }

          // #1861 L1 — `payment` is the pre-stamp read, so its status is still
          // the one the capture found. A PENDING row past its window had its
          // slot freed by buildDeadHoldFilter; the recheck must then yield to
          // a buyer who took that slot and is still inside their own hold.
          const confirmNow = new Date();
          const holdExpired =
            payment.paymentStatus === PaymentStatus.PENDING &&
            payment.expiresAt !== null &&
            payment.expiresAt < confirmNow;

          // Confirm appointment: set isTentative = false and update status to APPROVED
          const confirmResult = await confirmExistingAppointment(
            tx,
            appointment.id,
            payment.userId,
            { holdExpired, now: confirmNow },
          );

          console.log(
            `✅ Payment ${paymentIntentId} processed successfully. Appointment ID: ${appointment.id}`,
          );

          // #1654 — the receipt is staged in THIS transaction so a rollback
          // takes it too; the send waits for the commit. The two blocked
          // outcomes refund in Phase 2 and get no receipt. #1653 — the
          // booked confirmation rides the same read and the same rule.
          const blocked =
            confirmResult.capturedAfterTerminal ||
            confirmResult.doubleBookingBlocked;
          if (blocked) {
            // #1846 N2 — the refund these two outcomes owe happens after
            // commit, once. The marker is written in this transaction so a
            // failed or killed refund stays in retry-auto-refunds' queue.
            await tx.payment.update({
              where: { id: payment.id },
              data: {
                description: autoRefundPendingDescription(
                  confirmResult.doubleBookingBlocked
                    ? DOUBLE_BOOKING_BLOCKED_NOTE
                    : confirmResult.seatRefund
                      ? "capture landed after the seat was released"
                      : "capture landed after the booking was cancelled",
                ),
              },
            });
          }
          const appointmentForEmails = blocked
            ? null
            : await loadAppointmentForEmails(tx, appointment.id);
          const successEmail = appointmentForEmails
            ? await stagePaymentSuccessEmail(
                tx,
                payment,
                appointmentForEmails,
                metadata.appointmentType,
              )
            : null;
          const bookedEmails = appointmentForEmails
            ? await stageBookedEmails(
                tx,
                payment,
                appointmentForEmails,
                metadata.appointmentType,
              )
            : [];

          // Return data needed for Phase 2
          return {
            outcome: "confirmed",
            paymentId: payment.id,
            appointmentId: appointment.id,
            appointmentType: metadata.appointmentType,
            userId: payment.userId,
            userName: payment.user.name,
            amount: payment.amount,
            currency: payment.currency,
            // #855 — a capture that landed after the booking was cancelled; Phase 2
            // auto-refunds it instead of treating it as a confirmed booking.
            capturedAfterTerminal: confirmResult.capturedAfterTerminal,
            // #837 — the #827 first-confirmed-wins guard blocked this booking; Phase 2
            // auto-refunds the loser and releases its tentative hold.
            doubleBookingBlocked: confirmResult.doubleBookingBlocked ?? false,
            // The seat, when the capture found none to confirm: Phase 2 routes
            // that money back through the seat front door.
            seatRefund: confirmResult.seatRefund ?? null,
            successEmail,
            bookedEmails,
          };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 10_000,
          timeout: 15_000,
        },
      ),
    );
  } catch (err) {
    // B8b (booking-journey audit) — a LEGACY-shape capture (no appointmentId
    // in metadata, so checkout never pre-created the appointment) whose slot
    // chunks overlap an already-confirmed booking trips the #440 GiST
    // constraint inside the create. Left unhandled, that exception rolls back
    // the SUCCEEDED stamp above and the webhook is re-driven into the same
    // wall forever: gateway truth says captured, our ledger never agrees,
    // manual refund. Convert it here into the modelled outcome the #827
    // double-booking path already has — stamp SUCCEEDED outside the rolled-
    // back tx, then auto-refund below. (The NEW flow never hits this: its
    // confirm-time recheck returns doubleBookingBlocked in-tx instead.)
    if (!isExclusionViolation(err)) throw err;
    const loser = await prisma.payment.findUnique({
      where: { paymentIntent: paymentIntentId },
      select: { id: true, paymentStatus: true },
    });
    if (!loser) throw err;
    // Description stays HONEST at each step (CodeRabbit triage): "refund
    // pending" while the gateway call is in flight — if it fails, the record
    // must not claim money the buyer has not received. The success branch
    // below rewrites it to "Auto-refunded".
    // #1439 — third recovery stamp of the same shape, so it takes the same CAS.
    // The failed tx rolled the confirmation back, so the row is PENDING again
    // unless it went terminal underneath us; if it did, refundPayment would
    // reject it anyway (PAYMENT_NOT_SUCCEEDED), so report and stop.
    const restamped = await prisma.payment.updateMany({
      where: { id: loser.id, paymentStatus: PaymentStatus.PENDING },
      data: {
        paymentStatus: PaymentStatus.SUCCEEDED,
        // #1353 — the rolled-back tx took the id with it, and this branch
        // refunds immediately below; re-stamp it so that refund's webhook can
        // match the row.
        ...capturedGatewayId,
        capturedAt: new Date(), // #1775 C-2
        // #1846 N2 — the shared marker, so retry-auto-refunds picks it up
        // when the refund below throws.
        description: autoRefundPendingDescription(
          "legacy-shape capture overlapped a confirmed booking (occurrence_no_confirmed_overlap)",
        ),
      },
    });
    if (restamped.count === 0) {
      await reportTerminalCaptureRace({
        db: prisma,
        paymentId: loser.id,
        orderId: paymentIntentId,
        observedStatus: loser.paymentStatus,
        reason:
          "legacy-shape capture overlapped a confirmed booking (occurrence_no_confirmed_overlap)",
      });
      return null;
    }
    void recordSystemErrorSafe({
      organizationId: null,
      category: "PAYMENT",
      summary: `Legacy-shape capture ${paymentIntentId} overlapped a confirmed booking — auto-refunding`,
      err: err instanceof Error ? err : new Error(String(err)),
      context: { paymentIntentId, paymentId: loser.id },
    });
    try {
      await refundPayment({
        paymentId: loser.id,
        reason: "legacy capture overlapped a confirmed booking",
        initiatedByUserId: null,
      });
      await prisma.payment.update({
        where: { id: loser.id },
        data: {
          description:
            "Auto-refunded: legacy-shape capture overlapped a confirmed booking — booking NOT confirmed.",
        },
      });
    } catch (refundError) {
      reportSentryError(refundError, { subsystem: "payments" });
      console.error(
        "Failed to auto-refund GiST-overlap legacy capture; retry-auto-refunds re-drives its marker:",
        refundError,
      );
    }
    return null;
  }

  // If transaction returned null, the payment was already processed or had a metadata error
  if (!txResult) return null;

  // #837 — the gateway captured a different amount than we ordered. Auto-refund
  // the whole capture (never confirm a booking for the wrong money) and skip
  // Phase 2. The pending marker stays stamped for retry-auto-refunds if the
  // refund throws (#1846 N2). Idempotent: on webhook replay the payment is already
  // SUCCEEDED so the SUCCEEDED early-return fires before this path is reached,
  // and refundPayment's refundable-balance guard blocks any double-refund.
  if (txResult.outcome === "amount_mismatch") {
    try {
      await refundPayment({
        paymentId: txResult.paymentId,
        reason: "capture amount mismatch",
        initiatedByUserId: null,
      });
      // Refund succeeded — settle the Phase 1 marker so the retry sweep and
      // ops dashboards stop treating the payment as owed.
      await prisma.payment.update({
        where: { id: txResult.paymentId },
        data: {
          description: `Auto-refunded: capture amount ${txResult.gatewayAmountPaise}p ≠ expected ${txResult.expectedAmount}p. Booking NOT confirmed.`,
        },
      });
    } catch (refundError) {
      reportSentryError(refundError, {
        subsystem: "payments",
        contexts: {
          payment: {
            paymentId: txResult.paymentId,
            gatewayAmountPaise: txResult.gatewayAmountPaise,
            expectedAmount: txResult.expectedAmount,
          },
        },
      });
      console.error(
        "Failed to auto-refund amount-mismatch capture; retry-auto-refunds re-drives its marker (Phase 2):",
        refundError,
      );
    }
    return txResult.outcome;
  }

  // #1695 — the hold was released before the money landed. Nothing to
  // release here (the releaser did that); refund through the front door so
  // the rail is chosen by intent, and leave the manual marker only if that
  // throws. Idempotent: a replay hits the SUCCEEDED early-return first, and
  // the refundable-balance guard blocks a double refund.
  if (txResult.outcome === "captured_after_release") {
    try {
      await refundBookingPayment({
        paymentId: txResult.paymentId,
        reason: `capture after hold release (${txResult.releasedBy})`,
        initiatedByUserId: null,
      });
      await prisma.payment.update({
        where: { id: txResult.paymentId },
        data: {
          description: `Auto-refunded: capture landed after the hold was released (${txResult.releasedBy}). Booking NOT confirmed.`,
        },
      });
    } catch (refundError) {
      reportSentryError(refundError, {
        subsystem: "payments",
        contexts: { payment: { paymentId: txResult.paymentId } },
      });
      void recordSystemErrorSafe({
        organizationId: null,
        category: "PAYMENT",
        summary: `Capture after hold release (${txResult.releasedBy}) could not be auto-refunded — refund by hand`,
        err: new Error("CAPTURE_AFTER_RELEASE_REFUND_FAILED"),
        context: { paymentId: txResult.paymentId },
      });
    }
    return txResult.outcome;
  }

  // #855 — the capture landed after the booking was cancelled. The payment is
  // SUCCEEDED (gateway truth) but the booking is dead, so auto-refund and skip
  // the rest of Phase 2 — no success email, earnings, invoice, or notifications
  // for a cancelled booking. Idempotent against webhook replay (see refund.ts).
  if (txResult.capturedAfterTerminal) {
    try {
      if (txResult.seatRefund) {
        // The booking died as a SEAT (a leave released the row before the card
        // captured), so the seat is what the money bought: refund it through the
        // seat front door, the only one of the three that addresses a seat and
        // picks the rail from the intent — an org-funded seat has no gateway to
        // credit, and the `refundPayment` below cannot reverse one. `mode:
        // "full"` replays the answer `leaveEventSeat` had already computed for
        // this seat (it found no SUCCEEDED payment then, which is exactly why
        // its refund resolved nothing), and the dedupe key is that rule's own
        // key, so a later leave of the same sale finds this refund rather than
        // paying a second time.
        const seatRefund = await refundRemovedAttendeeSeat({
          kind: txResult.seatRefund.kind,
          eventId: txResult.seatRefund.eventId,
          attendeeUserId: txResult.userId,
          initiatedByUserId: null,
          mode: "full",
          dedupeKey: txResult.seatRefund.participantId
            ? `seat-leave:${txResult.seatRefund.participantId}`
            : `capture-no-seat:${txResult.appointmentId}`,
        });
        if (!seatRefund) {
          // The seat door resolves its payment by (event, buyer, SUCCEEDED), so
          // a null means this capture is not linked to the event and settling
          // the marker here would keep the buyer's money with nothing to show
          // for it. The booking door addresses the payment by id and picks the
          // same rail from the intent, so the money still comes back.
          await refundBookingPayment({
            paymentId: txResult.paymentId,
            reason: "capture after seat release",
            initiatedByUserId: null,
          });
        }
      } else {
        await refundPayment({
          paymentId: txResult.paymentId,
          reason: "capture after cancellation",
          initiatedByUserId: null,
        });
      }
      await settleAutoRefundMarker(txResult.paymentId);
    } catch (refundError) {
      reportSentryError(refundError, { subsystem: "payments" });
      console.error(
        "Failed to auto-refund capture-after-cancellation (Phase 2):",
        refundError,
      );
    }
    return txResult.outcome;
  }

  // #837 — the #827 first-confirmed-wins guard blocked this booking: the payment
  // is SUCCEEDED but the slots lost to an overlapping confirmed booking, so
  // auto-refund and release the tentative hold (otherwise a paid customer holds
  // no booking and their slots block rebooking). Skip the rest of Phase 2 — no
  // earnings/invoice/notifications for a booking that never confirmed.
  // Idempotent: webhook replay hits the SUCCEEDED early-return before here;
  // refundPayment's refundable-balance guard blocks a double-refund; the slot
  // release runs after a successful refund so a refund failure leaves the hold
  // for the #830 orphan sweep + manual recovery rather than freeing it unpaid.
  if (txResult.doubleBookingBlocked) {
    try {
      await refundPayment({
        paymentId: txResult.paymentId,
        reason: DOUBLE_BOOKING_BLOCKED_NOTE,
        initiatedByUserId: null,
      });
      // Release the tentative hold only once the money is back.
      await releaseBlockedBookingHold(txResult.appointmentId);
      await settleAutoRefundMarker(txResult.paymentId);
    } catch (refundError) {
      reportSentryError(refundError, {
        subsystem: "payments",
        contexts: {
          booking: {
            paymentId: txResult.paymentId,
            appointmentId: txResult.appointmentId,
          },
        },
      });
      console.error(
        "Failed to auto-refund double-booking loser; slots left for #830 sweep (Phase 2):",
        refundError,
      );
    }
    return txResult.outcome;
  }

  // Phase 2: Non-critical post-transaction work (earnings, invoice, notifications)
  // Failures here are logged but do NOT roll back the payment.
  // The `sync-payment-earnings` and related background jobs serve as safety nets.

  // M5 FIX: the receipt is SENT in Phase 2 (post-commit) so a rollback cannot
  // leave the user with a false confirmation; #1654 stages its row in Phase 1
  // so a crash here cannot lose it either. `attempt` never throws.
  if (txResult.successEmail) {
    await attemptEmail(
      txResult.successEmail.staged,
      txResult.successEmail.message,
      "PAYMENT_SUCCESS",
      { budgetMs: EMAIL_BUDGET_MS.WEBHOOK },
    );
  }
  // #1653 — the booked confirmation to both parties, same contract.
  if (txResult.bookedEmails.length > 0) {
    await attemptStaged(
      txResult.bookedEmails,
      "APPOINTMENT_BOOKED",
      EMAIL_BUDGET_MS.WEBHOOK,
    );
  }

  const { paymentId, appointmentId, userId, userName, amount, currency } =
    txResult;

  // --- Earnings creation ---
  try {
    const resolved = await resolvePaymentForEarnings(
      { id: paymentId },
      metadata.appointmentType,
    );

    if (resolved) {
      await createEarningsFromPayment({
        payment: resolved.paymentForEarnings,
        appointmentType: resolved.earningsAppointmentType,
      });

      console.log(
        `💰 Earnings record created for payment ${paymentId}, consultant ${resolved.consultantProfileId}`,
      );
    }
  } catch (earningsError) {
    // C-01 #837 — payment + booking are committed but earnings + the BOOKING
    // journal are not. Real money moved, so we don't roll back and we don't
    // pretend success with a silent warning: page (ERROR) and durably record
    // the ledger gap. The healer is the data-state sync-payment-earnings scan
    // (SUCCEEDED payment + earnings:none), keyed on row state — not on this
    // marker — so it's guaranteed and idempotent even if this alert is lost.
    await recordSystemError({
      category: "PAYOUT",
      summary: `Earnings + booking journal not written for committed payment ${paymentId} (webhook path)`,
      err: earningsError,
      correlationId: paymentId,
      context: { paymentId, appointmentId, userId, path: "webhook" },
    });
    console.error(
      `⚠️ Failed to create earnings for payment ${paymentId}:`,
      earningsError,
    );
  }

  // --- Referral qualifying action (first paid booking triggers both bonuses) ---
  // FIX #437: Process for the buyer (consultee) — their first paid booking qualifies their referral
  try {
    await processQualifyingAction(userId, "first_paid_booking");
    // P3 referral bells, post-commit. scheduleAfter, not after(): this
    // handler also runs from scripts/payments/reconcile-orphaned-confirmations
    // where no request scope exists and a bare after() throws.
    scheduleAfter(
      () =>
        notifyReferralQualificationBestEffort(userId).catch((bellErr) =>
          console.error("[referral-qualification-bell] failed:", bellErr),
        ),
      "payments.handlePaymentSuccess.referral-bell",
    );
  } catch (referralError) {
    reportSentryError(referralError, {
      subsystem: "payments",
      level: "warning",
    });
    console.error(
      `⚠️ Failed to process referral qualifying action for user ${userId}:`,
      referralError,
    );
  }

  // FIX #437: Also process for the consultant (service provider) — receiving their first
  // paid booking qualifies their referral too. This fixes the broken Consultant→Consultant
  // referral scenario where consultants never trigger qualification because they don't
  // make bookings, they receive them.
  try {
    await processConsultantBookingReferral({ id: paymentId }, userId);
  } catch (consultantReferralError) {
    reportSentryError(consultantReferralError, {
      subsystem: "payments",
      level: "warning",
    });
    console.error(
      `⚠️ Failed to process consultant referral qualifying action:`,
      consultantReferralError,
    );
  }

  // #1365 — the personal-consultee tax invoice the v0 lockdown (#768) removed.
  // The platform bills as principal supplier (ADR 26), so a consumer who was
  // charged 18% GST is owed a Rule 46 document; org-funded checkouts still roll
  // up into OrganizationInvoice and the mint no-ops for them by design.
  await mintConsumerInvoiceBestEffort({ paymentId });

  // --- Novu notifications (M5 FIX: moved outside transaction) ---
  try {
    // #734 — the notification only needs the consultant's id/name; the old
    // 4-level include dragged full User + profile rows for all four shapes.
    // #1484 widens it by exactly one scalar, the plan's own title, because this
    // is the only appointment read Phase 2 makes and the buyer's confirmation
    // has to name what they bought.
    const planNotifSelect = {
      select: {
        id: true,
        title: true,
        consultantProfile: {
          select: { user: { select: { id: true, name: true } } },
        },
      },
    } as const;
    const appointmentForNotif = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      select: {
        // ADR 23 — the notification inherits the org-ness of the record that
        // triggered it, so both payloads below can be attributed and routed.
        organizationId: true,
        organization: { select: { name: true } },
        consultation: {
          select: { consultationPlan: planNotifSelect },
        },
        subscription: {
          select: { subscriptionPlan: planNotifSelect },
        },
        webinar: {
          select: { webinarPlan: planNotifSelect },
        },
        class: {
          select: { classPlan: planNotifSelect },
        },
      },
    });

    const consultantProfileData =
      appointmentForNotif?.consultation?.consultationPlan?.consultantProfile ||
      appointmentForNotif?.subscription?.subscriptionPlan?.consultantProfile ||
      appointmentForNotif?.webinar?.webinarPlan?.consultantProfile ||
      appointmentForNotif?.class?.classPlan?.consultantProfile;

    const consultantNameForNotif =
      consultantProfileData?.user?.name || "Consultant";
    const consultantUserId = consultantProfileData?.user?.id;

    // #1484 — name the thing that was bought. `metadata.planId` is an id and
    // sat on the left of the `||` at both payload sites below, so every normal
    // capture told the buyer they had purchased a UUID; the fallback it shadowed
    // returned `metadata.appointmentType` on BOTH branches of its ternary and so
    // could never be a plan name either. A TRIAL hangs off the parent
    // subscription plan, whose title names the paid programme, not the free
    // session — so it gets its own label rather than that plan's title.
    const resolvedPlanTitle =
      metadata.appointmentType === AppointmentsType.TRIAL
        ? "Trial session"
        : planTitleOrSessionLabel(
            appointmentForNotif?.consultation?.consultationPlan?.title ??
              appointmentForNotif?.subscription?.subscriptionPlan?.title ??
              appointmentForNotif?.webinar?.webinarPlan?.title ??
              appointmentForNotif?.class?.classPlan?.title ??
              null,
            metadata.appointmentType,
          );

    const orgId = appointmentForNotif?.organizationId ?? null;
    const scope = notificationScope(
      orgId,
      appointmentForNotif?.organization?.name,
    );
    // Org-hosted → the org route, which is right for every recipient of the
    // batched trigger below. B2C → the bare /dashboard router bounce, because
    // consultant and consultee land in different personal trees.
    const dashboardUrl = notificationHref(orgId, "appointments");

    // #1446 — collected, not fired and forgotten: they are awaited together
    // below, before the channel step touches the pool's only connection.
    const notifications: Promise<unknown>[] = [];

    // Notify consultee of successful payment
    notifications.push(
      Promise.resolve(
        notifyPaymentSuccess(userId, {
          ...scope,
          amount,
          currency,
          consultantName: consultantNameForNotif,
          appointmentType: metadata.appointmentType,
          planTitle: resolvedPlanTitle,
          dashboardUrl,
        }),
      ),
    );

    // Notify both consultant and consultee of the booked appointment
    const notifUserIds = [userId];
    if (consultantUserId && consultantUserId !== userId) {
      notifUserIds.push(consultantUserId);
    }
    // #1580 C-P1-5 — a group event's accepted collaborators hear about the
    // booking too; a 1:1 plan has none.
    const webinarPlanId = appointmentForNotif?.webinar?.webinarPlan?.id;
    const classPlanId = appointmentForNotif?.class?.classPlan?.id;
    if (webinarPlanId || classPlanId) {
      const collaboratorIds = webinarPlanId
        ? await collaboratorUserIds("webinar", webinarPlanId)
        : await collaboratorUserIds("class", classPlanId as string);
      for (const id of collaboratorIds) {
        if (!notifUserIds.includes(id)) notifUserIds.push(id);
      }
    }

    // #1085 — the template renders a session time; omitting it left an empty
    // placeholder in the user's very first booking notification.
    const firstSlot = await prisma.appointmentOccurrence.findFirst({
      where: { appointmentId },
      orderBy: { startsAt: "asc" },
      select: { startsAt: true },
    });
    // B9 (booking-journey audit) — APPOINTMENT_BOOKED names a TIME. For a
    // subscription placeholder (paid, zero slots until the consultant
    // allocates) there is no time, and the Novu template rendered a blank
    // date placeholder as the payer's very first booking message.
    // notifyPaymentSuccess above already told them the purchase worked, so
    // the booked-with-time ping is deferred to allocation (PR 2c wires that
    // notification). Template-side rendering stays a Novu dashboard concern
    // (#1085 precedent).
    if (!firstSlot?.startsAt) {
      console.log(
        JSON.stringify({
          event: "appointment_booked_notification_skipped_no_slots",
          appointmentId,
          paymentId: paymentId,
          timestamp: new Date().toISOString(),
        }),
      );
    } else {
      // Money-hardening pass — Promise.resolve guards against non-promise
      // returns (Novu wrappers swallow internally; test doubles return
      // undefined), so a synchronous throw can't become an unhandled
      // rejection inside this handler.
      notifications.push(
        Promise.resolve(
          notifyAppointmentBooked(notifUserIds, {
            ...scope,
            appointmentId,
            dateTime: firstSlot.startsAt.toISOString(),
            appointmentType: metadata.appointmentType,
            consultantName: consultantNameForNotif,
            consulteeName: userName || "User",
            planTitle: resolvedPlanTitle,
            dashboardUrl,
          }),
        ),
      );
    }

    // #1446 — best-effort still, but bounded and finished BEFORE the channel
    // step: `allSettled` swallows a rejected trigger (the Novu wrappers already
    // log and report it) and the deadline drops one that hangs.
    await Promise.allSettled(
      notifications.map((notification, i) =>
        withPhase2Deadline(notification, `novu-trigger[${i}] ${paymentId}`),
      ),
    );
  } catch (novuError) {
    reportSentryError(novuError, { subsystem: "payments", level: "warning" });
    console.error(
      `⚠️ Failed to send Novu notifications for payment ${paymentId}:`,
      novuError,
    );
  }

  // --- Stream channel creation (truly fire-and-forget — does not block webhook response) ---
  //
  // #1356 — the work itself moved to `ensureChannelsForAppointment`, which
  // stamps `Appointment.chatChannelEnsuredAt` on success. The call stays here,
  // in the same post-commit position and with the same fire-and-forget posture,
  // for the same reason as before: it is outbound network work. What changed is
  // that failing it now leaves a trace — a confirmed appointment with a NULL
  // stamp — which reconcile-orphaned-confirmations re-drives instead of the
  // buyer silently never having a chat.
  void (async () => {
    try {
      // #1446 — the step opens with a DB read, so it is the first thing to die
      // when the single connection is busy. Bounded: on timeout
      // `chatChannelEnsuredAt` stays NULL, which is exactly the queue that
      // reconcile-orphaned-confirmations drains.
      const result = await withPhase2Deadline(
        ensureChannelsForAppointment(appointmentId),
        `ensureChannelsForAppointment(${appointmentId})`,
      );
      if (!result) {
        streamLogger.warn(
          "Stream channel step hit its deadline — stamp left NULL for the reconcile sweep",
          { appointmentId, userId, deadlineMs: PHASE_2_DEADLINE_MS },
        );
        return;
      }
      if (!result.ensured) {
        streamLogger.warn(
          "Stream channels not ensured on payment success — left for the reconcile sweep",
          { appointmentId, userId, reason: result.reason },
        );
      }
    } catch (channelError) {
      // #1134 P1-15 — this used to say "sync job will catch up". No such job
      // exists: `stream-sync` only DELETES stale Stream users, and
      // syncUserEventChannels repairs webinar/class/DM membership on the next
      // dashboard load but cannot invent a channel for a booking it never saw.
      // A failure here means the buyer silently has no chat, so it must at
      // least page. The reconcile sweep is now the durable re-drive.
      reportSentryError(channelError, {
        subsystem: "stream",
        op: "handlePaymentSuccess.createChannels",
        extra: { appointmentId, userId },
      });
      streamLogger.error(
        "Auto-channel creation failed on payment success — buyer has no chat",
        channelError,
        { appointmentId, userId },
      );
    }
  })();
  return txResult.outcome;
}

/**
 * Handle failed payment - cleans up tentative appointments
 */
export async function handlePaymentFailure(paymentIntentId: string) {
  const staged = await prisma.$transaction(async (tx) => {
    // #734 — narrowed from a 5-level include; the failure path only reads
    // the payer's email/name and the consultant's name for notifications.
    const consultantUserSelect = {
      select: {
        consultantProfile: {
          select: { user: { select: { id: true, name: true } } },
        },
      },
    } as const;
    const payment = await tx.payment.findUnique({
      where: { paymentIntent: paymentIntentId },
      select: {
        id: true,
        paymentStatus: true,
        userId: true,
        appointmentId: true,
        amount: true,
        currency: true,
        description: true,
        user: { select: { email: true, name: true } },
        appointment: {
          select: {
            id: true,
            appointmentType: true,
            consultation: {
              select: { consultationPlan: consultantUserSelect },
            },
            subscription: {
              select: { subscriptionPlan: consultantUserSelect },
            },
          },
        },
      },
    });

    if (!payment) {
      console.warn(
        `Payment record not found for failed intent: ${paymentIntentId}`,
      );
      reportSentryMessage("Payment failure webhook: payment not found", {
        subsystem: "payments",
        level: "warning",
        extra: { paymentIntentId },
      });
      return;
    }

    // FIX Issue #8: Idempotency check - prevent duplicate processing
    if (payment.paymentStatus === PaymentStatus.FAILED) {
      console.log(
        `Payment ${paymentIntentId} has already been marked as failed.`,
      );
      reportSentryMessage("Payment failure webhook idempotency short-circuit", {
        subsystem: "payments",
        expected: true,
        extra: { paymentIntentId },
      });
      return;
    }

    // M7 FIX: Guard against SUCCEEDED → FAILED transition.
    // A late failure webhook must not override a payment that already succeeded.
    if (payment.paymentStatus === PaymentStatus.SUCCEEDED) {
      console.warn(
        `Payment ${paymentIntentId} already SUCCEEDED. Ignoring late failure webhook.`,
      );
      reportSentryMessage(
        "Payment failure webhook arrived after SUCCEEDED — ignored",
        {
          subsystem: "payments",
          expected: true,
          level: "warning",
          extra: { paymentIntentId },
        },
      );
      return;
    }

    // Guard against EXPIRED → FAILED transition.
    // Once a payment is expired by cleanup jobs, a late failure webhook should not overwrite it.
    if (payment.paymentStatus === PaymentStatus.EXPIRED) {
      console.log(
        `Payment ${paymentIntentId} already EXPIRED. Ignoring late failure webhook.`,
      );
      reportSentryMessage(
        "Payment failure webhook arrived after EXPIRED — ignored",
        {
          subsystem: "payments",
          expected: true,
          extra: { paymentIntentId },
        },
      );
      return;
    }

    // ADR 21 / #1582 B-P0-01 — CAS in WHERE: a `payment.failed` for attempt 1
    // racing the capture of attempt 2 must not overwrite SUCCEEDED.
    const { count } = await tx.payment.updateMany({
      where: { id: payment.id, paymentStatus: PaymentStatus.PENDING },
      data: { paymentStatus: PaymentStatus.FAILED },
    });
    if (count === 0) {
      reportSentryMessage("payment.failed lost the race to a capture", {
        subsystem: "payments",
        expected: true,
        extra: { paymentIntentId },
      });
      return;
    }

    if (payment.appointment) {
      await cleanupFailedPaymentAppointment(tx, payment.appointment.id);
    }

    // #1654 — the failure notice is staged in this transaction and sent
    // after it commits, below.
    const failedEmail = await stagePaymentFailedEmail(tx, payment);

    // --- Novu notification (#1654: staged in the tx, attempted after commit) ---
    const consultantUser =
      payment.appointment?.consultation?.consultationPlan?.consultantProfile
        ?.user ||
      payment.appointment?.subscription?.subscriptionPlan?.consultantProfile
        ?.user;

    const consultantName = consultantUser?.name || "Consultant";
    const appointmentType =
      payment.appointment?.appointmentType || "CONSULTATION";

    const bell = await notifyPaymentFailed(
      payment.userId,
      {
        amount: payment.amount,
        currency: payment.currency,
        consultantName,
        appointmentType,
        failureReason: payment.description || "Payment could not be processed",
        // #1527 — the recipient is always the payer.
        retryUrl: `${getAppUrl()}${goHref("client", "payments")}`,
      },
      // Payment failure is urgent: bypass quiet-hours deferral.
      { tx, entityRef: `payment:${payment.id}`, deferrable: false },
    );

    console.log(
      `📧 Payment failure notification staged for payment ${paymentIntentId}`,
    );
    return { failedEmail, bell: bell?.staged ?? null };
  });

  // #1654 — the inline fast path, after the commit: a timeout leaves the rows
  // PENDING for the relays. Neither attempt throws.
  if (staged?.failedEmail) {
    await attemptEmail(
      staged.failedEmail.staged,
      staged.failedEmail.message,
      "PAYMENT_FAILED",
      { budgetMs: EMAIL_BUDGET_MS.WEBHOOK },
    );
  }
  if (staged?.bell) await attemptTrigger(staged.bell);
}

// ============================================================================
// Appointment Creation from Webhook Metadata
// ============================================================================

/**
 * Create appointment from webhook metadata based on appointment type
 */
async function createAppointmentFromWebhook(
  tx: Tx,
  metadata: Record<string, string>,
  payment: PaymentWithUser,
) {
  const {
    appointmentType,
    planId,
    eventId,
    startsAt,
    endsAt,
    schedulingPeriodStartsAt,
    schedulingPeriodEndsAt,
    notes,
  } = metadata;

  if (!payment.user.consulteeProfile) {
    throw new Error("User profile not found for payment");
  }

  const consulteeProfileId = payment.user.consulteeProfile.id;
  const userId = payment.user.id;

  let appointment;
  // #1854 — event seats take the org only when the org's money paid for them.
  const seatOrg = seatPayerOrganizationId(
    payment.organizationId,
    isOrgFundedPaymentMethod(payment.paymentMethod),
  );

  switch (appointmentType) {
    case AppointmentsType.CONSULTATION:
      appointment = await createConsultation(tx, {
        planId,
        startsAt,
        endsAt,
        notes,
        consulteeProfileId,
        userId,
      });
      break;
    case AppointmentsType.SUBSCRIPTION:
      // LEGACY FLOW WARNING: This should only happen for old payments
      // New subscriptions create placeholder appointment during checkout
      console.warn(
        JSON.stringify({
          event: "legacy_subscription_creation",
          warning:
            "Creating subscription via webhook - expected only for old payments",
          paymentId: payment.id,
          planId,
          timestamp: new Date().toISOString(),
        }),
      );
      appointment = await createSubscription(tx, {
        planId,
        startsAt,
        endsAt,
        schedulingPeriodStartsAt,
        schedulingPeriodEndsAt,
        notes,
        consulteeProfileId,
        userId,
      });
      break;
    case AppointmentsType.WEBINAR:
      appointment = await createWebinar(tx, {
        eventId,
        userId,
        organizationId: seatOrg,
      });
      break;
    case AppointmentsType.CLASS:
      appointment = await createClass(tx, {
        eventId,
        userId,
        organizationId: seatOrg,
      });
      break;
    default:
      throw new Error(`Unsupported appointment type: ${appointmentType}`);
  }

  // A group-event creator refused to seat the buyer (the event is full). No
  // appointment, so there is nothing to link: the caller refunds the capture.
  if (!appointment) return null;

  // #1440 / ADR 21 — the link is a CAS: SUCCEEDED (this tx stamped it, or the
  // recovery read it) and still unlinked. A miss means another writer won.
  const linked = await tx.payment.updateMany({
    where: {
      id: payment.id,
      paymentStatus: PaymentStatus.SUCCEEDED,
      appointmentId: null,
    },
    data: { appointmentId: appointment.id },
  });
  if (linked.count === 0) throw new RecoveryAlreadyDoneError(payment.id);

  return appointment;
}

// ============================================================================
// Appointment Type-Specific Creation Functions
// ============================================================================

async function createConsultation(tx: Tx, data: ConsultationData) {
  // #440 — the include rides the create so the overlap-guard column comes
  // back without a second query inside the webhook transaction. #1319 adds
  // the consultant's user id: the conflict filter this row has to be visible
  // to matches on `user.some.id`, not on the profile.
  const consultation = await tx.consultation.create({
    data: {
      consultationPlanId: data.planId,
      status: AppointmentStatus.PENDING,
      requestedById: data.consulteeProfileId,
      requestNotes: data.notes,
      bookingSource: "DIRECT_CHECKOUT",
    },
    include: {
      consultationPlan: {
        select: {
          consultantProfileId: true,
          consultantProfile: { select: { userId: true } },
        },
      },
    },
  });

  const consultantUserId =
    consultation.consultationPlan.consultantProfile?.userId;
  if (!consultantUserId) {
    // Without it the row is invisible to the consultant-scoped conflict filter
    // and the allocator will happily double-book on top of it. A capture that
    // cannot produce a correct booking must fail loudly, not quietly commit a
    // half-connected one — the caller's CRITICAL alert exists for this.
    throw new Error(
      "Consultation plan has no consultant user; cannot create booking",
    );
  }

  // #1554 — the identical call handleConsultationCheckout makes, so the
  // capture fallback and checkout write one shape.
  const occurrence = buildOccurrenceForWindow({
    startsAt: new Date(data.startsAt),
    endsAt: new Date(data.endsAt),
    consultantProfileId: consultation.consultationPlan.consultantProfileId,
    // Checkout births `!skipPayment` and the capture webhook flips it false.
    // This creator only runs AFTER capture, so confirmed is the same end state
    // by a shorter road — confirmExistingAppointment re-flips it either way.
    isTentative: false,
  });

  const appointment = await tx.appointment.create({
    data: {
      appointmentType: AppointmentsType.CONSULTATION,
      consultationId: consultation.id,
      occurrences: { create: occurrence },
      // #1319 A9 — legacy-shape capture creates the appointment itself, so the
      // participant rows are born here rather than flipped by the confirm path.
      // One row per party: the consultant attends too.
      participants: {
        create: [
          { userId: consultantUserId, role: "CONSULTANT", status: "CONFIRMED" },
          { userId: data.userId, role: "CONSULTEE", status: "CONFIRMED" },
        ],
      },
    },
    include: {
      occurrences: true,
    },
  });

  // #1583 A-P1-06 — the legacy creator was the one request birth with no
  // opening timeline row (SKILL.md rule 1); same tx as the create.
  await appendCreationHistory(
    tx,
    "CONSULTATION",
    consultation.id,
    consultation.status,
    {
      appointmentId: appointment.id,
    },
  );

  return appointment;
}

async function createSubscription(tx: Tx, data: SubscriptionData) {
  const plan = await tx.subscriptionPlan.findUnique({
    where: { id: data.planId },
    // #1076 — the owning consultant's zone is what the caps bucket on.
    include: {
      consultantProfile: { select: { user: { select: { timezone: true } } } },
    },
  });
  if (!plan) throw new Error("Subscription plan not found");

  // #1766 — window = first cycle; a client end is clamped/ignored, never
  // refused. Twin of handleSubscriptionCheckout.
  const schedulingTimezone = resolveSchedulingTimezone(
    plan.consultantProfile?.user?.timezone,
  );
  const { start: startDate, end: endDate } = firstCycleWindow(
    plan,
    data.schedulingPeriodStartsAt
      ? new Date(data.schedulingPeriodStartsAt)
      : new Date(),
    schedulingTimezone,
  );

  const subscription = await tx.subscription.create({
    data: {
      subscriptionPlanId: data.planId,
      status: AppointmentStatus.PENDING,
      requestedById: data.consulteeProfileId,
      requestNotes: data.notes,
      bookingSource: "DIRECT_CHECKOUT",
      schedulingPeriodStartsAt: startDate,
      schedulingPeriodEndsAt: endDate,
      schedulingTimezone,
      // #1766 — the entitlement is frozen at purchase; plan edits never move it.
      sessionsTotal: plan.totalSessions,
    },
  });

  // #1554 — the purchase wrapper, which is what handleSubscriptionCheckout
  // has always produced: a subscription's calls are allocated later by the
  // consultant from the Requests tab and land on this row as occurrences, so
  // there is no time here to write.
  const wrapper = await tx.appointment.create({
    data: {
      appointmentType: AppointmentsType.SUBSCRIPTION,
      subscriptionId: subscription.id,
    },
    include: {
      occurrences: true,
    },
  });

  // #1583 A-P1-06 — same opening row the checkout creator writes.
  await appendCreationHistory(
    tx,
    "SUBSCRIPTION",
    subscription.id,
    subscription.status,
    {
      appointmentId: wrapper.id,
    },
  );

  return wrapper;
}

/**
 * A legacy-shape capture for an event that is already full. Checkout gated
 * capacity inside its own transaction, but this path runs minutes-to-hours
 * later (an order predating the pre-created appointment, or an admin recovery),
 * so the room it quoted is not the room that is left.
 *
 * Returning null is the refusal: the caller routes the capture to the
 * `captured_after_release` arm, which refunds it in full. Throwing would be the
 * same trap the GiST catch documents — the SUCCEEDED stamp rolls back with the
 * transaction and the gateway re-drives the webhook into the same wall forever.
 * Overselling quietly is worse still: the roster would carry a seat the host
 * never agreed to sell.
 */
async function refuseFullEventCapture(
  tx: Tx,
  args: {
    kind: "webinar" | "class";
    eventId: string;
    appointmentId: string;
    userId: string;
    registered: number;
    max: number;
  },
): Promise<null> {
  // #1582 B-P1-02 — through the tx (PG_POOL_MAX=1); a global-client insert
  // inside it would queue and die at the connect timeout.
  await recordSystemErrorSafe({
    organizationId: null,
    category: "PAYMENT",
    summary: `Capture for ${args.kind} ${args.eventId} cannot be seated — it is full (${args.registered}/${args.max}) and the money is being returned`,
    err: new Error("CAPTURE_CANNOT_SEAT_FULL_EVENT"),
    context: {
      entityType: args.kind,
      entityId: args.eventId,
      appointmentId: args.appointmentId,
      userId: args.userId,
      registered: args.registered,
      max: args.max,
    },
    correlationId: `capture-cannot-seat:${args.appointmentId}`,
    db: tx,
  });
  reportSentryError(new Error("CAPTURE_CANNOT_SEAT_FULL_EVENT"), {
    subsystem: "payments",
    expected: true,
    level: "warning",
    contexts: {
      booking: {
        appointmentId: args.appointmentId,
        entityType: args.kind,
        entityId: args.eventId,
        userId: args.userId,
      },
    },
  });
  console.error(
    JSON.stringify({
      event: "capture_cannot_seat_full_event",
      appointmentId: args.appointmentId,
      eventId: args.eventId,
      eventType: args.kind,
      userId: args.userId,
      registered: args.registered,
      max: args.max,
      action_required: "auto-refund attempted; reconcile only if it failed",
      timestamp: new Date().toISOString(),
    }),
  );
  return null;
}

/**
 * The legacy webinar capture path: seat the buyer on the event's own wrapper.
 *
 * `excludeUserIds` below drops the host (a host does not consume a seat — the
 * same exclusion checkout applies) and the buyer themselves, so a re-delivered
 * capture for someone who already holds a live seat is not refused by a room
 * that seat of theirs helped fill.
 */
async function createWebinar(tx: Tx, data: EventData) {
  const webinar = await tx.webinar.findUnique({
    where: { id: data.eventId },
    include: {
      // `participants` is load-bearing: `getWebinarCapacity` throws without it
      // rather than counting a sold-out event as open (#676 CN-4).
      webinarPlan: {
        select: {
          maxParticipants: true,
          consultantProfile: { select: { userId: true } },
        },
      },
      appointment: {
        include: {
          occurrences: true,
          participants: { where: liveParticipant(), select: { userId: true } },
        },
      },
    },
  });
  if (!webinar) throw new Error("Webinar not found");

  // Validate webinar has been scheduled (has an appointment with at least one slot)
  const masterSlot = webinar.appointment?.occurrences?.[0];
  if (!webinar.appointment || !masterSlot) {
    throw new Error("Webinar has not been scheduled. Cannot create booking.");
  }

  // The checkout gate, replayed against the roster as it stands NOW. A capture
  // recovery for a webinar that filled while the money was in flight must be
  // given back, not seated past the room.
  //
  // The reading is required, and that is deliberate: a gate that cannot read its
  // input must not be a gate, and the only reason to read it "optionally" was
  // that a bare `jest.fn()` capacity mock returns undefined — a test
  // convenience that would have let a real over-capacity capture through
  // unnoticed. In production the helper is total — it throws on an un-included
  // roster rather than count zero (#676 CN-4) — so a reading always exists or
  // the transaction aborts, which is the same fate a genuine read failure gets.
  const capacity = getWebinarCapacity({
    webinar,
    plan: webinar.webinarPlan,
    excludeUserIds: [
      webinar.webinarPlan.consultantProfile?.userId,
      data.userId,
    ].filter((id): id is string => !!id),
  });
  if (capacity.isFull) {
    return await refuseFullEventCapture(tx, {
      kind: "webinar",
      eventId: data.eventId,
      appointmentId: webinar.appointment.id,
      userId: data.userId,
      registered: capacity.registered,
      max: capacity.max,
    });
  }

  // #1319 / #1554 — the seat is the participant row on the event's own
  // appointment, the same edge handleWebinarCheckout writes, in the same HELD
  // state. Born CONFIRMED it would outlive its own
  // guard: `confirmExistingAppointment` runs AFTER this and its B2 CAS refuses
  // a capture landing on a cancelled webinar, but this transaction commits
  // either way — leaving a confirmed seat on a dead event that Phase 2 has
  // already refunded. HELD is promoted by the CAS or by nothing.
  await recordParticipants(
    tx,
    webinar.appointment.id,
    [{ userId: data.userId, role: "CONSULTEE" }],
    { status: "HELD", organizationId: data.organizationId },
  );

  const createdAppointment = await tx.appointment.findUnique({
    where: { id: webinar.appointment.id },
    include: { occurrences: true },
  });
  if (!createdAppointment) {
    throw new Error("Failed to fetch created appointment");
  }
  return createdAppointment;
}

async function createClass(tx: Tx, data: EventData) {
  const classInstance = await tx.class.findUnique({
    where: { id: data.eventId },
    include: {
      // As in the webinar arm: without `participants` the capacity call throws
      // instead of counting zero.
      classPlan: {
        select: {
          maxParticipants: true,
          consultantProfile: { select: { userId: true } },
        },
      },
      appointment: {
        include: {
          occurrences: { select: { id: true } },
          participants: { where: liveParticipant(), select: { userId: true } },
        },
      },
    },
  });
  if (!classInstance) throw new Error("Class not found");

  // #1319 / #1554 — enrol the payer on the class's one wrapper, exactly as
  // handleClassCheckout does. This used to CREATE an appointment per buyer,
  // holding one seat row spanning the scheduling period — months wide, with
  // no `consultantProfileId` — and every enrolment added a phantom session
  // to the class. A wrapper with no occurrences is an unscheduled class:
  // seating the payer on it enrols them in a class with no time on the
  // calendar, so it is refused like an unscheduled webinar.
  const wrapper = classInstance.appointment;
  if (!wrapper || wrapper.occurrences.length === 0) {
    throw new Error("Class has not been scheduled. Cannot create booking.");
  }

  // The checkout gate, replayed against the roster as it stands NOW — the
  // first-confirmed-wins recheck in confirmExistingAppointment deliberately
  // skips group events, so without this a recovery capture seats a buyer past
  // the room and is never given back. Required, exactly as the webinar arm: an
  // unreadable capacity is a fault, not a pass.
  const capacity = getClassCapacity({
    classInstance,
    plan: classInstance.classPlan,
    excludeUserIds: [
      classInstance.classPlan.consultantProfile?.userId,
      data.userId,
    ].filter((id): id is string => !!id),
  });
  if (capacity.isFull) {
    return await refuseFullEventCapture(tx, {
      kind: "class",
      eventId: data.eventId,
      appointmentId: wrapper.id,
      userId: data.userId,
      registered: capacity.registered,
      max: capacity.max,
    });
  }

  // #1319 A9 — one participant row per purchase, matching handleClassCheckout.
  // HELD for the same reason as the webinar arm: the B2 CAS in
  // confirmExistingAppointment, not this creator, decides whether a capture
  // on a terminal class is allowed to confirm anything.
  await recordParticipants(
    tx,
    wrapper.id,
    [{ userId: data.userId, role: "CONSULTEE" }],
    { status: "HELD", organizationId: data.organizationId },
  );

  const createdAppointment = await tx.appointment.findUnique({
    where: { id: wrapper.id },
    include: { occurrences: true },
  });
  if (!createdAppointment) {
    throw new Error("Failed to fetch created appointment");
  }
  return createdAppointment;
}

// ============================================================================
// Appointment State Management
// ============================================================================

/**
 * Confirm consultation or subscription status after successful payment
 * Transitions APPROVED_PENDING_PAYMENT → APPROVED
 */
/**
 * B2 — the capture's liveness CAS on a group event: SCHEDULED is re-stamped
 * only from a live state, so a capture after the event was cancelled matches
 * nothing. #1846 SM-B13 — through the helpers, so the stamp writes its history
 * row. Returns false on the miss, which the caller reads fresh to tell a
 * benign replay from a capture after a terminal state.
 */
async function restampLiveEvent(
  tx: Tx,
  kind: "class" | "webinar",
  id: string,
  appointmentId: string,
): Promise<boolean> {
  const args = {
    reason: "seat payment captured",
    appointmentId,
    where: { id },
    to: "SCHEDULED" as const,
  };
  try {
    // SCHEDULED only: the map also allows IN_PROGRESS → SCHEDULED (reschedule
    // re-entry), and a seat bought during a live session must not pull the
    // event back. An IN_PROGRESS event misses here and the caller's fresh
    // read treats it as benign, so the seat still confirms.
    if (kind === "class") {
      await transitionClassEvent(tx, { ...args, fromIn: ["SCHEDULED"] });
    } else {
      await transitionWebinarEvent(tx, { ...args, fromIn: ["SCHEDULED"] });
    }
    return true;
  } catch (err) {
    if (err instanceof IllegalTransitionError) return false;
    throw err;
  }
}

/** The request states a capture may legitimately land on (#1583 A-P0-01). */
const LIVE_REQUEST_STATUSES: ReadonlySet<AppointmentStatus> = new Set([
  AppointmentStatus.PENDING,
  AppointmentStatus.APPROVED_PENDING_PAYMENT,
  AppointmentStatus.APPROVED,
  AppointmentStatus.SCHEDULED,
  AppointmentStatus.COMPLETED,
]);

/**
 * What a capture found when it went to confirm the buyer's seat.
 *
 * `confirmed` — a HELD seat was promoted. `duplicate` — the CAS matched
 * nothing because the row is already live (CONFIRMED/ATTENDED): a redelivered
 * capture, which must stay the no-op it has always been. `released` /
 * `missing` — there is no seat left to confirm, so the money bought nothing and
 * has to go back.
 */
type SeatCaptureOutcome =
  | { kind: "confirmed" }
  | { kind: "duplicate" }
  | { kind: "released"; participantId: string }
  | { kind: "missing" };

/**
 * Confirm the buyer's seat, or say why there was nothing to confirm.
 *
 * The status CAS on the participant row is the only thing that knows whether
 * this capture still has a seat, and its matched count used to be discarded. A
 * buyer who left a webinar or class BEFORE the card captured therefore kept the
 * money with the seat already released, and nothing noticed: the event guard
 * above had passed (the event wrapper is still live), the CAS matched zero
 * rows, and the handler reported a successful confirmation. The orphan is
 * detectable — the seat row keeps the `paymentId` stamped at creation — but no
 * sweep looks for a SUCCEEDED payment whose seat is not live, so the money sat
 * there until a human noticed the refund never came.
 *
 * The re-read runs inside this transaction because the CAS predicate narrows on
 * `HELD`: the fresh row is the only place the real status is visible. It is
 * ordered newest-first because pre-#1319 data can hold one row per session
 * appointment for the same buyer, and the capture's own seat is the newest.
 */
async function confirmSeatAfterCapture(
  tx: Tx,
  args: {
    /** The CAS predicate; narrows the move to the seat's live-from state. */
    casWhere: Prisma.AppointmentParticipantWhereInput;
    /** The same rows without the status narrowing, for the re-read. */
    readWhere: Prisma.AppointmentParticipantWhereInput;
    kind: "class" | "webinar";
    eventId: string;
    appointmentId: string;
    userId: string;
  },
): Promise<SeatCaptureOutcome> {
  if ((await transitionParticipant(tx, args.casWhere, "CONFIRMED")) > 0) {
    return { kind: "confirmed" };
  }
  const fresh = await tx.appointmentParticipant.findFirst({
    where: args.readWhere,
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, paymentId: true },
  });
  // No row at all is a different problem from a released one — a seat that
  // should exist and does not — but the buyer's answer is the same either way,
  // so it takes the refund path and says so distinctly.
  if (!fresh) {
    await reportUnseatedCapture(tx, {
      kind: args.kind,
      eventId: args.eventId,
      appointmentId: args.appointmentId,
      userId: args.userId,
      reason: `no participant row exists for ${args.userId} on ${args.kind} ${args.eventId}`,
      participantId: null,
      seatStatus: null,
      seatPaymentId: null,
    });
    return { kind: "missing" };
  }
  if (!RELEASED_PARTICIPANT_STATUSES.includes(fresh.status)) {
    // Already CONFIRMED/ATTENDED: the same capture delivered twice. Nothing to
    // move, nothing to return, nothing to say.
    return { kind: "duplicate" };
  }
  await reportUnseatedCapture(tx, {
    kind: args.kind,
    eventId: args.eventId,
    appointmentId: args.appointmentId,
    userId: args.userId,
    reason: `the seat is ${fresh.status} — the buyer left before the payment captured`,
    participantId: fresh.id,
    seatStatus: fresh.status,
    seatPaymentId: fresh.paymentId,
  });
  return {
    kind: "released",
    participantId: fresh.id,
  };
}

/**
 * The durable + paged record of a capture that has no seat to confirm. Once
 * per seat: the orphan re-drive sweep re-enters this branch on a seat already
 * refunded, and a marker that multiplied on every tick would bury the one row
 * an operator needs.
 */
async function reportUnseatedCapture(
  tx: Tx,
  args: {
    kind: "class" | "webinar";
    eventId: string;
    appointmentId: string;
    userId: string;
    reason: string;
    participantId: string | null;
    seatStatus: string | null;
    seatPaymentId: string | null;
  },
): Promise<void> {
  const correlationId = `capture-unseated-seat:${args.participantId ?? args.appointmentId}`;
  const alreadyRecorded = await tx.systemEvent.findFirst({
    where: { correlationId, category: "PAYMENT" },
    select: { id: true },
  });
  if (alreadyRecorded) return;
  // #1582 B-P1-02 — through the tx (PG_POOL_MAX=1); the probe above rides the
  // same snapshot.
  await recordSystemErrorSafe({
    organizationId: null,
    category: "PAYMENT",
    summary: `Payment captured for ${args.kind} ${args.eventId} with no seat to confirm (${args.reason}) — refunding`,
    err: new Error("CAPTURE_AFTER_SEAT_RELEASE"),
    context: {
      entityType: args.kind,
      entityId: args.eventId,
      appointmentId: args.appointmentId,
      userId: args.userId,
      participantId: args.participantId,
      seatStatus: args.seatStatus,
      seatPaymentId: args.seatPaymentId,
      // Kept in the row, not only in the summary, so ops can tell the two
      // shapes apart without parsing prose.
      reason: args.reason,
    },
    correlationId,
    db: tx,
  });
  reportSentryError(new Error("CAPTURE_AFTER_SEAT_RELEASE"), {
    subsystem: "payments",
    expected: true,
    level: "warning",
    contexts: {
      booking: {
        appointmentId: args.appointmentId,
        eventId: args.eventId,
        eventType: args.kind,
        userId: args.userId,
        participantId: args.participantId,
        seatStatus: args.seatStatus,
      },
    },
  });
  console.error(
    JSON.stringify({
      event: "capture_after_seat_release",
      appointmentId: args.appointmentId,
      eventId: args.eventId,
      eventType: args.kind,
      userId: args.userId,
      participantId: args.participantId,
      seatStatus: args.seatStatus,
      action_required: "auto-refund attempted; reconcile only if it failed",
      timestamp: new Date().toISOString(),
    }),
  );
}

async function confirmApprovalStatus(
  tx: Tx,
  entityType: "consultation" | "subscription",
  entityId: string,
  appointmentId?: string,
): Promise<{ capturedAfterTerminal: boolean }> {
  // #855 — signals Phase 2 to auto-refund a capture that landed after the
  // booking was cancelled (money collected for a now-dead booking).
  let capturedAfterTerminal = false;
  if (entityType === "consultation") {
    const consultation = await tx.consultation.findUnique({
      where: { id: entityId },
    });

    if (!consultation) {
      throw new Error(`Consultation ${entityId} not found`);
    }

    // B2 (#825 CAS doctrine) — APPROVED is only reachable from the two
    // pre-payment states. The old else-branch moved ANY status → APPROVED,
    // so a capture landing after a cancel resurrected the booking. Now the
    // guard rides the WHERE; a late capture against a terminal booking is
    // money collected for nothing — surface it for refund instead.
    // #1846 SM-B13 — through the helper, so the capture writes its history
    // row like the subscription arm below; the zero-row throw is the miss.
    let movedConsult = true;
    try {
      await transitionConsultationRequest(tx, {
        where: { id: entityId },
        to: AppointmentStatus.APPROVED,
        fromIn: [
          AppointmentStatus.PENDING,
          AppointmentStatus.APPROVED_PENDING_PAYMENT,
        ],
        reason: "payment captured",
        appointmentId,
      });
    } catch (err) {
      if (!(err instanceof IllegalTransitionError)) throw err;
      movedConsult = false;
    }
    if (!movedConsult) {
      // Re-read: the pre-read raced the very transition that made the CAS
      // miss, so logging it would report the wrong state (review catch on
      // #844). The fresh value decides whether this is benign (already
      // APPROVED/SCHEDULED/COMPLETED) or money-for-nothing.
      const fresh = await tx.consultation.findUnique({
        where: { id: entityId },
        select: { status: true },
      });
      const freshStatus = fresh?.status ?? consultation.status;
      if (
        freshStatus !== AppointmentStatus.APPROVED &&
        freshStatus !== AppointmentStatus.SCHEDULED &&
        freshStatus !== AppointmentStatus.COMPLETED
      ) {
        capturedAfterTerminal = true; // #855 — Phase 2 auto-refunds
        // #1582 B-P1-02 — through the tx (PG_POOL_MAX=1); the catch keeps a
        // telemetry failure from aborting money.
        await recordSystemErrorSafe({
          organizationId: null,
          category: "PAYMENT",
          summary: `Payment captured for consultation ${entityId} in terminal state ${freshStatus} — refund needed`,
          err: new Error("CAPTURE_AFTER_TERMINAL_STATE"),
          context: { entityType: "consultation", entityId },
          db: tx,
        });
      }
    }
  } else {
    // Read through the tx, so this is the snapshot the CAS below runs in.
    const subscription = await tx.subscription.findUnique({
      where: { id: entityId },
      select: { status: true },
    });

    if (!subscription) {
      throw new Error(`Subscription ${entityId} not found`);
    }

    const flagTerminal = async (status: AppointmentStatus) => {
      capturedAfterTerminal = true; // #855 — Phase 2 auto-refunds
      // #1582 B-P1-02 — through the tx (PG_POOL_MAX=1).
      await recordSystemErrorSafe({
        organizationId: null,
        category: "PAYMENT",
        summary: `Payment captured for subscription ${entityId} in terminal state ${status} — refund needed`,
        err: new Error("CAPTURE_AFTER_TERMINAL_STATE"),
        context: { entityType: "subscription", entityId },
        db: tx,
      });
    };

    // For subscriptions: Only transition APPROVED_PENDING_PAYMENT → APPROVED
    // Do NOT change PENDING → APPROVED here!
    // Subscription stays PENDING until consultant allocates slots via Requests tab
    // SchedulingService.allocate() will set status to APPROVED when slots are allocated
    if (subscription.status === AppointmentStatus.APPROVED_PENDING_PAYMENT) {
      try {
        // #1583 A-P1-04 — the guarded helper: same CAS, plus the history row.
        await transitionSubscriptionRequest(tx, {
          where: { id: entityId },
          to: AppointmentStatus.APPROVED,
          fromIn: [AppointmentStatus.APPROVED_PENDING_PAYMENT],
          reason: "payment captured",
          appointmentId,
        });
        console.log(
          `✅ Subscription ${entityId} payment completed - moving from APPROVED_PENDING_PAYMENT to APPROVED`,
        );
      } catch (err) {
        if (!(err instanceof IllegalTransitionError)) throw err;
        // A racing writer moved the row between the read and the CAS; the
        // fresh status decides benign (still live) or money-for-nothing.
        const fresh = await tx.subscription.findUnique({
          where: { id: entityId },
          select: { status: true },
        });
        const freshStatus = fresh?.status ?? subscription.status;
        if (LIVE_REQUEST_STATUSES.has(freshStatus)) {
          console.log(
            `ℹ️ Subscription ${entityId} already ${freshStatus} when the capture landed — nothing to move`,
          );
        } else {
          await flagTerminal(freshStatus);
        }
      }
    } else if (!LIVE_REQUEST_STATUSES.has(subscription.status)) {
      // #1583 A-P0-01 — REJECTED and EXPIRED are as dead as CANCELLED: a
      // capture on any of them is money for a booking nobody will deliver.
      await flagTerminal(subscription.status);
    } else {
      console.log(
        `ℹ️ Subscription ${entityId} payment received - keeping status as ${subscription.status} (consultant will allocate slots)`,
      );
    }
  }
  return { capturedAfterTerminal };
}

/**
 * Confirm appointment by making slots non-tentative and updating status
 *
 * FIX Issue #1 & #3: For multi-user events (WEBINAR, CLASS), only confirm
 * the paying user's slots, not all slots for the shared appointment.
 *
 * @param tx - Prisma transaction client
 * @param appointmentId - The appointment ID to confirm
 * @param userId - The paying user's ID (required for WEBINAR/CLASS to prevent confirming other users' slots)
 */
// Exported for the #827 regression tests; only handlePaymentSuccess calls it in prod.
export async function confirmExistingAppointment(
  tx: Tx,
  appointmentId: string,
  userId?: string,
  /** #1861 L1 — the capturing payment's hold had lapsed before the capture. */
  opts?: { holdExpired?: boolean; now?: Date },
): Promise<{
  capturedAfterTerminal: boolean;
  doubleBookingBlocked?: boolean;
  /**
   * Set when a group event's seat was the thing that died under the capture, so
   * Phase 2 returns the money through the SEAT front door rather than the
   * generic one — an org-funded seat has no gateway to credit.
   */
  seatRefund?: ReleasedSeatRefund;
}> {
  // First fetch appointment to determine type
  const appointment = await tx.appointment.findUnique({
    where: { id: appointmentId },
    include: {
      consultation: true,
      subscription: true,
      webinar: true,
      class: true,
    },
  });

  if (!appointment) {
    console.warn(`Appointment ${appointmentId} not found for confirmation`);
    return { capturedAfterTerminal: false };
  }

  // #827 — first-confirmed-wins recheck for the EXCLUSIVE booking types.
  // Checkout's hard-overlap check only blocks against isTentative:false
  // slots and its tentative dedup is same-user-only, so two different users
  // can both pay for overlapping slots; whichever capture webhook lands
  // second must NOT flip its slots confirmed over the winner's. The loser
  // stays tentative (the orphan/refund path picks it up, see #830) and the
  // conflict is surfaced loudly instead of double-booking the consultant.
  // Webinars/classes are capacity-based, not exclusive — skipped.
  if (appointment.consultation || appointment.subscription) {
    // FAMILIARISE_WEB-46 — a row a reschedule released in place is still
    // isTentative; it is not a hold and must not be checked or flipped.
    const mySlots = await tx.appointmentOccurrence.findMany({
      where: { appointmentId, isTentative: true, ...liveOccurrenceWhere },
      select: { id: true, startsAt: true, endsAt: true },
    });
    // The non-booker participants (the consultant) attend both bookings —
    // a confirmed overlapping occurrence sharing one of them is a true conflict.
    const participantIds = (
      await tx.appointmentParticipant.findMany({
        where: { appointmentId, ...liveParticipant() },
        select: { userId: true },
      })
    )
      .map((p) => p.userId)
      .filter((id) => id !== userId);
    // #1861 L1 — an expired hold loses to a live foreign hold as well as to a
    // confirmed row. "Live" is checkout step 1's predicate (validateSlotAvailability):
    // an occupying appointment not matched by buildDeadHoldFilter, on a
    // non-tombstoned occurrence of another appointment.
    const holdExpired = opts?.holdExpired === true;
    const now = opts?.now ?? new Date();
    const conflictStates: Prisma.AppointmentOccurrenceWhereInput = holdExpired
      ? {
          OR: [
            { isTentative: false },
            {
              isTentative: true,
              ...liveOccurrenceWhere,
              appointmentId: { not: appointmentId },
              appointment: { NOT: buildDeadHoldFilter(now) },
            },
          ],
        }
      : { isTentative: false };
    for (const slot of mySlots) {
      if (participantIds.length === 0) continue;
      const conflict = await tx.appointmentOccurrence.findFirst({
        where: {
          id: { not: slot.id },
          startsAt: { lt: slot.endsAt },
          endsAt: { gt: slot.startsAt },
          ...conflictStates,
          appointment: {
            OR: buildOccupiedAppointmentFilter(),
            participants: {
              some: { userId: { in: participantIds }, ...liveParticipant() },
            },
          },
        },
        select: { id: true, appointmentId: true },
      });
      if (conflict) {
        // Modelled outcome — the #827 first-confirmed-wins guard working as
        // designed (lost race). Phase 2 auto-refunds the loser; still
        // reported at "warning" (not "info") since it needs that follow-up.
        reportSentryError(new Error("CONFIRMATION_BLOCKED_DOUBLE_BOOKING"), {
          subsystem: "payments",
          expected: true,
          level: "warning",
          // #1861 — tells a late capture on a lapsed hold from a #827 race.
          tags: { expiredHold: String(holdExpired) },
          contexts: {
            booking: {
              appointmentId,
              conflictingAppointmentId: conflict.appointmentId,
              slotId: slot.id,
              expiredHold: holdExpired,
            },
          },
        });
        console.error(
          JSON.stringify({
            event: "confirmation_blocked_double_booking",
            appointmentId,
            conflictingAppointmentId: conflict.appointmentId,
            slotId: slot.id,
            expiredHold: holdExpired,
            timestamp: new Date().toISOString(),
          }),
        );
        // Once per appointment, not per sweep tick: the #830 re-drive hits
        // this branch every 5 minutes until the refund lands (FAMILIARISE_WEB-46).
        const correlationId = `double-booking-blocked:${appointmentId}`;
        const alreadyRecorded = await tx.systemEvent.findFirst({
          where: { correlationId, category: "PAYMENT" },
          select: { id: true },
        });
        if (!alreadyRecorded) {
          // #1582 B-P1-02 — through the tx (PG_POOL_MAX=1); also keeps the
          // once-per-appointment probe above in the same snapshot.
          await recordSystemErrorSafe({
            organizationId: null,
            category: "PAYMENT",
            summary: holdExpired
              ? `Double-booking blocked at confirmation (expired hold): appointment ${appointmentId} was paid after its hold lapsed and another buyer now holds the slot — the payment needs a refund`
              : `Double-booking blocked at confirmation: appointment ${appointmentId} overlaps an already-confirmed slot — the payment needs a refund`,
            err: new Error("CONFIRMATION_BLOCKED_DOUBLE_BOOKING"),
            context: {
              appointmentId,
              conflictingAppointmentId: conflict.appointmentId,
              slotId: slot.id,
              expiredHold: holdExpired,
            },
            correlationId,
            db: tx,
          });
        }
        // #837 — slots stay tentative here; the webhook's Phase 2 auto-refunds
        // the loser and releases the hold. The #830 sweep re-drives via this
        // same guard and reports (doesn't refund), so signalling the block up is
        // what routes the refund without fighting the guard.
        return { capturedAfterTerminal: false, doubleBookingBlocked: true };
      }
    }
  }

  // FIX Issue #3: For CLASS, confirm ALL user's slots across all sessions
  // Classes have multiple appointments (one per session), but payment only links to first
  //
  // B2 (booking-journey audit) — the status stamp and the slot flips are
  // GUARDED now. The old code stamped SCHEDULED with a blind update, so a
  // capture landing after the event was cancelled resurrected it to
  // SCHEDULED and re-confirmed the payer's slots on a dead event — money
  // kept, event undead. The guard rides the WHERE (CAS doctrine); a miss
  // means the event moved underneath us, and the fresh read decides benign
  // replay (already live/done — flip slots, keep money) vs capture-after-
  // terminal (CANCELLED/DRAFT — refund via Phase 2, touch nothing).
  const BENIGN_EVENT_STATUSES = ["SCHEDULED", "IN_PROGRESS", "COMPLETED"];

  if (appointment.class && userId) {
    const classId = appointment.class.id;
    if (!(await restampLiveEvent(tx, "class", classId, appointmentId))) {
      const fresh = await tx.class.findUnique({
        where: { id: classId },
        select: { status: true },
      });
      if (!fresh || !BENIGN_EVENT_STATUSES.includes(fresh.status)) {
        // #1582 B-P1-02 — through the tx (PG_POOL_MAX=1).
        await recordSystemErrorSafe({
          organizationId: null,
          category: "PAYMENT",
          summary: `Payment captured for class ${classId} in non-live state ${fresh?.status ?? "unknown"} — refund needed`,
          err: new Error("CAPTURE_AFTER_TERMINAL_STATE"),
          context: { entityType: "class", entityId: classId },
          db: tx,
        });
        return { capturedAfterTerminal: true };
      }
    }

    // #1554 — a seat is the participant row, and the class's occurrences are
    // the consultant's confirmed allocation shared by every attendee, so the
    // capture flips the seat and never the occurrences. Only a HELD seat
    // confirms: a capture landing on a cancelled seat must not resurrect it
    // (the refund arm below handles the money).
    //
    // The CAS count used to be dropped, so a capture that arrived after the
    // buyer left the class confirmed nothing, reported success, and kept the
    // money on a seat that no longer existed. `confirmSeatAfterCapture` reads
    // the row the CAS could not move and names the case.
    const seat = await confirmSeatAfterCapture(tx, {
      casWhere: {
        appointment: { classId: appointment.class.id },
        userId,
        status: "HELD",
      },
      readWhere: { appointment: { classId: appointment.class.id }, userId },
      kind: "class",
      eventId: classId,
      appointmentId,
      userId,
    });
    if (seat.kind === "released" || seat.kind === "missing") {
      return {
        capturedAfterTerminal: true,
        seatRefund: {
          kind: "class",
          eventId: classId,
          participantId: seat.kind === "released" ? seat.participantId : null,
        },
      };
    }

    console.log(
      JSON.stringify({
        event: "class_all_sessions_confirmed",
        classId: appointment.class.id,
        userId,
        timestamp: new Date().toISOString(),
      }),
    );
  }
  // FIX Issue #1: For WEBINAR, confirm only the paying user's slot
  // Webinars share one appointment among all participants
  else if (appointment.webinar && userId) {
    const webinarId = appointment.webinar.id;
    if (!(await restampLiveEvent(tx, "webinar", webinarId, appointmentId))) {
      const fresh = await tx.webinar.findUnique({
        where: { id: webinarId },
        select: { status: true },
      });
      if (!fresh || !BENIGN_EVENT_STATUSES.includes(fresh.status)) {
        // #1582 B-P1-02 — through the tx (PG_POOL_MAX=1).
        await recordSystemErrorSafe({
          organizationId: null,
          category: "PAYMENT",
          summary: `Payment captured for webinar ${webinarId} in non-live state ${fresh?.status ?? "unknown"} — refund needed`,
          err: new Error("CAPTURE_AFTER_TERMINAL_STATE"),
          context: { entityType: "webinar", entityId: webinarId },
          db: tx,
        });
        return { capturedAfterTerminal: true };
      }
    }

    // #1554 — same as the class arm: the seat flips, the shared occurrences
    // do not. And the same zero-row case: a buyer who left the webinar before
    // the card captured has no seat to confirm, so the money goes back rather
    // than being reported as a confirmed booking.
    const seat = await confirmSeatAfterCapture(tx, {
      casWhere: { appointmentId, userId, status: "HELD" },
      readWhere: { appointmentId, userId },
      kind: "webinar",
      eventId: webinarId,
      appointmentId,
      userId,
    });
    if (seat.kind === "released" || seat.kind === "missing") {
      return {
        capturedAfterTerminal: true,
        seatRefund: {
          kind: "webinar",
          eventId: webinarId,
          participantId: seat.kind === "released" ? seat.participantId : null,
        },
      };
    }

    console.log(
      JSON.stringify({
        event: "webinar_user_slot_confirmed",
        webinarId: appointment.webinar.id,
        userId,
        timestamp: new Date().toISOString(),
      }),
    );
  }
  // For CONSULTATION and SUBSCRIPTION: original behavior (single user per appointment)
  else {
    // Live rows only — a released (RESCHEDULED) row flipped back would
    // re-block the consultant's old time and break reschedule withdrawal.
    await tx.appointmentOccurrence.updateMany({
      where: { appointmentId, ...liveOccurrenceWhere },
      data: { isTentative: false },
    });
    await transitionParticipant(
      tx,
      { appointmentId, status: "HELD" },
      "CONFIRMED",
    );
    // #1778 — the buyer's own backup interest in these times is fulfilled.
    if (userId) await markBookedWindows(tx, appointmentId, userId);
  }

  // Update status for consultation and subscription
  let capturedAfterTerminal = false;
  if (appointment.consultation) {
    const r = await confirmApprovalStatus(
      tx,
      "consultation",
      appointment.consultation.id,
    );
    capturedAfterTerminal = capturedAfterTerminal || r.capturedAfterTerminal;
  }

  if (appointment.subscription) {
    const r = await confirmApprovalStatus(
      tx,
      "subscription",
      appointment.subscription.id,
      appointmentId,
    );
    capturedAfterTerminal = capturedAfterTerminal || r.capturedAfterTerminal;
  }

  // Webinar/class status stamps moved ABOVE, next to their slot flips: the
  // stamp is now the CAS guard that decides whether those flips may run at
  // all (B2). A blind re-stamp here would resurrect a cancelled event after
  // the guard above correctly refused it.

  return { capturedAfterTerminal };
}

/** #1778 — every confirmed window of this booking marks the buyer's own interest BOOKED. */
async function markBookedWindows(
  tx: Tx,
  appointmentId: string,
  userId: string,
) {
  const windows = await tx.appointmentOccurrence.findMany({
    where: {
      appointmentId,
      ...liveOccurrenceWhere,
      consultantProfileId: { not: null },
    },
    select: { consultantProfileId: true, startsAt: true, endsAt: true },
  });
  for (const w of windows) {
    if (!w.consultantProfileId) continue;
    await markBackupInterestBooked(tx, userId, {
      consultantProfileId: w.consultantProfileId,
      windowStart: w.startsAt,
      windowEnd: w.endsAt,
    });
  }
}

/**
 * #1846 N2 — rewrite a pending auto-refund marker to its settled form. A CAS
 * on the marker itself, so a concurrent writer that already settled or
 * replaced the description is left alone.
 */
export async function settleAutoRefundMarker(paymentId: string): Promise<void> {
  const row = await prisma.payment.findUnique({
    where: { id: paymentId },
    select: { description: true },
  });
  const pending = row?.description;
  if (!pending?.startsWith(AUTO_REFUND_PENDING_PREFIX)) return;
  await prisma.payment.updateMany({
    where: { id: paymentId, description: pending },
    data: { description: settledAutoRefundDescription(pending) },
  });
}

/**
 * Release the tentative hold of a double-booking loser once its money is
 * back. Shared by Phase 2 and retry-auto-refunds (#1846 N2).
 */
export async function releaseBlockedBookingHold(
  appointmentId: string,
): Promise<void> {
  await withSerializableRetry(() =>
    prisma.$transaction(
      (tx) => cleanupFailedPaymentAppointment(tx, appointmentId),
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 15_000,
      },
    ),
  );
}

/**
 * Clean up tentative appointments for failed payments
 */
async function cleanupFailedPaymentAppointment(tx: Tx, appointmentId: string) {
  const appointment = await tx.appointment.findUnique({
    where: { id: appointmentId },
    include: {
      occurrences: true,
      consultation: true,
      subscription: true,
    },
  });

  if (!appointment) return;

  // Live holds only: a previously released row is soft-cancelled, not gone,
  // and counting it here would re-run this arm on every replayed failure.
  const tentativeSlots = appointment.occurrences.filter(
    (slot) => slot.isTentative && slot.deletedAt === null,
  );

  if (tentativeSlots.length > 0) {
    // Doctrine rule 2: the hold is freed by status, so the slot survives for
    // the dispute trail that a failed payment is most likely to need.
    await transitionOccurrenceCompletion(tx, {
      where: { appointmentId, isTentative: true, deletedAt: null },
      to: OccurrenceCompletionStatus.CANCELLED,
      data: { deletedAt: new Date() },
      allowZero: true,
    });

    if (appointment.consultation || appointment.subscription) {
      // Live rows only — the release above leaves its rows in place, so an
      // unfiltered count would never reach zero and the EXPIRED transition
      // this gates would never fire again.
      const remainingSlots = await tx.appointmentOccurrence.count({
        where: { appointmentId, deletedAt: null },
      });
      if (remainingSlots === 0) {
        // Soft-delete: transition to EXPIRED status instead of hard-deleting
        // to preserve audit trails for support/disputes/refunds.
        // #836 — the guard rides the WHERE with the map's own from-set
        // (PENDING, APPROVED_PENDING_PAYMENT, APPROVED): a terminal booking is
        // never expired from here, and a zero-row CAS means it already moved
        // on, which #1583 A-P1-04 logs rather than swallows.
        const expireArgs = {
          to: AppointmentStatus.EXPIRED,
          fromIn: REQUEST_ALLOWED_FROM.EXPIRED,
          reason: "payment failed",
          appointmentId,
        };
        const alreadyMovedOn = (entity: string, id: string) =>
          console.warn(
            `ℹ️ ${entity} ${id} already left the expirable set before the failed-payment cleanup; nothing to expire`,
          );
        if (appointment.consultation) {
          try {
            await transitionConsultationRequest(tx, {
              where: { id: appointment.consultation.id },
              ...expireArgs,
            });
          } catch (err) {
            if (!(err instanceof IllegalTransitionError)) throw err;
            alreadyMovedOn("Consultation", appointment.consultation.id);
          }
        }
        if (appointment.subscription) {
          try {
            await transitionSubscriptionRequest(tx, {
              where: { id: appointment.subscription.id },
              ...expireArgs,
            });
          } catch (err) {
            if (!(err instanceof IllegalTransitionError)) throw err;
            alreadyMovedOn("Subscription", appointment.subscription.id);
          }
        }
      }
    }
  }
}

// ============================================================================
// Email Notification Helpers
// ============================================================================

/**
 * #1654 / #1653 — the one appointment read both Phase-1 emails share, through
 * the caller's transaction. Null is reported here so neither stager has to.
 */
async function loadAppointmentForEmails(tx: Tx, appointmentId: string) {
  const appointment = await tx.appointment.findUnique({
    where: { id: appointmentId },
    include: {
      // #1653 — the booked email names a time; a subscription placeholder
      // has none yet and is skipped, as Phase 2's bell is.
      occurrences: {
        where: liveOccurrenceWhere,
        orderBy: { startsAt: "asc" },
        take: 1,
        select: { startsAt: true },
      },
      consultation: {
        include: {
          consultationPlan: {
            include: {
              consultantProfile: {
                include: {
                  user: true,
                },
              },
            },
          },
        },
      },
      subscription: {
        include: {
          subscriptionPlan: {
            include: {
              consultantProfile: {
                include: {
                  user: true,
                },
              },
            },
          },
        },
      },
      webinar: {
        include: {
          webinarPlan: {
            include: {
              consultantProfile: {
                include: { user: { select: { id: true, name: true } } },
              },
            },
          },
        },
      },
      class: {
        include: {
          classPlan: {
            include: {
              consultantProfile: {
                include: { user: { select: { id: true, name: true } } },
              },
            },
          },
        },
      },
    },
  });

  if (!appointment) {
    reportSentryError(
      new Error(
        `Cannot send payment success email: appointment ${appointmentId} not found`,
      ),
      { subsystem: "payments", level: "warning" },
    );
    console.error(
      `Cannot send payment success email: appointment ${appointmentId} not found`,
    );
  }
  return appointment;
}

type AppointmentForEmails = NonNullable<
  Awaited<ReturnType<typeof loadAppointmentForEmails>>
>;

// Whichever of the four plan shapes the appointment has.
function planForEmails(appointment: AppointmentForEmails) {
  return (
    appointment.consultation?.consultationPlan ??
    appointment.subscription?.subscriptionPlan ??
    appointment.webinar?.webinarPlan ??
    appointment.class?.classPlan ??
    null
  );
}

/**
 * #1654 — renders the receipt from the shared read and stages the outbox row
 * in the caller's transaction. Returns null (reported) when there is nothing
 * to send; a database failure propagates so the business write and the row
 * roll back together.
 */
async function stagePaymentSuccessEmail(
  tx: Tx,
  payment: PaymentWithUser,
  appointment: AppointmentForEmails,
  appointmentType: string,
): Promise<StagedOutboxEmail | null> {
  const consultantName =
    planForEmails(appointment)?.consultantProfile?.user?.name || "Consultant";
  const amount = payment.amount;
  const currency = payment.currency;

  // Render is pure CPU; a render failure has nothing to replay, so it is
  // reported and the receipt skipped, never the payment.
  let message: RenderedEmail;
  try {
    message = await renderPaymentSuccessEmail({
      email: payment.user.email || "",
      name: payment.user.name || "User",
      consultantName,
      appointmentType: appointmentType.toLowerCase() as
        | "consultation"
        | "subscription"
        | "webinar"
        | "class",
      amount,
      currency,
      // #1527 — the recipient is always the payer.
      dashboardUrl: `${getAppUrl()}${goHref("client", "appointments")}`,
      paymentReference: payment.id,
    });
  } catch (error) {
    reportSentryError(error, { subsystem: "payments", level: "warning" });
    console.error("Failed to render payment success email:", error);
    return null;
  }

  const staged = await stageEmail(message, "PAYMENT_SUCCESS", {
    tx,
    entityRef: `payment:${payment.id}`,
  });
  return staged ? { staged, message } : null;
}

/**
 * #1653 — the booked confirmation to payer and consultant, staged next to
 * the receipt. Mirrors Phase 2's bell: the plan title is resolved the same
 * way (#1484), a placeholder with no session yet sends nothing (B9), and the
 * href is the org route or the /dashboard bounce. Recipients are read
 * through `tx`; a render failure is dropped inside, a staging failure
 * propagates with the transaction.
 */
async function stageBookedEmails(
  tx: Tx,
  payment: PaymentWithUser,
  appointment: AppointmentForEmails,
  appointmentType: string,
): Promise<StagedRecipientEmail[]> {
  const startsAt = appointment.occurrences[0]?.startsAt;
  if (!startsAt) return [];
  const plan = planForEmails(appointment);
  const planTitle =
    appointmentType === AppointmentsType.TRIAL
      ? "Trial session"
      : planTitleOrSessionLabel(plan?.title ?? null, appointmentType);
  return stageAppointmentBookedEmail(tx, {
    appointmentId: appointment.id,
    consulteeUserId: payment.userId,
    consultantUserId: plan?.consultantProfile?.user?.id ?? null,
    consulteeName: payment.user.name || "User",
    consultantName: plan?.consultantProfile?.user?.name || "Consultant",
    planTitle,
    appointmentType,
    startsAt,
    dashboardUrl: notificationHref(appointment.organizationId, "appointments"),
  });
}

/** #1654 — the failure notice's twin of {@link stagePaymentSuccessEmail}. */
async function stagePaymentFailedEmail(
  tx: Tx,
  payment: {
    id: string;
    appointmentId: string | null;
    amount: number;
    currency: string;
    description: string | null;
    user: { email: string | null; name: string | null };
  },
): Promise<StagedOutboxEmail | null> {
  const consultantUserSelect = {
    select: {
      consultantProfile: {
        select: { user: { select: { name: true } } },
      },
    },
  } as const;
  const appointment = await tx.appointment.findUnique({
    where: { id: payment.appointmentId || "" },
    select: {
      consultation: {
        select: { id: true, consultationPlan: consultantUserSelect },
      },
      subscription: {
        select: { id: true, subscriptionPlan: consultantUserSelect },
      },
    },
  });

  if (!appointment) {
    reportSentryError(
      new Error(
        `Cannot send payment failure email: appointment not found for payment ${payment.id}`,
      ),
      { subsystem: "payments", level: "warning" },
    );
    console.error(
      `Cannot send payment failure email: appointment not found for payment ${payment.id}`,
    );
    return null;
  }

  let consultantName = "Consultant";
  let appointmentType: "consultation" | "subscription" = "consultation";
  // #1527 — the recipient is always the payer; overridden below when a
  // specific booking is known.
  let retryUrl = `${getAppUrl()}${goHref("client", "payments")}`;

  // Get consultant name and appointment type
  if (appointment.consultation?.consultationPlan?.consultantProfile?.user) {
    consultantName =
      appointment.consultation.consultationPlan.consultantProfile.user.name ||
      "Consultant";
    appointmentType = "consultation";
    retryUrl = `${getAppUrl()}/consultations/${appointment.consultation.id}/payment`;
  } else if (
    appointment.subscription?.subscriptionPlan?.consultantProfile?.user
  ) {
    consultantName =
      appointment.subscription.subscriptionPlan.consultantProfile.user.name ||
      "Consultant";
    appointmentType = "subscription";
    retryUrl = `${getAppUrl()}/subscriptions/${appointment.subscription.id}/payment`;
  }

  let message: RenderedEmail;
  try {
    message = await renderPaymentFailedEmail({
      email: payment.user.email || "",
      name: payment.user.name || "User",
      consultantName,
      appointmentType,
      amount: payment.amount,
      currency: payment.currency,
      retryUrl,
      failureReason: payment.description || "Payment could not be processed",
      expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000), // 48 hours from now
    });
  } catch (error) {
    reportSentryError(error, { subsystem: "payments", level: "warning" });
    console.error("Failed to render payment failure email:", error);
    return null;
  }

  const staged = await stageEmail(message, "PAYMENT_FAILED", {
    tx,
    entityRef: `payment:${payment.id}`,
  });
  return staged ? { staged, message } : null;
}
