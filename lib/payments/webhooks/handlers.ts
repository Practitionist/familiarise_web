/**
 * Payment Webhook Handlers
 * Core business logic for processing payment capture and failure events.
 */

import { convertCompletedTrial } from "@/lib/trials/conversion";
import { casMiss } from "@/lib/cron/run-counters";
import {
  reportSentryError,
  reportSentryMessage,
} from "@/lib/observability/report";
import {
  transitionParticipant,
  RELEASED_PARTICIPANT_STATUSES,
} from "@/lib/booking/participants";
import { markBackupInterestBooked } from "@/lib/booking/backup-interest";
import { markEventWaitlistBooked } from "@/lib/booking/event-waitlist";
import prisma, { type Tx } from "@/lib/prisma";
import { isPreMintIntent } from "@/lib/payments/pre-mint-intent";
import { orderNotesPaymentIdSchema } from "@/schemas/webhooks/razorpay";
import { collaboratorUserIds } from "@/lib/collaborators/recipients";
import {
  AppointmentsType,
  PaymentStatus,
  Prisma,
  AppointmentStatus,
  OccurrenceCompletionStatus,
  TrialStatus,
} from "@prisma/client";
import {
  buildCohostCommitmentFilter,
  buildDeadHoldFilter,
  buildOccupiedAppointmentFilter,
  OCCUPYING_OCCURRENCE_WHERE,
  seatHoldingParticipant,
  timeHoldingParticipant,
} from "@/utils/scheduling-engine/occupancyPolicy";
import { effectiveMaxParticipants } from "@/lib/events/capacity";
import {
  REQUEST_ALLOWED_FROM,
  transitionClassEvent,
  transitionConsultationRequest,
  transitionOccurrenceCompletion,
  transitionSubscriptionRequest,
  transitionTrial,
  transitionWebinarEvent,
} from "@/lib/booking/transitions";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import { isExclusionViolation, isWriteConflict } from "@/lib/db/pg-errors";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { liveOccurrenceWhere } from "@/lib/appointments/occurrences";
import {
  recordSystemError,
  recordSystemErrorSafe,
} from "@/lib/enterprise/system-events";
import { refundPayment } from "@/lib/payments/operations/refund";
import { refundBookingPayment } from "@/lib/payments/operations/booking-refund";
import {
  AUTO_REFUND_PENDING_PREFIX,
  DOUBLE_BOOKING_BLOCKED_NOTE,
  autoRefundPendingDescription,
  settledAutoRefundDescription,
  unreturnedCaptureWhere,
} from "@/lib/payments/webhooks/auto-refund-marker";
import { mintConsumerInvoiceBestEffort } from "@/lib/payments/billing/consumer-invoice";
import {
  postUnappliedReceipt,
  releaseUnappliedReceipt,
} from "@/lib/payments/ledger/unapplied-receipts";
import {
  normalizeLegacySlotKeys,
  validateWebhookMetadata,
} from "@/schemas/webhooks/metadata";
import { ZodError } from "zod";
import {
  attempt as attemptEmail,
  attemptStaged,
  EMAIL_BUDGET_MS,
  type RenderedEmail,
  type StagedRecipientEmail,
} from "@/lib/email";
import type { PreparedSpecEmails } from "@/lib/email/senders/shared";
import {
  createEarningsFromPayment,
  planEarningsForPayment,
  resolvePaymentForEarnings,
  type PreplannedEarningsContext,
} from "@/lib/payments/payouts";
import {
  attemptTrigger,
  notifyPaymentSuccess,
  notifyPaymentFailed,
  notifyAppointmentBooked,
  notifyTrialCancelled,
  type StagedTrigger,
} from "@/lib/novu";
import { stageTrialLifecycleEmail } from "@/lib/email/senders/booking";
import { notificationScope } from "@/lib/novu/workflows";
import { notificationHref } from "@/lib/novu/resolve-href";
import { goHref } from "@/lib/dashboard/go";
import { planTitleOrSessionLabel } from "@/lib/novu/humanize";
import { reverseCreditsForPayment } from "@/lib/referrals/service";
import { returnDiscountUse } from "@/lib/payments/checkout/discount-use";
import { reverseBookingUtilization } from "@/lib/api/organizations/program-helpers";
import { recordReferralCaptureInSavepoint } from "@/lib/referrals/capture";
import {
  prepareCreditsAppliedEmail,
  readCreditsApplied,
  stageCreditsApplied,
  type CreditsApplied,
} from "@/lib/referrals/referral-notify";
import {
  flushNotificationsAfter,
  type StagedNotificationBundle,
} from "@/lib/novu/stage-then-attempt";
import { isMockPaymentId } from "@/lib/payments/operations/mock";
import {
  isFreeCreditIntent,
  isInternalFundedIntent,
} from "@/lib/payments/funding-rail";
import { isPrismaConnectionOrPoolError } from "@/lib/cron/with-cron-lock";
import { ensureChannelsForAppointment } from "@/lib/payments/webhooks/ensure-channels";
import { streamLogger } from "@/lib/stream-logger";
import { getAppUrl } from "@/lib/url";
import {
  createAppointmentFromWebhook,
  RecoveryAlreadyDoneError,
  RecoveryRefusedError,
} from "./legacy-appointment-creation";
import {
  loadAppointmentForEmails,
  prepareBookedEmails,
  preparePaymentFailedEmail,
  preparePaymentSuccessEmail,
  resolveAppointmentNotificationContext,
  stageBookedEmails,
  stagePaymentFailedEmail,
  stagePaymentSuccessBells,
  stagePaymentSuccessEmail,
  type AppointmentForEmails,
  type StagedOutboxEmail,
} from "./staged-emails";
import {
  attemptStagedRequestExpired,
  notifyConsulteeRequestExpired,
  stageConsulteeRequestExpired,
  type RequestExpiredNotice,
  type StagedRequestExpiredNotice,
} from "@/lib/booking/expiry-notices";

export {
  createAppointmentFromWebhook,
  RecoveryAlreadyDoneError,
  RecoveryRefusedError,
};

type PaymentSuccessTxResult =
  | {
      outcome: "amount_mismatch";
      paymentId: string;
      gatewayAmountPaise: number;
      expectedAmount: number;
    }
  | {
      outcome: "captured_after_release";
      paymentId: string;
      releasedBy: string;
      /** Both parties' cancelled notice, staged with the release. */
      trialNotice?: StagedNotificationBundle | null;
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
      // The capture's webinar/class seat was released before the money landed.
      seatReleased: boolean;
      // The money landed after the first session had started; refunded in full.
      sessionStarted: boolean;
      // That consultee notice, staged in this transaction; null if staging failed.
      startedNotice: StagedRequestExpiredNotice | null;
      earningsCreatedInPhase1: boolean;
      appointmentForEmails: AppointmentForEmails | null;
      successEmail: StagedOutboxEmail | null;
      bookedEmails: StagedRecipientEmail[];
      stagedBells: StagedTrigger[];
      stageBellsRan: boolean;
      creditNotices: StagedNotificationBundle;
    };

const PHASE_2_DEADLINE_MS = 5_000;

/** Resolves to `undefined` when `work` exceeds the Phase 2 deadline so a slow external call cannot hold the DB pool. */
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

/** Reports a capture that arrived after a payment row already left `PENDING`. */
async function reportTerminalCaptureRace(params: {
  db: Tx | typeof prisma;
  paymentId: string;
  orderId: string;
  observedStatus: PaymentStatus;
  reason: string;
}): Promise<void> {
  const fresh = await params.db.payment.findUnique({
    where: { id: params.paymentId },
    select: { paymentStatus: true },
  });
  const currentStatus = fresh?.paymentStatus ?? params.observedStatus;
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

/** A pre-mint row a capture may adopt, named by the order Razorpay holds, never by client notes. */
type PreMintAdoption = {
  orderId: string;
  paymentId: string;
  amount: number;
  currency: string;
};

/**
 * Reads the order server-side before the confirmation tx; a gateway failure throws so the
 * capture is retried, and an order whose notes name no row yields null.
 */
async function verifiedPreMintAdoption(
  orderId: string,
): Promise<PreMintAdoption | null> {
  if (!orderId.startsWith("order_") || isMockPaymentId(orderId)) return null;
  const { fetchRazorpayOrder } = await import("@/lib/payments/core/razorpay");
  const order = await fetchRazorpayOrder(orderId);
  if (order?.id !== orderId) return null;
  const notes = orderNotesPaymentIdSchema.safeParse(order.notes);
  const paymentId = notes.success ? notes.data.familiarisePaymentId : undefined;
  if (!paymentId) return null;
  return { orderId, paymentId, amount: order.amount, currency: order.currency };
}

/** Adopts by CAS only a row still carrying its pre-mint marker, at the order's amount and currency. */
async function adoptPreMintRow(
  tx: Tx,
  adoption: PreMintAdoption,
): Promise<boolean> {
  const row = await tx.payment.findUnique({
    where: { id: adoption.paymentId },
    select: { paymentIntent: true, amount: true, currency: true },
  });
  if (
    !row ||
    !isPreMintIntent(row.paymentIntent) ||
    row.amount !== adoption.amount ||
    row.currency !== adoption.currency.toUpperCase()
  ) {
    return false;
  }
  const adopted = await tx.payment.updateMany({
    where: {
      id: adoption.paymentId,
      paymentIntent: row.paymentIntent,
      amount: adoption.amount,
    },
    data: { paymentIntent: adoption.orderId },
  });
  if (adopted.count !== 1) return false;
  await tx.paymentLeg.updateMany({
    where: {
      paymentId: adoption.paymentId,
      source: "CARD",
      sourceRef: row.paymentIntent,
    },
    data: { sourceRef: adoption.orderId },
  });
  return true;
}

export async function handlePaymentSuccess(
  paymentIntentId: string,
  rawMetadata: Record<string, string>,
  gatewayAmountPaise?: number,
  gatewayPaymentId?: string,
  options?: { recover?: boolean },
): Promise<PaymentSuccessTxResult["outcome"] | null> {
  const recovering = options?.recover === true;
  const metadata = { ...normalizeLegacySlotKeys(rawMetadata) };
  const capturedGatewayId = gatewayPaymentId ? { gatewayPaymentId } : {};

  let preMintAdoption: PreMintAdoption | null = null;
  if (!recovering && prisma.payment?.findUnique) {
    const existing = await prisma.payment.findUnique({
      where: { paymentIntent: paymentIntentId },
      select: {
        id: true,
        paymentStatus: true,
        amount: true,
        gatewayPaymentId: true,
      },
    });
    if (existing === null) {
      preMintAdoption = await verifiedPreMintAdoption(paymentIntentId);
    }
    if (
      existing?.paymentStatus === PaymentStatus.SUCCEEDED &&
      (gatewayAmountPaise === undefined ||
        gatewayAmountPaise === existing.amount) &&
      (!gatewayPaymentId ||
        !existing.gatewayPaymentId ||
        existing.gatewayPaymentId === gatewayPaymentId)
    ) {
      if (gatewayPaymentId && !existing.gatewayPaymentId) {
        await prisma.payment.updateMany({
          where: { id: existing.id, gatewayPaymentId: null },
          data: { gatewayPaymentId },
        });
      }
      return "confirmed";
    }
  }

  let preplannedEarnings: PreplannedEarningsContext | null = null;
  try {
    preplannedEarnings = await planEarningsForPayment(
      { paymentIntent: paymentIntentId },
      metadata.appointmentType,
    );
  } catch {
    preplannedEarnings = null;
  }

  let preRenderedSuccessEmail: RenderedEmail | null | undefined;
  let preRenderedBookedEmails: PreparedSpecEmails | null = null;
  // Checkout already noticed mock, free_ and org_ credits; a recovery's first confirmation did too.
  const noticeCredits =
    !recovering &&
    !isMockPaymentId(paymentIntentId) &&
    !isFreeCreditIntent(paymentIntentId) &&
    !isInternalFundedIntent(paymentIntentId);
  // Read before the transaction; the transaction reads it again only for another payment row.
  let preCredits:
    { paymentId: string; applied: CreditsApplied | null } | undefined;
  let preCreditsEmail: PreparedSpecEmails | null = null;
  try {
    const prePayment = await prisma.payment.findUnique({
      where: { paymentIntent: paymentIntentId },
      include: { user: { include: { consulteeProfile: true } } },
    });
    if (
      noticeCredits &&
      prePayment &&
      prePayment.paymentStatus !== PaymentStatus.SUCCEEDED
    ) {
      try {
        const applied = await readCreditsApplied(prisma, {
          userId: prePayment.userId,
          paymentId: prePayment.id,
          appointmentType: metadata.appointmentType,
        });
        preCreditsEmail = applied
          ? await prepareCreditsAppliedEmail(applied)
          : null;
        preCredits = { paymentId: prePayment.id, applied };
      } catch {
        preCredits = undefined;
        preCreditsEmail = null;
      }
    }
    if (
      prePayment?.appointmentId &&
      prePayment.paymentStatus !== PaymentStatus.SUCCEEDED
    ) {
      const preApptType =
        metadata.appointmentType ||
        (
          await prisma.appointment.findUnique({
            where: { id: prePayment.appointmentId },
            select: { appointmentType: true },
          })
        )?.appointmentType;
      if (preApptType) {
        const preApptForEmails = await loadAppointmentForEmails(
          prisma,
          prePayment.appointmentId,
        );
        if (preApptForEmails) {
          preRenderedSuccessEmail = await preparePaymentSuccessEmail(
            prePayment,
            preApptForEmails,
            preApptType,
          );
          preRenderedBookedEmails = await prepareBookedEmails(
            prePayment,
            preApptForEmails,
            preApptType,
          );
        }
      }
    }
  } catch {
    preRenderedSuccessEmail = undefined;
    preRenderedBookedEmails = null;
  }

  // Phase 1: Serializable transaction for payment confirmation and appointment state transitions.
  let txResult: PaymentSuccessTxResult | null;
  try {
    txResult = await withSerializableRetry(() =>
      prisma.$transaction(
        async (tx): Promise<PaymentSuccessTxResult | null> => {
          const readPayment = () =>
            tx.payment.findUnique({
              where: { paymentIntent: paymentIntentId },
              include: { user: { include: { consulteeProfile: true } } },
            });
          const payment =
            (await readPayment()) ??
            (preMintAdoption && (await adoptPreMintRow(tx, preMintAdoption))
              ? await readPayment()
              : null);

          if (!payment) {
            const err = new Error(
              `Payment record not found for intent: ${paymentIntentId}`,
            );
            reportSentryError(err, { subsystem: "payments" });
            throw err;
          }

          // Settle only on gateway truth; without a captured amount stay PENDING.
          if (!recovering && gatewayAmountPaise === undefined) {
            reportSentryMessage(
              "capture without gateway amount - staying PENDING",
              {
                subsystem: "payments",
                expected: true,
                extra: { paymentIntentId },
              },
            );
            return null;
          }
          const parkCapture = () =>
            postUnappliedReceipt(tx, {
              paymentId: payment.id,
              capturedPaise: gatewayAmountPaise ?? payment.amount,
            });

          const recoverable =
            recovering &&
            payment.paymentStatus === PaymentStatus.SUCCEEDED &&
            payment.appointmentId === null;
          // Read in this Serializable transaction so a concurrent refund or dispute aborts the booking.
          if (
            recoverable &&
            (await tx.payment.count({
              where: { id: payment.id, ...unreturnedCaptureWhere },
            })) === 0
          ) {
            throw new RecoveryRefusedError(payment.id);
          }
          // The SUCCEEDED short-circuit's own predicate; `recoverable` excluded so
          // a wrong-amount capture on an unconfirmed recovery still blocks.
          const alreadyProcessed =
            payment.paymentStatus === PaymentStatus.SUCCEEDED && !recoverable;

          // Late capture on an EXPIRED or FAILED payment: record SUCCEEDED gateway truth and refund in Phase 2.
          if (
            payment.paymentStatus === PaymentStatus.EXPIRED ||
            payment.paymentStatus === PaymentStatus.FAILED
          ) {
            const claimed = await tx.payment.updateMany({
              where: { id: payment.id, paymentStatus: payment.paymentStatus },
              data: {
                paymentStatus: PaymentStatus.SUCCEEDED,
                ...capturedGatewayId,
                capturedAt: new Date(),
                description: `Auto-refund pending: capture landed on a ${payment.paymentStatus} payment whose hold was already released. Booking NOT confirmed.`,
              },
            });
            if (claimed.count === 0) {
              casMiss();
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
            await parkCapture();
            return {
              outcome: "captured_after_release",
              paymentId: payment.id,
              releasedBy: `payment ${payment.paymentStatus}`,
            };
          }

          // Amount parity guard: never confirm a booking when captured amount differs from ordered amount.
          // Runs above the SUCCEEDED short-circuit so a redelivered mismatch is
          // still caught; remediation stays behind `!alreadyProcessed` so it never refunds twice.
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
                    redelivery: alreadyProcessed,
                  },
                },
              },
            );
            if (alreadyProcessed) {
              // The first delivery already stamped and auto-refunded; acknowledge
              // the webhook without re-opening the terminal row.
              console.error(
                JSON.stringify({
                  event: "CRITICAL_PAYMENT_AMOUNT_MISMATCH_REDELIVERY",
                  alert_priority: "P1",
                  payment_id: payment.id,
                  payment_intent: paymentIntentId,
                  user_id: payment.userId,
                  gateway_amount_paise: gatewayAmountPaise,
                  expected_amount_paise: payment.amount,
                  action_required:
                    "already auto-refunded by the first delivery; re-verify no second refund is owed",
                  timestamp: new Date().toISOString(),
                }),
              );
              reportSentryMessage(
                "capture amount mismatch on an already-processed payment",
                {
                  subsystem: "payments",
                  expected: true,
                  extra: { paymentIntentId, gatewayAmountPaise },
                },
              );
              return null; // Signal: nothing to do, skip Phase 2
            }
            const stamped = await tx.payment.updateMany({
              where: { id: payment.id, paymentStatus: PaymentStatus.PENDING },
              data: {
                paymentStatus: PaymentStatus.SUCCEEDED,
                ...capturedGatewayId,
                description: autoRefundPendingDescription(
                  gatewayAmountPaise > payment.amount
                    ? `Over-capture surplus of ${gatewayAmountPaise - payment.amount}p on ${paymentIntentId} (capture amount ${gatewayAmountPaise}p ≠ expected ${payment.amount}p)`
                    : `capture amount ${gatewayAmountPaise}p ≠ expected ${payment.amount}p`,
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
            } else {
              await parkCapture();
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
            return {
              outcome: "amount_mismatch",
              paymentId: payment.id,
              gatewayAmountPaise,
              expectedAmount: payment.amount,
            };
          }

          // Redelivered webhook whose amount agrees with what was booked (parity ran above).
          if (alreadyProcessed) {
            console.log(
              `Payment ${paymentIntentId} has already been processed.`,
            );
            reportSentryMessage("Payment webhook idempotency short-circuit", {
              subsystem: "payments",
              expected: true,
              extra: { paymentIntentId },
            });
            return null; // Signal: already processed, skip Phase 2
          }

          if (payment.appointmentId) {
            if (!metadata.userId && payment.userId) {
              metadata.userId = payment.userId;
            }
            if (!metadata.appointmentType) {
              const existingAppt = await tx.appointment.findUnique({
                where: { id: payment.appointmentId },
                select: { appointmentType: true },
              });
              if (existingAppt?.appointmentType) {
                metadata.appointmentType = existingAppt.appointmentType;
              }
            }
          }

          try {
            validateWebhookMetadata(metadata);
          } catch (validationError) {
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

            const recoveryStamped = await tx.payment.updateMany({
              where: { id: payment.id, paymentStatus: PaymentStatus.PENDING },
              data: {
                paymentStatus: PaymentStatus.SUCCEEDED,
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
            } else {
              await parkCapture();
            }

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
                dashboard_url: `${getAppUrl()}/dashboard/admin/payments/${payment.id}`,
                timestamp: new Date().toISOString(),
              }),
            );

            return null;
          }

          const confirmed = recoverable
            ? { count: 1 }
            : await tx.payment.updateMany({
                where: { id: payment.id, paymentStatus: PaymentStatus.PENDING },
                data: {
                  paymentStatus: PaymentStatus.SUCCEEDED,
                  ...capturedGatewayId,
                  capturedAt: new Date(),
                },
              });
          if (confirmed.count === 0) {
            casMiss();
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

          let appointment;
          if (payment.appointmentId) {
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
            appointment = await createAppointmentFromWebhook(
              tx,
              metadata,
              payment,
            );

            // A full event refuses the seat (null) rather than oversell. That
            // is a release Phase 2 refunds, not a throw: a throw would roll the
            // SUCCEEDED stamp back and the gateway would re-drive forever.
            if (!appointment) {
              // The pending-refund marker rides this transaction, so a Phase 2
              // refund that dies at the gateway is still re-driven.
              await tx.payment.update({
                where: { id: payment.id },
                data: {
                  description: autoRefundPendingDescription(
                    `capture could not be seated — ${metadata.appointmentType.toLowerCase()} ${metadata.eventId} is full`,
                  ),
                },
              });
              await parkCapture();
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

          if (metadata.trialId) {
            // Nobody pays for a trial whose held session already started: the
            // hold is released, the trial cancelled, and the capture refunded.
            const startedHold = await tx.appointmentOccurrence.findFirst({
              where: {
                appointmentId: appointment.id,
                isTentative: true,
                deletedAt: null,
                startsAt: { lte: new Date() },
              },
              select: { id: true },
            });
            if (startedHold) {
              let cancelledHere = false;
              try {
                await transitionTrial(tx, {
                  reason: "PAID_AFTER_SESSION_STARTED",
                  appointmentId: appointment.id,
                  where: { id: metadata.trialId },
                  to: TrialStatus.CANCELLED,
                  fromIn: [TrialStatus.AWAITING_PAYMENT],
                  data: { pendingPaymentUrl: null, paymentDueAt: null },
                });
                cancelledHere = true;
              } catch (err) {
                if (!(err instanceof IllegalTransitionError)) throw err;
              }
              await transitionOccurrenceCompletion(tx, {
                actorUserId: null,
                reason: "PAID_AFTER_SESSION_STARTED",
                where: {
                  appointmentId: appointment.id,
                  isTentative: true,
                  deletedAt: null,
                },
                to: OccurrenceCompletionStatus.CANCELLED,
                data: { deletedAt: new Date() },
                allowZero: true,
              });
              await tx.payment.update({
                where: { id: payment.id },
                data: {
                  description: autoRefundPendingDescription(
                    `trial ${metadata.trialId} was paid after its session started`,
                  ),
                },
              });
              await parkCapture();
              return {
                outcome: "captured_after_release",
                paymentId: payment.id,
                releasedBy: `trial session started before payment (${metadata.trialId})`,
                // Only the door that cancelled the trial announces it.
                trialNotice: cancelledHere
                  ? await stageTrialPaidAfterStartNotice(tx, metadata.trialId)
                  : null,
              };
            }

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

            if (scheduled.count === 0) {
              const trial = await tx.trial.findUnique({
                where: { id: metadata.trialId },
                select: { status: true, paymentId: true },
              });
              const alreadyOurs =
                trial?.paymentId === payment.id
                  ? trial.status === TrialStatus.SCHEDULED
                  : trial?.status === TrialStatus.SCHEDULED &&
                    trial.paymentId === null;
              if (!alreadyOurs) {
                await tx.payment.update({
                  where: { id: payment.id },
                  data: {
                    description: `Auto-refund pending: capture landed on a ${trial?.status ?? "missing"} trial. Booking NOT confirmed.`,
                  },
                });
                await parkCapture();
                return {
                  outcome: "captured_after_release",
                  paymentId: payment.id,
                  releasedBy: `trial ${trial?.status ?? "missing"}`,
                };
              }
            }
          }

          const confirmNow = new Date();
          const holdExpired =
            payment.paymentStatus === PaymentStatus.PENDING &&
            payment.expiresAt !== null &&
            payment.expiresAt < confirmNow;

          const confirmResult = await confirmExistingAppointment(
            tx,
            appointment.id,
            payment.userId,
            { holdExpired, now: confirmNow },
          );

          console.log(
            `✅ Payment ${paymentIntentId} processed successfully. Appointment ID: ${appointment.id}`,
          );

          const blocked =
            confirmResult.capturedAfterTerminal ||
            confirmResult.doubleBookingBlocked;
          let earningsCreatedInPhase1 = false;
          let startedNotice: StagedRequestExpiredNotice | null = null;
          if (blocked) {
            await tx.payment.update({
              where: { id: payment.id },
              data: {
                description: autoRefundPendingDescription(
                  confirmResult.doubleBookingBlocked
                    ? DOUBLE_BOOKING_BLOCKED_NOTE
                    : confirmResult.seatReleased
                      ? "capture landed after the seat was released"
                      : confirmResult.sessionStarted
                        ? "capture landed after the session started"
                        : "capture landed after the booking was cancelled",
                ),
              },
            });
            await parkCapture();
            // The loser's hold dies with the capture commit, so no sweep can confirm it while the refund is pending.
            if (confirmResult.doubleBookingBlocked) {
              await cleanupFailedPaymentAppointment(tx, appointment.id);
            }
            if (confirmResult.sessionStarted) {
              startedNotice = await stageStartedBeforePaymentNotice(
                tx,
                appointment.id,
              );
            }
          } else {
            // Outside the savepoint: the booking confirms even when earnings
            // defer, and the deferred retry must not see the cash as parked.
            if (recoverable) {
              await releaseUnappliedReceipt(tx, payment.id);
            }
            await tx.$executeRaw`SAVEPOINT sp_phase1_earnings`;
            try {
              const resolvedInTx =
                preplannedEarnings?.resolvedPayment ??
                (await resolvePaymentForEarnings(
                  { id: payment.id },
                  metadata.appointmentType,
                  tx,
                ));
              if (resolvedInTx) {
                await createEarningsFromPayment({
                  payment: resolvedInTx.paymentForEarnings,
                  appointmentType: resolvedInTx.earningsAppointmentType,
                  tx,
                  preplanned: preplannedEarnings ?? undefined,
                });
                earningsCreatedInPhase1 = true;
                console.log(
                  `💰 Earnings record created atomically in Phase 1 for payment ${payment.id}, consultant ${resolvedInTx.consultantProfileId}`,
                );
              }
              await tx.$executeRaw`RELEASE SAVEPOINT sp_phase1_earnings`;
            } catch (phase1EarningsErr) {
              await tx.$executeRaw`ROLLBACK TO SAVEPOINT sp_phase1_earnings`.catch(
                () => undefined,
              );
              const isRetryableSerialization =
                phase1EarningsErr instanceof
                  Prisma.PrismaClientKnownRequestError &&
                phase1EarningsErr.code === "P2034";
              if (isRetryableSerialization) {
                throw phase1EarningsErr;
              }
              console.warn(
                `⚠️ Phase 1 earnings creation failed for payment ${payment.id}; deferring to Phase 2:`,
                phase1EarningsErr,
              );
              earningsCreatedInPhase1 = false;
            }
            await recordReferralCaptureInSavepoint(tx, {
              paymentId: payment.id,
              consultantProfileId: async () =>
                preplannedEarnings?.resolvedPayment.consultantProfileId ??
                (
                  await resolvePaymentForEarnings(
                    { id: payment.id },
                    metadata.appointmentType,
                    tx,
                  )
                )?.consultantProfileId,
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
                preRenderedSuccessEmail,
              )
            : null;
          const bookedEmails = appointmentForEmails
            ? await stageBookedEmails(
                tx,
                payment,
                appointmentForEmails,
                metadata.appointmentType,
                preRenderedBookedEmails,
              )
            : [];
          const stageBellsRan = Boolean(
            appointmentForEmails && tx.notificationOutbox,
          );
          const stagedBells =
            stageBellsRan && appointmentForEmails
              ? await stagePaymentSuccessBells(
                  tx,
                  payment,
                  appointmentForEmails,
                  metadata.appointmentType,
                )
              : [];
          let credits: CreditsApplied | null = null;
          if (noticeCredits && !blocked) {
            credits =
              preCredits?.paymentId === payment.id
                ? preCredits.applied
                : await readCreditsApplied(tx, {
                    userId: payment.userId,
                    paymentId: payment.id,
                    appointmentType: metadata.appointmentType,
                  });
          }
          const creditNotices = credits
            ? await stageCreditsApplied(tx, credits, preCreditsEmail)
            : {};

          return {
            outcome: "confirmed",
            paymentId: payment.id,
            appointmentId: appointment.id,
            appointmentType: metadata.appointmentType,
            userId: payment.userId,
            userName: payment.user.name,
            amount: payment.amount,
            currency: payment.currency,
            capturedAfterTerminal: confirmResult.capturedAfterTerminal,
            doubleBookingBlocked: confirmResult.doubleBookingBlocked ?? false,
            seatReleased: confirmResult.seatReleased ?? false,
            sessionStarted: confirmResult.sessionStarted ?? false,
            startedNotice,
            earningsCreatedInPhase1,
            appointmentForEmails,
            successEmail,
            bookedEmails,
            stagedBells,
            stageBellsRan,
            creditNotices,
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
    // Legacy capture overlapping a confirmed booking trips the GiST exclusion constraint; convert to SUCCEEDED + auto-refund.
    if (!isExclusionViolation(err)) throw err;
    const loser = await prisma.payment.findUnique({
      where: { paymentIntent: paymentIntentId },
      select: { id: true, paymentStatus: true, amount: true },
    });
    if (!loser) throw err;
    const restamped = await prisma.$transaction(async (tx) => {
      const stamped = await tx.payment.updateMany({
        where: { id: loser.id, paymentStatus: PaymentStatus.PENDING },
        data: {
          paymentStatus: PaymentStatus.SUCCEEDED,
          ...capturedGatewayId,
          capturedAt: new Date(),
          description: autoRefundPendingDescription(
            "legacy-shape capture overlapped a confirmed booking (occurrence_no_confirmed_overlap)",
          ),
        },
      });
      if (stamped.count === 1) {
        await postUnappliedReceipt(tx, {
          paymentId: loser.id,
          capturedPaise: gatewayAmountPaise ?? loser.amount,
        });
      }
      return stamped;
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
      const outcome = await refundPayment({
        paymentId: loser.id,
        reason: "legacy capture overlapped a confirmed booking",
        initiatedByUserId: null,
      });
      if (outcome?.status !== "PENDING") {
        await prisma.payment.update({
          where: { id: loser.id },
          data: {
            description:
              "Auto-refunded: legacy-shape capture overlapped a confirmed booking — booking NOT confirmed.",
          },
        });
      }
    } catch (refundError) {
      reportSentryError(refundError, { subsystem: "payments" });
      console.error(
        "Failed to auto-refund GiST-overlap legacy capture; retry-auto-refunds re-drives its marker:",
        refundError,
      );
    }
    return null;
  }

  if (!txResult) return null;

  if (txResult.outcome === "amount_mismatch") {
    const refundablePaise = Math.min(
      txResult.gatewayAmountPaise,
      txResult.expectedAmount,
    );
    const surplusPaise = txResult.gatewayAmountPaise - refundablePaise;
    if (surplusPaise > 0) {
      // Log surplus audit event before attempting gateway refund so transient errors never drop it.
      void recordSystemErrorSafe({
        organizationId: null,
        category: "PAYMENT",
        summary: `Over-capture surplus of ${surplusPaise}p on payment ${txResult.paymentId} requires operator refund`,
        err: new Error("OVERCAPTURE_SURPLUS_RECOVERY"),
        context: {
          paymentId: txResult.paymentId,
          gatewayAmountPaise: txResult.gatewayAmountPaise,
          expectedAmount: txResult.expectedAmount,
          surplusPaise,
        },
      });
    }
    try {
      const outcome = await refundPayment({
        paymentId: txResult.paymentId,
        amountPaise: refundablePaise,
        reason: "capture amount mismatch",
        initiatedByUserId: null,
      });
      if (outcome?.status !== "PENDING") {
        await prisma.payment.update({
          where: { id: txResult.paymentId },
          data: {
            description:
              surplusPaise > 0
                ? `REQUIRES_MANUAL_RECOVERY: Over-capture surplus of ${surplusPaise}p on ${paymentIntentId} (refunded ${refundablePaise}p of ${txResult.gatewayAmountPaise}p captured). Booking NOT confirmed.`
                : `Auto-refunded: capture amount ${txResult.gatewayAmountPaise}p ≠ expected ${txResult.expectedAmount}p. Booking NOT confirmed.`,
          },
        });
      }
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

  if (txResult.outcome === "captured_after_release") {
    try {
      const outcome = await refundBookingPayment({
        paymentId: txResult.paymentId,
        amountPaise: gatewayAmountPaise,
        reason: `capture after hold release (${txResult.releasedBy})`,
        initiatedByUserId: null,
      });
      if (outcome?.status !== "PENDING") {
        await prisma.payment.update({
          where: { id: txResult.paymentId },
          data: {
            description: `Auto-refunded: capture landed after the hold was released (${txResult.releasedBy}). Booking NOT confirmed.`,
          },
        });
      }
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
    if (txResult.trialNotice) {
      await flushNotificationsAfter(
        txResult.trialNotice,
        "capture.trial-paid-after-start",
      );
    }
    return txResult.outcome;
  }

  if (txResult.capturedAfterTerminal) {
    // Before the refund and independent of it: the notice committed with the
    // capture, so a refund failure (re-driven later) never leaves it unsent.
    if (txResult.sessionStarted) {
      await (txResult.startedNotice
        ? attemptStagedRequestExpired(
            txResult.startedNotice,
            EMAIL_BUDGET_MS.WEBHOOK,
          )
        : notifyStartedBeforePayment(txResult.appointmentId));
    }
    try {
      const outcome = txResult.seatReleased
        ? await refundBookingPayment({
            paymentId: txResult.paymentId,
            reason: "capture after seat release",
            initiatedByUserId: null,
            dedupeKey: `capture-unseated:${txResult.paymentId}`,
          })
        : await refundPayment({
            paymentId: txResult.paymentId,
            reason: txResult.sessionStarted
              ? "capture after the session started"
              : "capture after cancellation",
            initiatedByUserId: null,
          });
      if (outcome?.status !== "PENDING") {
        await settleAutoRefundMarker(txResult.paymentId);
      }
    } catch (refundError) {
      reportSentryError(refundError, { subsystem: "payments" });
      console.error(
        "Failed to auto-refund capture-after-cancellation (Phase 2):",
        refundError,
      );
    }
    return txResult.outcome;
  }

  if (txResult.doubleBookingBlocked) {
    try {
      const outcome = await refundPayment({
        paymentId: txResult.paymentId,
        reason: DOUBLE_BOOKING_BLOCKED_NOTE,
        initiatedByUserId: null,
      });
      if (outcome?.status !== "PENDING") {
        await settleAutoRefundMarker(txResult.paymentId);
      }
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
        "Failed to auto-refund double-booking loser; retry-auto-refunds re-drives its marker (Phase 2):",
        refundError,
      );
    }
    return txResult.outcome;
  }

  // Phase 2: Post-commit concurrent flush of staged emails & Novu bells, earnings fallback, invoice, and Stream channels.
  await Promise.allSettled([
    ...(txResult.successEmail
      ? [
          attemptEmail(
            txResult.successEmail.staged,
            txResult.successEmail.message,
            "PAYMENT_SUCCESS",
            { budgetMs: EMAIL_BUDGET_MS.WEBHOOK },
          ),
        ]
      : []),
    ...(txResult.bookedEmails.length > 0
      ? [
          attemptStaged(
            txResult.bookedEmails,
            "APPOINTMENT_BOOKED",
            EMAIL_BUDGET_MS.WEBHOOK,
          ),
        ]
      : []),
    ...txResult.stagedBells.map((bell) => attemptTrigger(bell)),
  ]);

  const { paymentId, appointmentId, userId, userName, amount, currency } =
    txResult;

  if (!txResult.earningsCreatedInPhase1) {
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
      reportSentryError(earningsError, {
        subsystem: "payments",
        extra: { paymentId, appointmentId, userId, path: "webhook" },
      });
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
  }

  await mintConsumerInvoiceBestEffort({ paymentId });

  await flushNotificationsAfter(
    txResult.creditNotices,
    "referral.credits_applied",
  );

  if (!txResult.stageBellsRan) {
    try {
      const appointmentForNotif = await resolveAppointmentNotificationContext(
        appointmentId,
        txResult.appointmentForEmails,
      );

      const consultantProfileData =
        appointmentForNotif?.consultation?.consultationPlan
          ?.consultantProfile ||
        appointmentForNotif?.subscription?.subscriptionPlan
          ?.consultantProfile ||
        appointmentForNotif?.webinar?.webinarPlan?.consultantProfile ||
        appointmentForNotif?.class?.classPlan?.consultantProfile ||
        appointmentForNotif?.trial?.subscriptionPlan?.consultantProfile;

      const consultantNameForNotif =
        consultantProfileData?.user?.name || "Consultant";
      const consultantUserId = consultantProfileData?.user?.id;

      const resolvedPlanTitle =
        metadata.appointmentType === AppointmentsType.TRIAL
          ? "Trial session"
          : planTitleOrSessionLabel(
              appointmentForNotif?.consultation?.consultationPlan?.title ??
                appointmentForNotif?.subscription?.subscriptionPlan?.title ??
                appointmentForNotif?.webinar?.webinarPlan?.title ??
                appointmentForNotif?.class?.classPlan?.title ??
                appointmentForNotif?.trial?.subscriptionPlan?.title ??
                null,
              metadata.appointmentType,
            );

      const orgId = appointmentForNotif?.organizationId ?? null;
      const scope = notificationScope(
        orgId,
        appointmentForNotif?.organization?.name,
      );
      const dashboardUrl = notificationHref(orgId, "appointments");

      const notifications: Promise<unknown>[] = [];

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

      const notifUserIds = [userId];
      if (consultantUserId && consultantUserId !== userId) {
        notifUserIds.push(consultantUserId);
      }
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

      const firstSlot = await prisma.appointmentOccurrence.findFirst({
        where: { appointmentId },
        orderBy: { startsAt: "asc" },
        select: { startsAt: true },
      });
      if (!firstSlot?.startsAt) {
        console.log(
          JSON.stringify({
            event: "appointment_booked_notification_skipped_no_slots",
            appointmentId,
            paymentId,
            timestamp: new Date().toISOString(),
          }),
        );
      } else {
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
  }

  void (async () => {
    try {
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
      // A pool/connection timeout leaves the stamp NULL; the orphan sweep heals it.
      if (isPrismaConnectionOrPoolError(channelError)) {
        streamLogger.warn(
          "Stream channel step hit a database timeout — left for the reconcile sweep",
          { appointmentId, userId },
        );
        return;
      }
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

export async function handlePaymentFailure(
  paymentIntentId: string,
  failureReason?: string,
  gatewayPaymentId?: string,
) {
  let preRenderedFailedEmail: RenderedEmail | null | undefined;
  try {
    const prePayment = await prisma.payment.findUnique({
      where: { paymentIntent: paymentIntentId },
      select: {
        id: true,
        paymentStatus: true,
        appointmentId: true,
        amount: true,
        currency: true,
        description: true,
        expiresAt: true,
        user: { select: { email: true, name: true } },
      },
    });
    if (
      prePayment &&
      prePayment.paymentStatus === PaymentStatus.PENDING &&
      (!prePayment.expiresAt || prePayment.expiresAt <= new Date()) &&
      prePayment.appointmentId
    ) {
      preRenderedFailedEmail = await preparePaymentFailedEmail(
        prePayment,
        prisma,
      );
    }
  } catch {
    preRenderedFailedEmail = undefined;
  }

  const staged = await prisma.$transaction(async (tx) => {
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
        gatewayPaymentId: true,
        userId: true,
        appointmentId: true,
        amount: true,
        currency: true,
        description: true,
        expiresAt: true,
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

    // Keep tentative slot hold and consumed credits intact while the order hold window is still active.
    if (payment.expiresAt && payment.expiresAt > new Date()) {
      console.warn(
        `[webhook] Payment attempt failed during active hold window for ${paymentIntentId}`,
        { gatewayPaymentId, failureReason },
      );
      if (gatewayPaymentId && !payment.gatewayPaymentId) {
        await tx.payment.updateMany({
          where: {
            id: payment.id,
            paymentStatus: PaymentStatus.PENDING,
            gatewayPaymentId: null,
          },
          data: { gatewayPaymentId },
        });
      }
      return;
    }

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

    // Credits, the discount use and the org engagement consumed at checkout go back under the same CAS.
    await reverseCreditsForPayment(payment.id, tx);
    await returnDiscountUse(tx, payment.id);
    await reverseBookingUtilization(tx, {
      paymentId: payment.id,
      reason: "Payment failed",
    });

    if (payment.appointment) {
      await cleanupFailedPaymentAppointment(tx, payment.appointment.id);
    }

    const failedEmail = await stagePaymentFailedEmail(
      tx,
      payment,
      preRenderedFailedEmail,
    );

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
        failureReason: failureReason ?? "",
        retryUrl: `${getAppUrl()}${goHref("client", "payments")}`,
      },
      { tx, entityRef: `payment:${payment.id}` },
    );

    console.log(
      `📧 Payment failure notification staged for payment ${paymentIntentId}`,
    );
    return { failedEmail, bell: bell?.staged ?? null };
  });

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

/** CAS liveness re-stamp on a class or webinar so a capture after event cancellation is detected. */
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
  | { kind: "released" }
  | { kind: "missing" };

/**
 * Confirm the buyer's seat, or say why there was nothing to confirm. A zero
 * CAS count re-reads the row in-tx to tell a redelivery from a released seat.
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
    /** Set when the seat's hold lapsed before this capture: it confirms only if a place is still free. */
    lapsedAt?: Date;
  },
): Promise<SeatCaptureOutcome> {
  // A lapsed seat stopped counting for capacity, so another buyer may hold
  // the last place now; without room it is released and the capture refunded.
  if (
    args.lapsedAt &&
    !(await seatStillFits(
      tx,
      args.kind,
      args.eventId,
      args.userId,
      args.lapsedAt,
    ))
  ) {
    await transitionParticipant(tx, args.casWhere, "CANCELLED");
  }
  if ((await transitionParticipant(tx, args.casWhere, "CONFIRMED")) > 0) {
    await markEventWaitlistBooked(
      tx,
      args.appointmentId,
      args.userId,
      new Date(),
    );
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
  return { kind: "released" };
}

/** Whether the event still has a place for this buyer, counting only seats that hold one now. */
async function seatStillFits(
  tx: Tx,
  kind: "class" | "webinar",
  eventId: string,
  userId: string,
  now: Date,
): Promise<boolean> {
  const event =
    kind === "webinar"
      ? await tx.webinar.findUnique({
          where: { id: eventId },
          select: {
            maxParticipants: true,
            webinarPlan: { select: { maxParticipants: true } },
          },
        })
      : await tx.class.findUnique({
          where: { id: eventId },
          select: {
            maxParticipants: true,
            classPlan: { select: { maxParticipants: true } },
          },
        });
  if (!event) return false;
  const plan = "webinarPlan" in event ? event.webinarPlan : event.classPlan;
  const others = await tx.appointmentParticipant.count({
    where: {
      appointment:
        kind === "webinar" ? { webinarId: eventId } : { classId: eventId },
      ...seatHoldingParticipant(now),
      userId: { not: userId },
    },
  });
  return others < effectiveMaxParticipants(event, plan);
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
  // Through the tx (PG_POOL_MAX=1); the probe above rides the same snapshot.
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
  let capturedAfterTerminal = false;
  if (entityType === "consultation") {
    const consultation = await tx.consultation.findUnique({
      where: { id: entityId },
    });

    if (!consultation) {
      throw new Error(`Consultation ${entityId} not found`);
    }

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
        capturedAfterTerminal = true;
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
    const subscription = await tx.subscription.findUnique({
      where: { id: entityId },
      select: { status: true },
    });

    if (!subscription) {
      throw new Error(`Subscription ${entityId} not found`);
    }

    const flagTerminal = async (status: AppointmentStatus) => {
      capturedAfterTerminal = true;
      await recordSystemErrorSafe({
        organizationId: null,
        category: "PAYMENT",
        summary: `Payment captured for subscription ${entityId} in terminal state ${status} — refund needed`,
        err: new Error("CAPTURE_AFTER_TERMINAL_STATE"),
        context: { entityType: "subscription", entityId },
        db: tx,
      });
    };

    // A plan is paid at checkout: the capture moves no status, and allocation approves it.
    if (!LIVE_REQUEST_STATUSES.has(subscription.status)) {
      await flagTerminal(subscription.status);
    } else {
      console.log(
        `ℹ️ Subscription ${entityId} payment received - keeping status as ${subscription.status} (consultant will allocate slots)`,
      );
    }
    // A trial converts only once the plan is paid for.
    if (!capturedAfterTerminal) await convertCompletedTrial(tx, entityId);
  }
  return { capturedAfterTerminal };
}

export async function confirmExistingAppointment(
  tx: Tx,
  appointmentId: string,
  userId?: string,
  opts?: { holdExpired?: boolean; now?: Date },
): Promise<{
  capturedAfterTerminal: boolean;
  doubleBookingBlocked?: boolean;
  /** A webinar/class seat was released before the capture landed. */
  seatReleased?: boolean;
  /** The first session had started before the money landed: closed, refunded. */
  sessionStarted?: boolean;
}> {
  const appointment = await tx.appointment.findUnique({
    where: { id: appointmentId },
    include: {
      consultation: {
        include: {
          consultationPlan: { select: { consultantProfileId: true } },
        },
      },
      subscription: {
        include: {
          subscriptionPlan: { select: { consultantProfileId: true } },
        },
      },
      webinar: {
        include: {
          webinarPlan: { select: { consultantProfileId: true } },
        },
      },
      class: {
        include: {
          classPlan: { select: { consultantProfileId: true } },
        },
      },
    },
  });

  if (!appointment) {
    console.warn(`Appointment ${appointmentId} not found for confirmation`);
    return { capturedAfterTerminal: false };
  }

  // First-confirmed-wins overlap check for exclusive 1:1 booking types.
  if (appointment.consultation || appointment.subscription) {
    const mySlots = await tx.appointmentOccurrence.findMany({
      where: { appointmentId, isTentative: true, ...liveOccurrenceWhere },
      select: { id: true, startsAt: true, endsAt: true },
    });
    // One clock for every seat-liveness read of this confirmation.
    const now = opts?.now ?? new Date();
    // The payer is included: their own other live booking at this time is a double-book, refunded below.
    const participantIds = (
      await tx.appointmentParticipant.findMany({
        where: { appointmentId, ...timeHoldingParticipant(now) },
        select: { userId: true },
      })
    ).map((p) => p.userId);
    const consultantProfileId =
      appointment.consultation?.consultationPlan?.consultantProfileId ??
      appointment.subscription?.subscriptionPlan?.consultantProfileId ??
      appointment.webinar?.webinarPlan?.consultantProfileId ??
      appointment.class?.classPlan?.consultantProfileId;
    // Co-host seats of the host, and of the payer when the payer is an expert too.
    const payerProfile = userId
      ? await tx.consultantProfile.findUnique({
          where: { userId },
          select: { id: true },
        })
      : null;
    const cohostCommitments = [
      ...(consultantProfileId
        ? buildCohostCommitmentFilter(consultantProfileId)
        : []),
      ...(payerProfile ? buildCohostCommitmentFilter(payerProfile.id) : []),
    ];
    const holdExpired = opts?.holdExpired === true;
    // Nobody pays for a session that has already started: the request
    // closes (EXPIRED, holds released) in this commit and the capture takes
    // the late-capture path (parked, refunded in full), never a confirmation.
    if (mySlots.some((slot) => slot.startsAt <= now)) {
      await closeStartedBeforePayment(tx, appointment);
      await recordSystemErrorSafe({
        organizationId: null,
        category: "PAYMENT",
        summary: `Payment captured after the first session of appointment ${appointmentId} started — refund needed`,
        err: new Error("CAPTURE_AFTER_SESSION_START"),
        context: { appointmentId },
        db: tx,
      });
      return { capturedAfterTerminal: true, sessionStarted: true };
    }
    // Same row predicate as every reader: a returned or host-cancelled row has freed its time.
    const conflictStates: Prisma.AppointmentOccurrenceWhereInput = holdExpired
      ? {
          OR: [
            { isTentative: false, ...OCCUPYING_OCCURRENCE_WHERE },
            {
              isTentative: true,
              ...OCCUPYING_OCCURRENCE_WHERE,
              appointmentId: { not: appointmentId },
              appointment: { NOT: buildDeadHoldFilter(now) },
            },
          ],
        }
      : { isTentative: false, ...OCCUPYING_OCCURRENCE_WHERE };
    for (const slot of mySlots) {
      if (participantIds.length === 0 && cohostCommitments.length === 0) {
        continue;
      }
      const conflict = await tx.appointmentOccurrence.findFirst({
        where: {
          id: { not: slot.id },
          startsAt: { lt: slot.endsAt },
          endsAt: { gt: slot.startsAt },
          ...conflictStates,
          appointment:
            cohostCommitments.length > 0
              ? {
                  AND: [
                    { OR: buildOccupiedAppointmentFilter() },
                    {
                      OR: [
                        ...(participantIds.length > 0
                          ? [
                              {
                                participants: {
                                  some: {
                                    userId: { in: participantIds },
                                    ...timeHoldingParticipant(now),
                                  },
                                },
                              },
                            ]
                          : []),
                        ...cohostCommitments,
                      ],
                    },
                  ],
                }
              : {
                  OR: buildOccupiedAppointmentFilter(),
                  participants: {
                    some: {
                      userId: { in: participantIds },
                      ...timeHoldingParticipant(now),
                    },
                  },
                },
        },
        select: { id: true, appointmentId: true },
      });
      if (conflict) {
        reportSentryError(new Error("CONFIRMATION_BLOCKED_DOUBLE_BOOKING"), {
          subsystem: "payments",
          expected: true,
          level: "warning",
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
        const correlationId = `double-booking-blocked:${appointmentId}`;
        const alreadyRecorded = await tx.systemEvent.findFirst({
          where: { correlationId, category: "PAYMENT" },
          select: { id: true },
        });
        if (!alreadyRecorded) {
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
        return { capturedAfterTerminal: false, doubleBookingBlocked: true };
      }
    }
  }

  const BENIGN_EVENT_STATUSES = ["SCHEDULED", "COMPLETED"];

  if (appointment.class && userId) {
    const classId = appointment.class.id;
    if (!(await restampLiveEvent(tx, "class", classId, appointmentId))) {
      const fresh = await tx.class.findUnique({
        where: { id: classId },
        select: { status: true },
      });
      if (!fresh || !BENIGN_EVENT_STATUSES.includes(fresh.status)) {
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

    // A zero-row CAS is read back: a released or missing seat means the
    // capture bought nothing, so it is refunded rather than reported confirmed.
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
      lapsedAt: opts?.holdExpired ? (opts.now ?? new Date()) : undefined,
    });
    if (seat.kind === "released" || seat.kind === "missing") {
      return { capturedAfterTerminal: true, seatReleased: true };
    }

    console.log(
      JSON.stringify({
        event: "class_all_sessions_confirmed",
        classId: appointment.class.id,
        userId,
        timestamp: new Date().toISOString(),
      }),
    );
  } else if (appointment.webinar && userId) {
    const webinarId = appointment.webinar.id;
    if (!(await restampLiveEvent(tx, "webinar", webinarId, appointmentId))) {
      const fresh = await tx.webinar.findUnique({
        where: { id: webinarId },
        select: { status: true },
      });
      if (!fresh || !BENIGN_EVENT_STATUSES.includes(fresh.status)) {
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

    const seat = await confirmSeatAfterCapture(tx, {
      casWhere: { appointmentId, userId, status: "HELD" },
      readWhere: { appointmentId, userId },
      kind: "webinar",
      eventId: webinarId,
      appointmentId,
      userId,
      lapsedAt: opts?.holdExpired ? (opts.now ?? new Date()) : undefined,
    });
    if (seat.kind === "released" || seat.kind === "missing") {
      return { capturedAfterTerminal: true, seatReleased: true };
    }

    console.log(
      JSON.stringify({
        event: "webinar_user_slot_confirmed",
        webinarId: appointment.webinar.id,
        userId,
        timestamp: new Date().toISOString(),
      }),
    );
  } else {
    await tx.appointmentOccurrence.updateMany({
      where: { appointmentId, ...liveOccurrenceWhere },
      data: { isTentative: false },
    });
    await transitionParticipant(
      tx,
      { appointmentId, status: "HELD" },
      "CONFIRMED",
    );
    if (userId) await markBookedWindows(tx, appointmentId, userId);
  }

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

  return { capturedAfterTerminal };
}

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

  const tentativeSlots = appointment.occurrences.filter(
    (slot) => slot.isTentative && slot.deletedAt === null,
  );

  if (tentativeSlots.length > 0) {
    await transitionOccurrenceCompletion(tx, {
      where: { appointmentId, isTentative: true, deletedAt: null },
      to: OccurrenceCompletionStatus.CANCELLED,
      data: { deletedAt: new Date() },
      allowZero: true,
    });

    if (appointment.consultation || appointment.subscription) {
      const remainingSlots = await tx.appointmentOccurrence.count({
        where: { appointmentId, deletedAt: null },
      });
      if (remainingSlots === 0) {
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

const STARTED_BEFORE_PAYMENT_REASON =
  "Your session had already started when your payment arrived, so we've refunded you in full.";

/**
 * A request whose first session started before its payment landed: EXPIRED
 * (nobody cancelled or declined; its window ran out) and its tentative holds
 * released, in the capture's commit. The CAS is the request's own; the money
 * predicate does not apply because this capture is refunded in full.
 */
async function closeStartedBeforePayment(
  tx: Tx,
  appointment: {
    id: string;
    consultation: { id: string } | null;
    subscription: { id: string } | null;
  },
): Promise<void> {
  const meta = {
    actorUserId: null,
    reason: "PAID_AFTER_SESSION_STARTED",
    to: AppointmentStatus.EXPIRED,
    fromIn: [
      AppointmentStatus.PENDING,
      AppointmentStatus.APPROVED_PENDING_PAYMENT,
    ],
    data: { pendingPaymentUrl: null },
  };
  try {
    if (appointment.consultation) {
      await transitionConsultationRequest(tx, {
        ...meta,
        where: { id: appointment.consultation.id },
      });
    } else if (appointment.subscription) {
      await transitionSubscriptionRequest(tx, {
        ...meta,
        where: { id: appointment.subscription.id },
      });
    }
  } catch (error) {
    // Already terminal: the refund still runs; nothing else to close.
    if (!(error instanceof IllegalTransitionError)) throw error;
  }
  await transitionOccurrenceCompletion(tx, {
    actorUserId: null,
    reason: "PAID_AFTER_SESSION_STARTED",
    where: {
      appointmentId: appointment.id,
      isTentative: true,
      deletedAt: null,
    },
    to: OccurrenceCompletionStatus.CANCELLED,
    data: { deletedAt: new Date() },
    allowZero: true,
  });
}

/** The consultee notice for a capture that landed after the session started. */
async function loadStartedBeforePaymentNotice(
  db: Pick<Tx, "appointment">,
  appointmentId: string,
): Promise<RequestExpiredNotice | null> {
  const row = await db.appointment.findUnique({
    where: { id: appointmentId },
    select: {
      organizationId: true,
      occurrences: {
        orderBy: { startsAt: "asc" },
        take: 1,
        select: { startsAt: true },
      },
      consultation: {
        select: {
          requestedBy: {
            select: { user: { select: { id: true, name: true } } },
          },
          consultationPlan: {
            select: {
              title: true,
              consultantProfile: {
                select: { user: { select: { name: true } } },
              },
            },
          },
        },
      },
      subscription: {
        select: {
          requestedBy: {
            select: { user: { select: { id: true, name: true } } },
          },
          subscriptionPlan: {
            select: {
              title: true,
              consultantProfile: {
                select: { user: { select: { name: true } } },
              },
            },
          },
        },
      },
    },
  });
  const request = row?.consultation ?? row?.subscription;
  const consultee = request?.requestedBy?.user;
  if (!row || !request || !consultee) return null;
  const plan =
    "consultationPlan" in request
      ? request.consultationPlan
      : request.subscriptionPlan;
  return {
    appointmentId,
    organizationId: row.organizationId,
    consulteeUserId: consultee.id,
    consulteeName: consultee.name ?? "Consultee",
    consultantName: plan?.consultantProfile?.user?.name ?? "Consultant",
    planTitle:
      plan?.title ?? (row.consultation ? "Consultation" : "Subscription"),
    appointmentType: row.consultation ? "CONSULTATION" : "SUBSCRIPTION",
    startsAt: row.occurrences[0]?.startsAt ?? null,
    reason: STARTED_BEFORE_PAYMENT_REASON,
  };
}

/**
 * Stages that notice in the capture transaction, so it commits with the
 * close and the owed refund. A staging fault rolls back to its own savepoint
 * (the capture still commits) and answers null; the caller then sends the
 * notice directly after the commit.
 */
async function stageStartedBeforePaymentNotice(
  tx: Tx,
  appointmentId: string,
): Promise<StagedRequestExpiredNotice | null> {
  await tx.$executeRaw`SAVEPOINT sp_started_notice`;
  try {
    const notice = await loadStartedBeforePaymentNotice(tx, appointmentId);
    const staged = notice
      ? await stageConsulteeRequestExpired(tx, notice)
      : null;
    await tx.$executeRaw`RELEASE SAVEPOINT sp_started_notice`;
    return staged;
  } catch (error) {
    await tx.$executeRaw`ROLLBACK TO SAVEPOINT sp_started_notice`;
    if (isWriteConflict(error)) throw error;
    reportSentryError(error, {
      subsystem: "payments",
      op: "capture.started-before-payment-notice.stage",
      level: "warning",
    });
    return null;
  }
}

/**
 * Both parties hear a trial paid after its held session started was cancelled
 * (the trial templates carry no reason line); null when staging failed.
 */
async function stageTrialPaidAfterStartNotice(
  tx: Tx,
  trialId: string,
): Promise<StagedNotificationBundle | null> {
  await tx.$executeRaw`SAVEPOINT sp_trial_started_notice`;
  try {
    const trial = await tx.trial.findUnique({
      where: { id: trialId },
      select: {
        subscriptionPlan: { select: { title: true } },
        consultantProfile: {
          select: { user: { select: { id: true, name: true } } },
        },
        consulteeProfile: {
          select: { user: { select: { id: true, name: true } } },
        },
      },
    });
    if (!trial) {
      await tx.$executeRaw`RELEASE SAVEPOINT sp_trial_started_notice`;
      return null;
    }
    const consultant = trial.consultantProfile.user;
    const consultee = trial.consulteeProfile.user;
    const userIds = [consultant.id, consultee.id];
    const consultantName = consultant.name || "Consultant";
    const consulteeName = consultee.name || "User";
    const dashboardUrl = goHref("auto", "appointments");
    const bells = await notifyTrialCancelled(
      userIds,
      {
        consultantName,
        consulteeName,
        planTitle: trial.subscriptionPlan.title,
        status: TrialStatus.CANCELLED,
        dashboardUrl,
      },
      { tx, deferAttempt: true },
    );
    const emails = await stageTrialLifecycleEmail(tx, {
      trialId,
      userIds,
      kind: "TRIAL_CANCELLED",
      planTitle: trial.subscriptionPlan.title,
      consultantUserId: consultant.id,
      consulteeUserId: consultee.id,
      consultantName,
      consulteeName,
      dashboardUrl,
    });
    await tx.$executeRaw`RELEASE SAVEPOINT sp_trial_started_notice`;
    return {
      bells: bells.map((row) => row.staged),
      emails: [{ rows: emails, emailType: "TRIAL_CANCELLED" }],
    };
  } catch (error) {
    await tx.$executeRaw`ROLLBACK TO SAVEPOINT sp_trial_started_notice`;
    if (isWriteConflict(error)) throw error;
    reportSentryError(error, {
      subsystem: "payments",
      op: "capture.trial-paid-after-start-notice.stage",
      level: "warning",
    });
    return null;
  }
}

/** The direct send, when staging failed. Never throws: the refund is separate. */
async function notifyStartedBeforePayment(
  appointmentId: string,
): Promise<void> {
  try {
    const notice = await loadStartedBeforePaymentNotice(prisma, appointmentId);
    if (notice) await notifyConsulteeRequestExpired(notice);
  } catch (error) {
    reportSentryError(error, {
      subsystem: "payments",
      op: "capture.started-before-payment-notice",
      level: "warning",
    });
  }
}
