/**
 * Approval Payment Operations
 *
 * Handles payment link generation for requests that are approved
 * without upfront payment (request-for-approval flow).
 *
 * Workflow:
 * 1. User submits consultation/subscription request (no payment)
 * 2. Consultant approves the request
 * 3. System generates payment link using this module
 * 4. User pays via the link
 * 5. Webhook confirms payment and finalizes appointment
 */

import prisma from "@/lib/prisma";
import { APPROVAL_PAYMENT_EXPIRATION_MS } from "@/lib/payments/constants";
import { validatePlanCurrency } from "@/lib/payments/validation/currency-guards";
import { deriveCheckoutAmount } from "@/lib/payments/pricing/derive-checkout-amount";
import {
  currentGstRegime,
  type GstRegime,
} from "@/lib/payments/tax/gst-regime";
import { detectBuyerCountry } from "@/lib/payments/tax/buyer-country";
import { appointmentTypeToServiceType } from "@/lib/payments/tax/tax-engine";
import { tombstoneAbortedGatewayOrder } from "@/lib/payments/checkout/gateway-intent";
import { tombstonePriorIntent } from "@/lib/payments/operations/prior-intent-tombstone";
import { reportSentryError } from "@/lib/observability/report";
import {
  PRE_MINT_INTENT_PREFIX,
  isPreMintIntent,
} from "@/lib/payments/pre-mint-intent";
import { sumPaise } from "@/lib/payments/utils/money";
import { consumerStateCodeSchema } from "@/schemas/checkout";
import {
  AppointmentStatus,
  Currency,
  PaymentGateway,
  PaymentStatus,
  TrialStatus,
} from "@prisma/client";
import {
  lockApprovalPaymentMint,
  unlockApproval,
  type ApprovalLock,
} from "@/utils/appointmentlock";
import { isUniqueViolationOn } from "@/lib/db/unique-violation";
import { liveOccurrenceWhere } from "@/lib/appointments/occurrences";

// ============================================================================
// Type Definitions
// ============================================================================

export interface CreateApprovalPaymentParams {
  userId: string;
  appointmentType: "CONSULTATION" | "SUBSCRIPTION" | "TRIAL";
  consultationId?: string;
  subscriptionId?: string;
  planId: string;
  /** Required when appointmentType is TRIAL. */
  trialId?: string;
  /**
   * Link the intent to the appointment that ALREADY exists. Every approval
   * arm creates it before minting — trials hold their slot when the
   * consultant accepts, consultations/subscriptions create it at request
   * time (#1181) — so the webhook confirms THAT appointment instead of
   * building a twin (Consultation.appointment is one-to-one; a capture-time
   * creation either collides on the unique or strands the request-time row),
   * and the duplicate-payment guard can see approval payments at all.
   */
  appointmentId?: string;
  /**
   * #1166 ORG-9 — org sponsorship used to be silently DROPPED by the approval
   * flow (no organizationId anywhere in the chain, so an org member's approved
   * request billed their personal card with no attribution). Callers pass the
   * appointment's organizationId; it rides the Payment row and the gateway
   * metadata. Wallet-debit/skip-gateway parity with checkout is tracked in
   * #1166.
   */
  organizationId?: string;
  paymentGateway: PaymentGateway;
  startsAt?: string;
  endsAt?: string;
  schedulingPeriodStartsAt?: string;
  schedulingPeriodEndsAt?: string;
  notes?: string;
}

export interface ApprovalPaymentResult {
  paymentIntentId: string;
  /** The Payment row the order belongs to; the pay page is keyed by it (#1775 P-1). */
  paymentId: string;
  checkoutUrl: string;
  /** What the buyer is charged: list price plus GST (#1583 C-P0-01). */
  amount: number;
  currency: Currency;
  /** When the pay-link stops being payable; what the client is told. */
  expiresAt: Date;
}

// ============================================================================
// Main Function
// ============================================================================

/**
 * Generate payment link for approved consultation/subscription
 * Used in request-for-approval flow after consultant approval
 *
 * @param params - Payment parameters including user, appointment type, and plan details
 * @returns Payment intent ID and checkout URL for user to complete payment
 */
/**
 * H3 FIX: Uses a distributed lock keyed on the resource being paid for
 * (consultationId or subscriptionId) to prevent duplicate payment link
 * generation from concurrent API calls.
 */
const APPROVAL_PAYMENT_LOCK_TTL = 30_000; // 30 seconds

/** How long an approval pay-link stays payable once minted (#1703 D2: 24 h). */
const APPROVAL_PAYMENT_WINDOW_MS = APPROVAL_PAYMENT_EXPIRATION_MS;

/**
 * #1319 review — the request behind a dead intent is already gone, so there is
 * nothing to re-mint against. Raised instead of silently issuing a pay-link
 * for a consultation the sweep has since REJECTED (or a trial it CANCELLED);
 * the approval routes map it to a 409 telling the consultee to re-request.
 */
export class ApprovalWindowLapsedError extends Error {
  constructor() {
    super(
      "The payment window for this approval has lapsed. Ask the consultee to submit the request again.",
    );
    this.name = "ApprovalWindowLapsedError";
  }
}

/**
 * #1589 T-P0-02 — two accepts raced past the mint lock and the second create
 * died on Payment's [userId, appointmentId] unique. That is a state conflict
 * the caller resolves by retrying (the retry reuses the winner's row), so it
 * carries a 409 like ApprovalLockLostError rather than surfacing as a 500.
 */
export class ApprovalPaymentExistsError extends Error {
  // #1780 R-4 — the registered business code the routes answer with.
  readonly code = "PAYMENT_ALREADY_EXISTS";
  readonly httpStatus = 409;
  constructor() {
    super(
      "A payment link for this request was just created by another action. Refresh to see it.",
    );
    this.name = "ApprovalPaymentExistsError";
  }
}

/**
 * #1780 R-4 — the request behind this mint is already paid. A typed 409 (was
 * a bare Error the routes answered as a 502 "mint failed").
 */
export class ApprovalAlreadyPaidError extends Error {
  readonly code = "ALREADY_PAID";
  readonly httpStatus = 409;
  constructor() {
    super("This request has already been paid");
    this.name = "ApprovalAlreadyPaidError";
  }
}

/** A pay window ends this long before the first session starts. */
export const PAY_WINDOW_CLOSES_BEFORE_START_MS = 15 * 60_000;
/** A window shorter than this is not worth minting: the client could not pay in time. */
export const MIN_PAY_WINDOW_MS = 30 * 60_000;

/** 409 — the first session starts too soon for the client to pay before it. */
export class ApprovalTooCloseToStartError extends Error {
  readonly code = "TOO_CLOSE_TO_START";
  readonly httpStatus = 409;
  constructor() {
    super(
      "This session starts too soon for the client to pay. Pick a later time.",
    );
    this.name = "ApprovalTooCloseToStartError";
  }
}

/**
 * The pay window: 24 hours, but never past 15 minutes before the first live
 * session, so nobody pays for a session that has started. A request with no
 * placed session yet gets the plain 24 hours.
 */
export function payWindowEnd(now: Date, firstSessionStart: Date | null): Date {
  const window = now.getTime() + APPROVAL_PAYMENT_WINDOW_MS;
  if (!firstSessionStart) return new Date(window);
  return new Date(
    Math.min(
      window,
      firstSessionStart.getTime() - PAY_WINDOW_CLOSES_BEFORE_START_MS,
    ),
  );
}

/** The earliest live session start of the request this mint pays for. */
async function firstSessionStartOf(
  params: CreateApprovalPaymentParams,
): Promise<Date | null> {
  const appointment = params.appointmentId
    ? { appointmentId: params.appointmentId }
    : params.consultationId
      ? { appointment: { consultationId: params.consultationId } }
      : params.subscriptionId
        ? { appointment: { subscriptionId: params.subscriptionId } }
        : null;
  if (!appointment) return null;
  const first = await prisma.appointmentOccurrence.findFirst({
    where: { ...appointment, ...liveOccurrenceWhere },
    orderBy: { startsAt: "asc" },
    select: { startsAt: true },
  });
  return first?.startsAt ?? null;
}

/** Whether a payment for the request behind this mint has already succeeded. */
async function requestAlreadyPaid(
  params: CreateApprovalPaymentParams,
): Promise<boolean> {
  if (params.appointmentType === "TRIAL" && params.trialId) {
    const trial = await prisma.trial.findUnique({
      where: { id: params.trialId },
      select: { paymentId: true },
    });
    if (!trial?.paymentId) return false;
    const payment = await prisma.payment.findUnique({
      where: { id: trial.paymentId },
      select: { paymentStatus: true },
    });
    return payment?.paymentStatus === PaymentStatus.SUCCEEDED;
  }
  const appointment = params.appointmentId
    ? { appointmentId: params.appointmentId }
    : params.consultationId
      ? { appointment: { consultationId: params.consultationId } }
      : params.subscriptionId
        ? { appointment: { subscriptionId: params.subscriptionId } }
        : null;
  if (!appointment) return false;
  const paid = await prisma.payment.count({
    where: {
      ...appointment,
      paymentStatus: PaymentStatus.SUCCEEDED,
      deletedAt: null,
    },
  });
  return paid > 0;
}

/** Whether the request behind this mint still awaits payment (the same states the reuse guard accepts). */
async function requestStillPayable(
  params: CreateApprovalPaymentParams,
): Promise<boolean> {
  if (params.appointmentType === "TRIAL" && params.trialId) {
    const trial = await prisma.trial.findUnique({
      where: { id: params.trialId },
      select: { status: true, paymentId: true },
    });
    return (
      trial?.status === TrialStatus.AWAITING_PAYMENT ||
      (trial?.status === TrialStatus.PENDING && trial.paymentId === null)
    );
  }
  if (params.appointmentType === "CONSULTATION" && params.consultationId) {
    const row = await prisma.consultation.findUnique({
      where: { id: params.consultationId },
      select: { status: true },
    });
    return row?.status === AppointmentStatus.APPROVED_PENDING_PAYMENT;
  }
  if (params.appointmentType === "SUBSCRIPTION" && params.subscriptionId) {
    const row = await prisma.subscription.findUnique({
      where: { id: params.subscriptionId },
      select: { status: true },
    });
    return row?.status === AppointmentStatus.APPROVED_PENDING_PAYMENT;
  }
  return false;
}

export async function createApprovalPaymentIntent(
  params: CreateApprovalPaymentParams,
): Promise<ApprovalPaymentResult> {
  // Validate params
  if (params.appointmentType === "CONSULTATION" && !params.consultationId) {
    throw new Error(
      "consultationId required for CONSULTATION appointment type",
    );
  }
  if (params.appointmentType === "SUBSCRIPTION" && !params.subscriptionId) {
    throw new Error(
      "subscriptionId required for SUBSCRIPTION appointment type",
    );
  }
  if (params.appointmentType === "TRIAL" && !params.trialId) {
    throw new Error("trialId required for TRIAL appointment type");
  }

  // #1319 — the mint is its own guarded atom, nested under the approval lock
  // the routes still hold while they call this (see lockApprovalPaymentMint).
  // Keyed by appointmentType, the validated discriminator, not by whichever
  // id happens to be set.
  const mintTargetId = (() => {
    switch (params.appointmentType) {
      case "CONSULTATION":
        return params.consultationId;
      case "SUBSCRIPTION":
        return params.subscriptionId;
      case "TRIAL":
        return params.trialId;
    }
  })();
  if (!mintTargetId) {
    throw new Error(
      `${params.appointmentType} approval payment requires its request id`,
    );
  }
  const lock: ApprovalLock = await lockApprovalPaymentMint(
    params.appointmentType,
    mintTargetId,
    APPROVAL_PAYMENT_LOCK_TTL,
  );

  try {
    // Re-read under the mint lock: a request cancelled or expired since the
    // caller decided to mint must never get a payable order.
    if (!(await requestStillPayable(params))) {
      // A capture already landed: the request is paid, not lapsed.
      if (await requestAlreadyPaid(params))
        throw new ApprovalAlreadyPaidError();
      throw new ApprovalWindowLapsedError();
    }
    // BUG-D: Validate user has consultee profile (required for webhook to succeed)
    const user = await prisma.user.findUnique({
      where: { id: params.userId },
      include: { consulteeProfile: true },
    });

    if (!user) {
      throw new Error("User not found");
    }

    if (!user.consulteeProfile) {
      throw new Error(
        "User does not have a consultee profile. Please complete profile setup first.",
      );
    }

    // #1583 C-P0-01 — the same taxed figure checkout derives, computed before
    // the reuse decision below so a live row is compared against it.
    const buyerCountry = detectBuyerCountry({ userCountry: user.country });
    // A domestic buyer's saved state is the invoice's place of supply; an invalid one counts as missing.
    const savedState = consumerStateCodeSchema.safeParse(
      user.consulteeProfile.billingStateCode,
    );
    const consumerStateCode =
      buyerCountry === "IN" && savedState.success ? savedState.data : null;
    const {
      amount,
      originalAmount,
      taxAmount,
      isInternational,
      gstRegime,
      currency,
      plan,
    } = await calculateAmount(params, buyerCountry);

    // FIX Issue #7 / #1181 — duplicate-payment guard, now live for every
    // approval arm: the walk below reads the payments hanging off the
    // request's own appointment(s), which only match once the mint threads
    // appointmentId through (see CreateApprovalPaymentParams).
    const existingPayment = await findExistingLivePayment({
      consultationId: params.consultationId,
      subscriptionId: params.subscriptionId,
      trialId: params.trialId,
      appointmentId: params.appointmentId,
    });

    // #1319 review — set when the row found above is dead and must be re-minted
    // INTO rather than duplicated (see the branch below).
    let remintIntoPaymentId: string | null = null;

    if (existingPayment) {
      if (existingPayment.paymentStatus === PaymentStatus.SUCCEEDED) {
        throw new ApprovalAlreadyPaidError();
      }

      if (isDeadApprovalIntent(existingPayment, new Date())) {
        // #1319 review — the same rule the hold predicate uses: an EXPIRED row,
        // or a PENDING one past its window, is dead, and this branch used to
        // hand its stored intent back as the checkout url. That link points at
        // a slot buildDeadHoldFilter has already released, so the payer either
        // pays for a slot somebody else now holds or pays into an order the
        // sweep is about to void. Minting a SECOND row is not the way out
        // either: Payment is unique on [userId, appointmentId], so the create
        // below would die on P2002. Re-mint into the row instead.
        if (!existingPayment.requestIsPayable) {
          throw new ApprovalWindowLapsedError();
        }
        remintIntoPaymentId = existingPayment.id;
      } else if (
        existingPayment.amount !== amount ||
        existingPayment.originalAmount !== originalAmount ||
        existingPayment.taxAmount !== taxAmount ||
        existingPayment.isInternational !== isInternational ||
        existingPayment.buyerCountry !== buyerCountry ||
        (existingPayment.gstRegime ?? gstRegime) !== gstRegime
      ) {
        // #1583 C-P0-01 — a live row frozen at a different pricing state (a
        // pre-tax mint, or the same total under another tax classification)
        // would charge or invoice the stale figures; re-mint into it instead,
        // the same way checkout supersedes an amount-mismatched open order.
        remintIntoPaymentId = existingPayment.id;
      } else {
        // #1181 — a live PENDING payment from a previous mint attempt is
        // reused, not duplicated. Before the appointment back-link existed
        // this state was invisible (the retry minted a parallel gateway
        // order); now it resolves the #1172 deadlock shape where the link was
        // minted but its persist never landed and re-approval must recover it.
        // The pay-link reconstructs from the stored intent because Razorpay's
        // client_secret IS the order id (#1165 pins approval mints to RAZORPAY).
        return {
          paymentIntentId: existingPayment.paymentIntent,
          paymentId: existingPayment.id,
          checkoutUrl: existingPayment.paymentIntent,
          amount: existingPayment.amount,
          currency: existingPayment.currency,
          expiresAt:
            existingPayment.expiresAt ??
            payWindowEnd(new Date(), await firstSessionStartOf(params)),
        };
      }
    }

    // One deadline for the gateway's capture window and the row, clamped to
    // the first session's start; too short a window is refused.
    const now = new Date();
    const holdExpiresAt = payWindowEnd(now, await firstSessionStartOf(params));
    if (holdExpiresAt.getTime() - now.getTime() < MIN_PAY_WINDOW_MS) {
      throw new ApprovalTooCloseToStartError();
    }
    const description = `Payment for ${params.appointmentType.toLowerCase()} - ${plan.title}`;
    const preMintIntent = `${PRE_MINT_INTENT_PREFIX}${globalThis.crypto.randomUUID()}`;
    const pricing = {
      amount,
      originalAmount,
      taxAmount,
      buyerCountry,
      isInternational,
      gstRegime,
      currency,
    };

    // The row is durable before the gateway is called, so a crash between the two leaves a
    // PENDING pre-mint row the lapsed pay-link sweep retires instead of an order with no row.
    const claim =
      remintIntoPaymentId && existingPayment
        ? await claimRowForRemint(existingPayment, {
            ...pricing,
            userId: params.userId,
            preMintIntent,
            holdExpiresAt,
            description,
            consumerStateCode,
            paymentGateway: params.paymentGateway,
            appointmentType: params.appointmentType,
          })
        : await createPreMintRow(params, {
            ...pricing,
            preMintIntent,
            holdExpiresAt,
            description,
            consumerStateCode,
          });
    if ("settled" in claim) return claim.settled;
    const paymentId = claim.paymentId;
    // First key, so the 15-key notes cap never drops it: a capture finds this row even if the fill below fails.
    const metadata = {
      familiarisePaymentId: paymentId,
      ...buildApprovalMetadata(params, { taxAmount }),
    };

    // Create payment intent with gateway. Imported here, not at module load:
    // the barrel evaluates the Razorpay core and its test-key guard.
    const { createPaymentIntent } = await import("../index");
    let paymentResponse: Awaited<ReturnType<typeof createPaymentIntent>>;
    try {
      paymentResponse = await createPaymentIntent({
        amount,
        currency,
        metadata,
        paymentGateway: params.paymentGateway,
        isMockPayment: false,
        holdExpiresAt,
      });
    } catch (mintError) {
      await expirePreMintRow(paymentId, preMintIntent);
      throw mintError;
    }

    const tombstoneMintedOrder = (reason: string) =>
      tombstoneAbortedGatewayOrder({
        paymentIntent: paymentResponse.id,
        userId: params.userId,
        amount,
        originalAmount,
        taxAmount,
        gstRegime,
        currency,
        reason,
      });

    let filled: boolean;
    try {
      filled = await prisma.$transaction(async (tx) => {
        const cas = await tx.payment.updateMany({
          where: {
            id: paymentId,
            paymentIntent: preMintIntent,
            paymentStatus: PaymentStatus.PENDING,
          },
          data: { paymentIntent: paymentResponse.id },
        });
        if (cas.count !== 1) return false;
        await tx.paymentLeg.updateMany({
          where: { paymentId, source: "CARD" },
          data: { sourceRef: paymentResponse.id },
        });
        return true;
      });
    } catch (fillError) {
      // The minted order must still land on a row, and the pre-mint row must not stay payable.
      const recorded = await tombstoneMintedOrder(
        "approval mint could not record its order",
      );
      if (!recorded) {
        // Sentry may drop this; the log line keeps both ids for a by-hand refund.
        console.error(
          JSON.stringify({
            event: "approval_mint_order_unrecorded",
            paymentId,
            preMintIntent,
            orderId: paymentResponse.id,
          }),
        );
      }
      await expirePreMintRow(paymentId, preMintIntent);
      throw fillError;
    }

    if (!filled) {
      // Another mint took the row while the gateway call ran; the order just minted is owned by nobody.
      await tombstoneMintedOrder(
        "approval mint lost its pre-mint row to a concurrent writer",
      );
      throw new ApprovalPaymentExistsError();
    }

    return {
      paymentIntentId: paymentResponse.id,
      paymentId,
      checkoutUrl: paymentResponse.client_secret,
      amount,
      currency,
      expiresAt: holdExpiresAt,
    };
  } finally {
    await unlockApproval(lock);
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/** The figures a pre-mint row is written with, before its gateway order exists. */
interface PreMintFields {
  amount: number;
  originalAmount: number;
  taxAmount: number;
  buyerCountry: string;
  isInternational: boolean;
  gstRegime: GstRegime;
  currency: Currency;
  preMintIntent: string;
  holdExpiresAt: Date;
  description: string;
  /** The buyer's GST state from their profile; null when abroad or none is saved. */
  consumerStateCode: string | null;
}

/** Either the row the order will be written onto, or an answer that needs no new order. */
type MintClaim = { paymentId: string } | { settled: ApprovalPaymentResult };

async function createPreMintRow(
  params: CreateApprovalPaymentParams,
  fields: PreMintFields,
): Promise<MintClaim> {
  try {
    const created = await prisma.payment.create({
      data: {
        // `amount` carries GST like checkout; `originalAmount` stays the list
        // price, which is what earnings read as the base.
        amount: fields.amount,
        originalAmount: fields.originalAmount,
        taxAmount: fields.taxAmount,
        buyerCountry: fields.buyerCountry,
        isInternational: fields.isInternational,
        gstRegime: fields.gstRegime,
        consumerStateCode: fields.consumerStateCode,
        currency: fields.currency,
        description: fields.description,
        paymentMethod: "card",
        paymentIntent: fields.preMintIntent,
        paymentGateway: params.paymentGateway,
        paymentStatus: PaymentStatus.PENDING,
        organizationId: params.organizationId ?? null,
        userId: params.userId,
        expiresAt: fields.holdExpiresAt,
        isMockPayment: false,
        // The request-time appointment anchors capture to the new flow
        // (confirm the existing row, never create a twin). Null only
        // when the caller genuinely had no appointment to offer.
        appointmentId: params.appointmentId ?? null,
        clientIdempotencyKey: `approval:${globalThis.crypto.randomUUID()}`,
        // Always CARD: the approval flow charges the buyer even when an org is
        // tagged. Nested so a Payment can never exist legless.
        legs: {
          create: {
            source: "CARD",
            amountPaise: fields.amount,
            sourceRef: fields.preMintIntent,
          },
        },
      },
      select: { id: true },
    });
    return { paymentId: created.id };
  } catch (err) {
    // Only the [userId, appointmentId] pair is the double-accept race; no order exists yet to tombstone.
    if (isUniqueViolationOn(err, "appointmentId")) {
      throw new ApprovalPaymentExistsError();
    }
    throw err;
  }
}

/**
 * Re-mint IN PLACE: the row keeps its id, userId and appointmentId and takes a pre-mint intent and
 * the fresh figures by CAS on its prior status and intent; the prior order moves to a tombstone.
 */
async function claimRowForRemint(
  existing: ExistingApprovalPayment,
  fields: PreMintFields & {
    userId: string;
    paymentGateway: PaymentGateway;
    appointmentType: CreateApprovalPaymentParams["appointmentType"];
  },
): Promise<MintClaim> {
  const claimed = await prisma.$transaction(async (tx) => {
    const cas = await tx.payment.updateMany({
      where: {
        id: existing.id,
        paymentStatus: existing.paymentStatus,
        paymentIntent: existing.paymentIntent,
      },
      data: {
        paymentIntent: fields.preMintIntent,
        paymentStatus: PaymentStatus.PENDING,
        expiresAt: fields.holdExpiresAt,
        amount: fields.amount,
        originalAmount: fields.originalAmount,
        taxAmount: fields.taxAmount,
        buyerCountry: fields.buyerCountry,
        isInternational: fields.isInternational,
        gstRegime: fields.gstRegime,
        // A buyer now abroad has no Indian place of supply, so a state from an earlier mint is dropped.
        ...(fields.buyerCountry === "IN" ? {} : { consumerStateCode: null }),
        currency: fields.currency,
        description: fields.description,
        paymentGateway: fields.paymentGateway,
        gatewayPaymentId: null,
        capturedAt: null,
      },
    });
    if (cas.count !== 1) return false;
    if (fields.consumerStateCode) {
      // A state already on the row was declared by the buyer and is never overwritten.
      await tx.payment.updateMany({
        where: {
          id: existing.id,
          paymentIntent: fields.preMintIntent,
          consumerStateCode: null,
        },
        data: { consumerStateCode: fields.consumerStateCode },
      });
    }
    if (isPreMintIntent(existing.paymentIntent)) {
      // A pre-mint row never reached the gateway, so there is no order to keep.
      await tx.paymentLeg.deleteMany({ where: { paymentId: existing.id } });
    } else {
      await tombstonePriorIntent(
        tx,
        { ...existing, userId: fields.userId },
        `${fields.appointmentType.toLowerCase()} pay-link re-minted`,
      );
    }
    await tx.paymentLeg.create({
      data: {
        paymentId: existing.id,
        source: "CARD",
        amountPaise: fields.amount,
        sourceRef: fields.preMintIntent,
      },
    });
    return true;
  });
  if (claimed) return { paymentId: existing.id };

  // The row moved before any order was minted, so nothing needs a tombstone.
  const fresh = await prisma.payment.findUnique({
    where: { id: existing.id },
    select: {
      id: true,
      paymentStatus: true,
      paymentIntent: true,
      amount: true,
      currency: true,
      expiresAt: true,
    },
  });
  if (fresh?.paymentStatus === PaymentStatus.SUCCEEDED) {
    throw new ApprovalAlreadyPaidError();
  }
  if (
    fresh?.paymentStatus === PaymentStatus.PENDING &&
    !isPreMintIntent(fresh.paymentIntent)
  ) {
    // Another mint replaced the order first; its link is the live one.
    return {
      settled: {
        paymentIntentId: fresh.paymentIntent,
        paymentId: fresh.id,
        checkoutUrl: fresh.paymentIntent,
        amount: fresh.amount,
        currency: fresh.currency,
        expiresAt: fresh.expiresAt ?? fields.holdExpiresAt,
      },
    };
  }
  throw new ApprovalPaymentExistsError();
}

/** A failed gateway call leaves its pre-mint row EXPIRED, so the next mint re-mints into it. */
async function expirePreMintRow(
  paymentId: string,
  preMintIntent: string,
): Promise<void> {
  try {
    await prisma.payment.updateMany({
      where: {
        id: paymentId,
        paymentIntent: preMintIntent,
        paymentStatus: PaymentStatus.PENDING,
      },
      data: { paymentStatus: PaymentStatus.EXPIRED, expiresAt: new Date() },
    });
  } catch (expireError) {
    reportSentryError(expireError, {
      subsystem: "payments",
      extra: { paymentId },
    });
  }
}

/** The taxed figure and its parts, derived exactly as checkout derives them. */
interface ApprovalAmount {
  /** Charged to the buyer: list price plus tax. */
  amount: number;
  /** The list price, before tax — the consultant's earnings base. */
  originalAmount: number;
  taxAmount: number;
  isInternational: boolean;
  gstRegime: GstRegime;
  currency: Currency;
  plan: { title: string };
}

/**
 * A stored plan price as a safe, non-negative paise integer. `sumPaise` is the
 * repo's BigInt-to-number gate (#780); a negative list price is a data fault.
 */
function planPricePaise(value: bigint | number, label: string): number {
  const paise = sumPaise(value);
  if (paise < 0) {
    throw new Error(
      `${label} is negative (${paise} paise); refusing to price it`,
    );
  }
  return paise;
}

/**
 * The pay-link charges the same tax as checkout through the one price
 * derivation (`deriveCheckoutAmount`). No discount code and no referral credits
 * ride a pay-link, so those inputs are deliberately absent.
 */
async function priceWithTax(
  basePaise: number,
  buyerCountry: string,
  appointmentType: CreateApprovalPaymentParams["appointmentType"],
): Promise<
  Pick<
    ApprovalAmount,
    "amount" | "originalAmount" | "taxAmount" | "isInternational" | "gstRegime"
  >
> {
  const derived = await deriveCheckoutAmount({
    basePaise,
    buyerCountry,
    gstRegime: currentGstRegime(),
    // A trial is a taster of a subscription plan, so it is taxed as one.
    serviceType: appointmentTypeToServiceType(
      appointmentType === "TRIAL" ? "SUBSCRIPTION" : appointmentType,
    ),
  });
  return {
    amount: derived.amount,
    originalAmount: derived.originalAmount,
    taxAmount: derived.taxAmount,
    isInternational: derived.isInternational,
    gstRegime: derived.gstRegime,
  };
}

/**
 * Calculate payment amount from plan
 */
async function calculateAmount(
  params: CreateApprovalPaymentParams,
  buyerCountry: string,
): Promise<ApprovalAmount> {
  if (params.appointmentType === "TRIAL") {
    // A trial is priced by its parent subscription plan's trialPriceInPaise,
    // NOT the plan price — the trial is a taster of that plan, not the plan.
    const plan = await prisma.subscriptionPlan.findUnique({
      where: { id: params.planId },
      select: {
        title: true,
        trialPriceInPaise: true,
        trialEnabled: true,
        priceCurrency: true,
      },
    });

    if (!plan) {
      throw new Error("Subscription plan not found");
    }
    if (!plan.trialEnabled) {
      throw new Error("This plan does not offer trials");
    }
    if (plan.trialPriceInPaise <= 0) {
      // Free trials never reach a payment intent — the accept path schedules
      // them directly. Reaching here means the caller mis-routed.
      throw new Error("Cannot create a payment intent for a free trial");
    }

    const currency = plan.priceCurrency;
    validatePlanCurrency(currency); // see the note on the CONSULTATION branch

    return {
      ...(await priceWithTax(
        planPricePaise(plan.trialPriceInPaise, "trialPriceInPaise"),
        buyerCountry,
        params.appointmentType,
      )),
      currency,
      plan: { title: `${plan.title} — trial` },
    };
  }

  if (params.appointmentType === "CONSULTATION") {
    const plan = await prisma.consultationPlan.findUnique({
      where: { id: params.planId },
      select: {
        title: true,
        price: true,
        priceCurrency: true,
      },
    });

    if (!plan) {
      throw new Error("Consultation plan not found");
    }

    const currency = plan.priceCurrency;
    // Every stage below treats the amount as INR paise, so a non-INR plan must refuse here.
    validatePlanCurrency(currency);

    return {
      ...(await priceWithTax(
        planPricePaise(plan.price, "plan price"),
        buyerCountry,
        params.appointmentType,
      )),
      currency,
      plan: { title: plan.title },
    };
  } else {
    // SUBSCRIPTION
    const plan = await prisma.subscriptionPlan.findUnique({
      where: { id: params.planId },
      select: {
        title: true,
        price: true,
        priceCurrency: true,
      },
    });

    if (!plan) {
      throw new Error("Subscription plan not found");
    }

    // #781 §A — priceCurrency is the non-null Currency enum; no gateway fallback.
    const currency = plan.priceCurrency;
    validatePlanCurrency(currency); // see the note on the CONSULTATION branch

    return {
      ...(await priceWithTax(
        planPricePaise(plan.price, "plan price"),
        buyerCountry,
        params.appointmentType,
      )),
      currency,
      plan: { title: plan.title },
    };
  }
}

/**
 * Build metadata for webhook processing
 * This metadata will be passed to handlePaymentSuccess() when payment completes
 */
function buildApprovalMetadata(
  params: CreateApprovalPaymentParams,
  pricing: { taxAmount: number },
): Record<string, string> {
  const metadata: Record<string, string> = {
    appointmentType: params.appointmentType,
    userId: params.userId,
    planId: params.planId,
    notes: params.notes || "",
    isApprovalFlow: "true", // Flag to indicate this is from approval flow
    // #1583 C-P0-01 — readable on the gateway order; the webhook's Zod
    // schema strips unknown keys, so this rides alongside the routing keys.
    taxAmount: String(pricing.taxAmount),
  };

  // #1181 — absent, never the string "pending". The real anchor lives on the
  // Payment row, which is what the capture handler branches on, so the
  // sentinel bought nothing and cost the one thing a metadata key is for: a
  // reader can no longer tell "no appointment yet" from an appointment that
  // happens to be called pending. The sibling Payment column already writes
  // null here; gateway notes are string-valued, so absence is that null.
  if (params.appointmentId) {
    metadata.appointmentId = params.appointmentId;
  }

  // Add consultation-specific fields
  if (params.consultationId) {
    metadata.consultationId = params.consultationId;
  }

  // Add subscription-specific fields
  if (params.subscriptionId) {
    metadata.subscriptionId = params.subscriptionId;
  }

  // Add trial-specific fields — the webhook resolves the Trial from this.
  if (params.trialId) {
    metadata.trialId = params.trialId;
  }

  // #1166 ORG-9 — org attribution survives into the gateway round-trip so the
  // capture side can verify it against the Payment row.
  if (params.organizationId) {
    metadata.organizationId = params.organizationId;
  }

  // Add slot times if provided
  if (params.startsAt && params.endsAt) {
    metadata.startsAt = params.startsAt;
    metadata.endsAt = params.endsAt;
  }

  // Add scheduling period if provided
  if (params.schedulingPeriodStartsAt && params.schedulingPeriodEndsAt) {
    metadata.schedulingPeriodStartsAt = params.schedulingPeriodStartsAt;
    metadata.schedulingPeriodEndsAt = params.schedulingPeriodEndsAt;
  }

  return metadata;
}

/**
 * The row this lookup found, plus the two facts the mint needs to decide
 * between reusing it, re-minting into it, and refusing.
 */
export interface ExistingApprovalPayment {
  id: string;
  paymentStatus: PaymentStatus;
  paymentIntent: string;
  /** Moves to the tombstone with the old order on a re-mint. */
  gatewayPaymentId: string | null;
  paymentGateway: PaymentGateway;
  amount: number;
  /** The frozen pricing state; a live row is reused only when all of it matches. */
  originalAmount: number;
  taxAmount: number;
  isInternational: boolean;
  /** Place of supply on the invoice; two countries can carry one tax figure. */
  buyerCountry: string | null;
  gstRegime: GstRegime | null;
  currency: Currency;
  expiresAt: Date | null;
  /**
   * Whether the request this payment belongs to can still be paid for — an
   * APPROVED_PENDING_PAYMENT consultation/subscription, or an AWAITING_PAYMENT
   * trial. False once the expiry sweep has moved it on, which is the signal to
   * refuse rather than re-mint (see ApprovalWindowLapsedError).
   */
  requestIsPayable: boolean;
}

/**
 * #1319 review — the mint's twin of isOccupiedByLiveAppointment's payment
 * clause. A row is dead when the sweep already marked it EXPIRED, or it is
 * still PENDING past its own window. Never by the clock alone: a SUCCEEDED row
 * keeps its expiresAt, and a PENDING row with no window never lapses.
 */
function isDeadApprovalIntent(
  payment: ExistingApprovalPayment,
  now: Date,
): boolean {
  if (payment.paymentStatus === PaymentStatus.EXPIRED) return true;
  // A pre-mint row whose order never landed is never handed back as a link.
  if (isPreMintIntent(payment.paymentIntent)) return true;
  return (
    payment.paymentStatus === PaymentStatus.PENDING &&
    !!payment.expiresAt &&
    new Date(payment.expiresAt) < now
  );
}

/**
 * Find the payment already attached to this request's appointment(s).
 * Returns null when nothing has been minted, or when only a FAILED row remains
 * (a gateway rejection, which a fresh mint may supersede). SUCCEEDED, PENDING
 * and EXPIRED all come back: the mint refuses on the first, reuses or re-mints
 * into the second depending on its window, and always re-mints into the third,
 * because Payment is unique on [userId, appointmentId] and a second row for the
 * same pair cannot be inserted. This is the duplicate-payment guard's lookup —
 * it can only ever match once callers thread appointmentId, because it walks
 * payments hanging off the appointment (#1181).
 */
const EXISTING_PAYMENT_SELECT = {
  id: true,
  paymentStatus: true,
  paymentIntent: true,
  gatewayPaymentId: true,
  paymentGateway: true,
  amount: true,
  originalAmount: true,
  taxAmount: true,
  isInternational: true,
  buyerCountry: true,
  gstRegime: true,
  currency: true,
  expiresAt: true,
} as const;

/** The trial arm of findExistingLivePayment, lifted out to keep its complexity in bounds. */
async function findExistingTrialPayment(
  trialId: string,
  anchorAppointmentId: string | undefined,
  reusable: PaymentStatus[],
): Promise<ExistingApprovalPayment | null> {
  // #1775 P-1 — the placeholder appointment exists from request time (C-7),
  // so the live row is found through it; Trial.paymentId (set at capture) is the fallback.
  const trial = await prisma.trial.findUnique({
    where: { id: trialId },
    select: {
      status: true,
      paymentId: true,
      appointmentId: true,
      payment: { select: EXISTING_PAYMENT_SELECT },
    },
  });
  const appointmentId = anchorAppointmentId ?? trial?.appointmentId;
  const viaAppointment = appointmentId
    ? await prisma.payment.findFirst({
        where: {
          appointmentId,
          deletedAt: null,
          paymentStatus: { in: reusable },
        },
        orderBy: { createdAt: "desc" },
        select: EXISTING_PAYMENT_SELECT,
      })
    : null;
  const payment = viaAppointment ?? trial?.payment;

  // Same status filter as the consultation/subscription arms below: a FAILED
  // gateway order is a rejection the buyer must retry from scratch, so it is
  // not offered back to the mint at all.
  if (!payment || !reusable.includes(payment.paymentStatus)) {
    return null;
  }
  // A paid-at-request trial is payable while PENDING and not yet captured (#1775 C-7).
  const requestIsPayable =
    trial?.status === TrialStatus.AWAITING_PAYMENT ||
    (trial?.status === TrialStatus.PENDING && trial.paymentId === null);
  return { ...payment, requestIsPayable };
}

export async function findExistingLivePayment(params: {
  consultationId?: string;
  subscriptionId?: string;
  trialId?: string;
  /** The appointment the mint anchors to; the trial arm resolves through it. */
  appointmentId?: string;
}): Promise<ExistingApprovalPayment | null> {
  const REUSABLE_STATUSES: PaymentStatus[] = [
    PaymentStatus.SUCCEEDED,
    PaymentStatus.PENDING,
    PaymentStatus.EXPIRED,
  ];
  if (params.trialId) {
    return findExistingTrialPayment(
      params.trialId,
      params.appointmentId,
      REUSABLE_STATUSES,
    );
  }

  if (params.consultationId) {
    const consultation = await prisma.consultation.findUnique({
      where: { id: params.consultationId },
      include: {
        appointment: {
          include: {
            payment: true,
          },
        },
      },
    });

    const payment = consultation?.appointment?.payment?.find((p) =>
      REUSABLE_STATUSES.includes(p.paymentStatus),
    );

    if (!payment) return null;
    return {
      id: payment.id,
      paymentStatus: payment.paymentStatus,
      paymentIntent: payment.paymentIntent,
      gatewayPaymentId: payment.gatewayPaymentId,
      paymentGateway: payment.paymentGateway,
      amount: payment.amount,
      originalAmount: payment.originalAmount,
      taxAmount: payment.taxAmount,
      isInternational: payment.isInternational,
      buyerCountry: payment.buyerCountry,
      gstRegime: payment.gstRegime,
      currency: payment.currency,
      expiresAt: payment.expiresAt,
      requestIsPayable:
        consultation?.status === AppointmentStatus.APPROVED_PENDING_PAYMENT,
    };
  }

  if (params.subscriptionId) {
    const subscription = await prisma.subscription.findUnique({
      where: { id: params.subscriptionId },
      include: {
        appointment: {
          include: {
            payment: true,
          },
        },
      },
    });

    // Check the wrapper for a payment (#1554: one per subscription)
    for (const apt of subscription?.appointment
      ? [subscription.appointment]
      : []) {
      const payment = apt.payment?.find((p) =>
        REUSABLE_STATUSES.includes(p.paymentStatus),
      );
      if (payment) {
        return {
          id: payment.id,
          paymentStatus: payment.paymentStatus,
          paymentIntent: payment.paymentIntent,
          gatewayPaymentId: payment.gatewayPaymentId,
          paymentGateway: payment.paymentGateway,
          amount: payment.amount,
          originalAmount: payment.originalAmount,
          taxAmount: payment.taxAmount,
          isInternational: payment.isInternational,
          buyerCountry: payment.buyerCountry,
          gstRegime: payment.gstRegime,
          currency: payment.currency,
          expiresAt: payment.expiresAt,
          requestIsPayable:
            subscription?.status === AppointmentStatus.APPROVED_PENDING_PAYMENT,
        };
      }
    }

    return null;
  }

  return null;
}
