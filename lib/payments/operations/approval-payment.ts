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
import { detectBuyerCountry } from "@/lib/payments/tax/buyer-country";
import { appointmentTypeToServiceType } from "@/lib/payments/tax/tax-engine";
import { tombstoneAbortedGatewayOrder } from "@/lib/payments/operations/checkout";
import { sumPaise } from "@/lib/payments/utils/money";
import {
  AppointmentStatus,
  Currency,
  PaymentGateway,
  PaymentStatus,
  Prisma,
  TrialStatus,
} from "@prisma/client";
import {
  lockApprovalPaymentMint,
  unlockApproval,
  type ApprovalLock,
} from "@/utils/appointmentlock";

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
    const {
      amount,
      originalAmount,
      taxAmount,
      isInternational,
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
        existingPayment.buyerCountry !== buyerCountry
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
        };
      }
    }

    // Build metadata for webhook processing
    const metadata = buildApprovalMetadata(params, { taxAmount });

    // Create payment intent with gateway. Imported here, not at module load:
    // the barrel evaluates the Razorpay core and its #1219 test-key guard.
    const { createPaymentIntent } = await import("../index");
    const paymentResponse = await createPaymentIntent({
      amount,
      currency,
      metadata,
      paymentGateway: params.paymentGateway,
      isMockPayment: false,
    });

    if (remintIntoPaymentId && existingPayment) {
      // #1319 review — re-mint IN PLACE. The row keeps its id, userId and
      // appointmentId (so the unique pair, the appointment back-link and every
      // downstream reference survive) and takes the new order's identity,
      // status and window. The figures are re-frozen to the ones the gateway
      // was just asked for: leaving the old amount would make the trial
      // checkout page quote a number the charge does not honour, which is
      // exactly the drift that froze the amount onto this row to begin with.
      // The CARD leg follows for the same reason — the funding legs (every
      // source but REFERRAL_CREDIT) must still sum to amount (#1347).
      //
      // CAS-in-WHERE (ADR 21): the pre-read's status AND intent ride the
      // WHERE, so a capture that landed on the old order between the read and
      // this write matches zero rows instead of being reset to PENDING under
      // a replaced order. The leg follows only once the CAS has won.
      const priorStatus = existingPayment.paymentStatus;
      const priorIntent = existingPayment.paymentIntent;
      const claimed = await prisma.$transaction(async (tx) => {
        const cas = await tx.payment.updateMany({
          where: {
            id: remintIntoPaymentId,
            paymentStatus: priorStatus,
            paymentIntent: priorIntent,
          },
          data: {
            paymentIntent: paymentResponse.id,
            paymentStatus: PaymentStatus.PENDING,
            expiresAt: new Date(Date.now() + APPROVAL_PAYMENT_WINDOW_MS),
            amount,
            originalAmount,
            taxAmount,
            buyerCountry,
            isInternational,
            currency,
            description: `Payment for ${params.appointmentType.toLowerCase()} - ${plan.title}`,
            paymentGateway: params.paymentGateway,
          },
        });
        if (cas.count !== 1) return false;
        await tx.paymentLeg.updateMany({
          where: { paymentId: remintIntoPaymentId, source: "CARD" },
          data: { amountPaise: amount, sourceRef: paymentResponse.id },
        });
        return true;
      });

      if (!claimed) {
        // The row moved under us. The order just minted is payable and owned
        // by nobody, so it gets the #1695 tombstone; then the fresh row says
        // what actually happened.
        await tombstoneAbortedGatewayOrder({
          paymentIntent: paymentResponse.id,
          userId: params.userId,
          amount,
          originalAmount,
          taxAmount,
          currency,
          reason: "approval re-mint lost its CAS to a concurrent writer",
        });
        const fresh = await prisma.payment.findUnique({
          where: { id: remintIntoPaymentId },
          select: {
            id: true,
            paymentStatus: true,
            paymentIntent: true,
            amount: true,
            currency: true,
          },
        });
        if (fresh?.paymentStatus === PaymentStatus.SUCCEEDED) {
          // The old order was captured; the routes answer this the same way
          // the pre-read does. Handing back a link would email a pay-link
          // for a paid order.
          throw new ApprovalAlreadyPaidError();
        }
        if (fresh?.paymentStatus === PaymentStatus.PENDING) {
          // Another mint replaced the order first; its link is the live one.
          return {
            paymentIntentId: fresh.paymentIntent,
            paymentId: fresh.id,
            checkoutUrl: fresh.paymentIntent,
            amount: fresh.amount,
            currency: fresh.currency,
          };
        }
        throw new ApprovalPaymentExistsError();
      }

      return {
        paymentIntentId: paymentResponse.id,
        paymentId: remintIntoPaymentId,
        checkoutUrl: paymentResponse.client_secret,
        amount,
        currency,
      };
    }

    // Store payment record in database
    let createdPaymentId: string;
    try {
      const created = await prisma.payment.create({
        data: {
          // #1583 C-P0-01 — `amount` carries GST like checkout; `originalAmount`
          // stays the list price, which is what earnings read as the base.
          amount,
          originalAmount,
          taxAmount,
          buyerCountry,
          isInternational,
          currency,
          description: `Payment for ${params.appointmentType.toLowerCase()} - ${plan.title}`,
          paymentMethod: "card",
          paymentIntent: paymentResponse.id,
          paymentGateway: params.paymentGateway,
          paymentStatus: PaymentStatus.PENDING,
          organizationId: params.organizationId ?? null,
          userId: params.userId,
          expiresAt: new Date(Date.now() + APPROVAL_PAYMENT_WINDOW_MS),
          isMockPayment: false,
          // #1181 — the request-time appointment anchors capture to the NEW
          // flow (confirm the existing row, never create a twin). Null only
          // when the caller genuinely had no appointment to offer.
          appointmentId: params.appointmentId ?? null,
          // Every Payment must carry at least one PaymentLeg
          // (docs/enterprise/10-money-and-ledger/09-payment-legs.md); checkout
          // writes it at creation so the invariant holds before capture, and
          // this flow was the one gateway path that never did. Always CARD: the
          // approval flow charges the buyer even when an org is tagged (the
          // wallet-debit/skip-gateway parity is #1166). Nested so a Payment can
          // never exist legless.
          legs: {
            create: {
              source: "CARD",
              amountPaise: amount,
              sourceRef: paymentResponse.id,
            },
          },
        },
        select: { id: true },
      });
      createdPaymentId = created.id;
    } catch (err) {
      // Only the [userId, appointmentId] pair is the double-accept race; any
      // other unique is a real fault and keeps its Prisma error.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002" &&
        String(err.meta?.target ?? "").includes("appointmentId")
      ) {
        // The gateway order above is already minted and payable; give a late
        // capture on it a row to refund against (#1695) before refusing. If
        // that row could not be written the conflict is not safe to answer as
        // a settled 409: the original error keeps the caller's retry alive.
        const persisted = await tombstoneAbortedGatewayOrder({
          paymentIntent: paymentResponse.id,
          userId: params.userId,
          amount,
          originalAmount,
          taxAmount,
          currency,
          reason: "approval pay-link lost a concurrent double-accept",
        });
        if (persisted) throw new ApprovalPaymentExistsError();
      }
      throw err;
    }

    return {
      paymentIntentId: paymentResponse.id,
      paymentId: createdPaymentId,
      checkoutUrl: paymentResponse.client_secret,
      amount,
      currency,
    };
  } finally {
    await unlockApproval(lock);
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/** The taxed figure and its parts, derived exactly as checkout derives them. */
interface ApprovalAmount {
  /** Charged to the buyer: list price plus tax. */
  amount: number;
  /** The list price, before tax — the consultant's earnings base. */
  originalAmount: number;
  taxAmount: number;
  isInternational: boolean;
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
 * #1583 C-P0-01 — the pay-link charges the same tax as checkout by calling the
 * one price derivation (`deriveCheckoutAmount`). No discount code and no
 * referral credits ride a pay-link (owner decision Q3), so those inputs are
 * deliberately absent.
 */
async function priceWithTax(
  basePaise: number,
  buyerCountry: string,
  appointmentType: CreateApprovalPaymentParams["appointmentType"],
): Promise<
  Pick<
    ApprovalAmount,
    "amount" | "originalAmount" | "taxAmount" | "isInternational"
  >
> {
  const derived = await deriveCheckoutAmount({
    basePaise,
    buyerCountry,
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

    // #781 §A — priceCurrency is the non-null Currency enum; no gateway fallback.
    const currency = plan.priceCurrency;
    // The direct-checkout path has always called this; this path never did, and
    // it is the one that charges through Stripe in the plan's own currency. A
    // GBP-priced plan booked via request→approve therefore took a real GBP
    // charge, wrote Payment.currency="GBP" with an amount in pence, and every
    // stage below then treated that number as INR paise: the earnings row is
    // hardcoded "INR", the journal posts it into an INR account, and the payout
    // is sized off it. Nothing downstream compares an amount against its own
    // currency, so it balances cleanly and reconciles clean while being wrong
    // by the GBP:INR rate — with the shortfall landing on the consultant.
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
  amount: number;
  /** The frozen pricing state; a live row is reused only when all of it matches. */
  originalAmount: number;
  taxAmount: number;
  isInternational: boolean;
  /** Place of supply on the invoice; two countries can carry one tax figure. */
  buyerCountry: string | null;
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
  amount: true,
  originalAmount: true,
  taxAmount: true,
  isInternational: true,
  buyerCountry: true,
  currency: true,
  expiresAt: true,
} as const;

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
    // #1775 P-1 — the placeholder appointment exists from request time (C-7),
    // so the live row is found through it; Trial.paymentId (set at capture) is the fallback.
    const trial = await prisma.trial.findUnique({
      where: { id: params.trialId },
      select: {
        status: true,
        paymentId: true,
        appointmentId: true,
        payment: { select: EXISTING_PAYMENT_SELECT },
      },
    });
    const appointmentId = params.appointmentId ?? trial?.appointmentId;
    const viaAppointment = appointmentId
      ? await prisma.payment.findFirst({
          where: {
            appointmentId,
            deletedAt: null,
            paymentStatus: { in: REUSABLE_STATUSES },
          },
          orderBy: { createdAt: "desc" },
          select: EXISTING_PAYMENT_SELECT,
        })
      : null;
    const payment = viaAppointment ?? trial?.payment;

    // Same status filter as the consultation/subscription arms below: a FAILED
    // gateway order is a rejection the buyer must retry from scratch, so it is
    // not offered back to the mint at all.
    if (!payment || !REUSABLE_STATUSES.includes(payment.paymentStatus)) {
      return null;
    }
    // A paid-at-request trial is payable while PENDING and not yet captured (#1775 C-7).
    const requestIsPayable =
      trial?.status === TrialStatus.AWAITING_PAYMENT ||
      (trial?.status === TrialStatus.PENDING && trial.paymentId === null);
    return { ...payment, requestIsPayable };
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
      amount: payment.amount,
      originalAmount: payment.originalAmount,
      taxAmount: payment.taxAmount,
      isInternational: payment.isInternational,
      buyerCountry: payment.buyerCountry,
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
          amount: payment.amount,
          originalAmount: payment.originalAmount,
          taxAmount: payment.taxAmount,
          isInternational: payment.isInternational,
          buyerCountry: payment.buyerCountry,
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
