// The checkout flow: org gate, price, lock, in-lock revalidation, order reuse
// or mint, the booking transaction, post-commit follow-ups, lock release.

import { scheduleAfter } from "@/lib/api/after-safe";
import { reportSentryError } from "@/lib/observability/report";
import { PaymentError } from "@/lib/payments/core/types";
import prisma from "@/lib/prisma";
import {
  consumerBuyerStateSchema,
  type CheckoutInput,
} from "@/schemas/checkout";
import { PaymentGateway } from "@prisma/client";
import {
  requestLockBudget,
  lockConsulteeBooking,
  unlockConsulteeBooking,
  unlockRequestCap,
  extendLock,
  extendSlotInterval,
  slotGrantEntries,
  unlockSlotInterval,
  CHECKOUT_LOCK_TTL_MS,
  ApprovalLock,
  ConsulteeBookingBusyError,
  EventCheckoutBusyError,
  type SlotBatchGrant,
} from "@/utils/appointmentlock";
import { isPreMintIntent } from "@/lib/payments/pre-mint-intent";
import {
  mintPreMintedSeatOrder,
  newSeatPreMintIntent,
  SeatHoldLapsedError,
  SeatOrderMintFailure,
} from "@/lib/payments/checkout/seat-pre-mint";
import {
  hasBilledSupply,
  isZeroAmountOrder,
} from "@/lib/payments/checkout/zero-amount";
import { prepareFreeSeatNotice } from "@/lib/payments/checkout/free-seat-notice";
import {
  DIRECT_CHECKOUT_HOLD_MS,
  SEAT_CHECKOUT_HOLD_MS,
  seatGatewayDeadline,
} from "@/lib/payments/constants";
import { isUniqueViolationOn } from "@/lib/db/unique-violation";
import {
  isQueryReadTimeout,
  isRolledBackTransaction,
} from "@/lib/db/pg-errors";
import { getExchangeRates } from "@/lib/currency";
import { flushNotificationsAfter } from "@/lib/novu/stage-then-attempt";
import { asWelcomeDiscountConflict } from "@/lib/referrals/attribution";
import { WalletFrozenError } from "@/lib/payments/wallet-freeze";
import { ProgramAssignmentLimitError } from "@/lib/api/organizations/program-helpers";
import { notifyOverageDueAfterCommit } from "@/lib/payments/billing/overage-settlement";
import { mintConsumerInvoiceBestEffort } from "@/lib/payments/billing/consumer-invoice";
import { savedCardCustomerId } from "@/lib/payments/core/saved-card-customer";
import { ensurePlatformCancellationPolicy } from "@/lib/payments/operations/cancellation-policy-store";
import {
  type BusinessErrorCode,
  isBusinessErrorCode,
} from "@/lib/errors/classification/payment-error-classification";
import {
  releaseSupersededHolds,
  findReusablePendingOrderPayment,
  openOrderTargetOf,
} from "@/lib/payments/checkout/order-reuse";
import { buildPaymentMetadata } from "@/lib/payments/checkout/schema";
import { tombstoneAbortedGatewayOrder } from "@/lib/payments/checkout/gateway-intent";
import {
  getPlanDataForLock,
  releaseCheckoutLock,
  acquireCheckoutLock,
  lockBuyerSeatAtoms,
  lockExpertPlanSales,
} from "@/lib/payments/checkout/locks";
import { asSeatPaymentConflict } from "@/lib/payments/checkout/seats";
import { SlotTakenError } from "@/lib/booking/booking-rule-error";
import { calculateAmountAndValidate } from "@/lib/payments/checkout/pricing";
import { revalidateInsideLock } from "@/lib/payments/checkout/revalidate";
import {
  assertWithinInvoiceCreditLimit,
  readInvoiceExposurePaise,
  resolveOrgFunding,
} from "@/lib/payments/checkout/org-funding";
import { commitCheckout } from "@/lib/payments/checkout/commit";
import {
  assertSubscriptionDemandRoom,
  resolveSubscriptionPurchase,
} from "@/lib/payments/checkout/subscription-demand";
import {
  assertOrgBillingAvailable,
  currentGstRegime,
} from "@/lib/payments/tax/gst-regime";
import { dispatchProgramBell } from "@/lib/payments/checkout/program-bell";

export const REFERRAL_CREDITS_DROPPED_NOTICE =
  "Referral credits can't be used on organisation-funded bookings, so none were spent.";

/**
 * #1582 B-P1-01b — coded refusals raised INSIDE the checkout transaction that
 * are modelled outcomes (tagged expected at Sentry). The overage-funding codes
 * stay out on purpose: they mean a programme is configured in a shape we
 * cannot collect on and must keep paging.
 */
export const IN_TX_MODELLED_REFUSAL_CODES: ReadonlySet<BusinessErrorCode> =
  new Set<BusinessErrorCode>([
    "ORG_NOT_OPERATIONAL",
    "ORG_CANNOT_SPONSOR",
    "ORG_MEMBERSHIP_REQUIRED",
    "ORG_CREDIT_LIMIT_REACHED",
    "CONSULTANT_NOT_ON_PANEL",
    "CONSULTANT_EXCLUSIVE_ENGAGEMENT",
    "CREDIT_SHORTFALL",
    "DISCOUNT_EXHAUSTED",
    "DISCOUNT_CODE_INVALID",
    "SUBSCRIPTION_ALREADY_ACTIVE",
    "NOT_PLACEABLE",
    "PLAN_CLIENTS_FULL",
    "NOT_ACCEPTING_BOOKINGS",
    "REQUEST_APPROVAL_REQUIRED",
    "ALREADY_RENEWED",
    "INVALID_RENEWAL_SOURCE",
    "WELCOME_DISCOUNT_IN_USE",
    "DISCOUNT_NOT_APPLICABLE",
    "PAYMENT_ALREADY_EXISTS",
    "SEAT_REBUY_UNSUPPORTED",
    "ALREADY_REGISTERED",
  ]);

/**
 * Production checkout flow (real payments)
 * Steps:
 * 1. Validate data and calculate amount
 * 2. Create payment intent with gateway
 * 3. Create payment record with PENDING status
 * 4. Return payment intent for client to complete
 * 5. Appointment will be created via webhook after payment success
 */
export async function handleCheckout(
  validatedData: CheckoutInput,
  userId: string,
  isMockPayment: boolean = false,
  buyerCountry: string = "IN",
  /** The `fam_via` own-link cookie, read by the route. */
  attribution: { viaToken?: string | null } = {},
) {
  const requestedType = validatedData.appointmentType;
  // Trials are booked through the trial flow; checkout never prices one.
  if (requestedType === "TRIAL") {
    throw new Error(`Unsupported appointment type: ${requestedType}`);
  }
  let lock: ApprovalLock | ApprovalLock[] | null = null;
  let lockType = "";
  // #898 follow-up — tier-2 consultee lock (acquired alongside the checkout lock
  // below; see the ordering note at STEP 2).
  let consulteeLock: ApprovalLock | null = null;
  // A plan checkout's per-expert key (consultant tier: after event checkout, before the consultee).
  let planSalesLock: ApprovalLock | null = null;
  // A dual-role seat buyer's own slot atoms (event → consultee → slot batch).
  let buyerSeatGrant: SlotBatchGrant | null = null;
  // TYPE-1: Properly typed payment response instead of any
  let paymentResponse: { id: string; client_secret: string | null } | null =
    null;

  const appointmentType: Exclude<CheckoutInput["appointmentType"], "TRIAL"> =
    requestedType;

  const orgFunding = await resolveOrgFunding(
    validatedData,
    userId,
    appointmentType,
  );
  validatedData = orgFunding.validatedData;
  const {
    organizationId,
    programAssignmentId,
    fundingProgramId,
    callerMembershipId,
    referralCreditsDropped,
  } = orgFunding;
  let { billingAccountId, fundingSource, creditEffectiveLimit } = orgFunding;

  // The rail cannot change under the lock (revalidateInsideLock refuses), so this gate holds.
  if (fundingSource && fundingSource !== "PERSONAL") {
    assertOrgBillingAvailable(currentGstRegime());
  }

  try {
    // STEP 1: Calculate amount and fetch plan data (OUTSIDE LOCK - just pricing)
    const priced = await calculateAmountAndValidate(
      validatedData,
      userId,
      buyerCountry,
      // #1465-triage — resolved and membership-verified above; the slot gate
      // needs it to scope the self-hold exclusion to a resumable hold.
      organizationId,
      {
        viaToken: attribution.viaToken ?? null,
        orgFunded: fundingSource !== null && fundingSource !== "PERSONAL",
      },
    );
    const {
      amount,
      originalAmount,
      taxAmount,
      currency,
      creditsApplied,
      subscriptionSchedulingPeriod,
    } = priced;

    // A buyer-paid domestic supply gets a consumer tax invoice, which must carry
    // the buyer's state; org rails, exports and a free order with no credit get none.
    if (
      buyerCountry === "IN" &&
      (!fundingSource || fundingSource === "PERSONAL") &&
      hasBilledSupply(amount, creditsApplied)
    ) {
      consumerBuyerStateSchema.parse(validatedData);
    }

    // INVOICE fundingSource: fast-fail on the credit limit before any lock is
    // taken. #1744 row 4 — the booking itself counts: `exposure >= limit` let
    // one booking of any size through at ₹1 under the limit, so the predicate
    // is `exposure + this booking > limit` here and inside the tx alike.
    if (
      fundingSource === "INVOICE" &&
      creditEffectiveLimit !== null &&
      organizationId
    ) {
      const exposure = await readInvoiceExposurePaise(prisma, organizationId);
      assertWithinInvoiceCreditLimit(exposure, amount, creditEffectiveLimit);
    }

    const displayCurrencyAtCheckout =
      validatedData.displayCurrency?.toUpperCase() || currency;

    // Snapshot the displayed exchange rate for auditability.
    let exchangeRateAtCheckout: number | null = null;
    if (displayCurrencyAtCheckout !== "INR") {
      try {
        const rates = await getExchangeRates();
        exchangeRateAtCheckout = rates[displayCurrencyAtCheckout] ?? null;
      } catch {
        // Non-critical — don't block checkout if rate fetch fails
      }
    }

    // Get plan data for consultant ID (needed for lock acquisition)
    const planData = await getPlanDataForLock(validatedData);

    // #1771 row 1 — before the slot lock, so a slow Customer API holds nothing; a
    // failure or timeout yields undefined (no saved-card offer), never a failed checkout.
    const savedCardCustomer =
      amount > 0 && (!fundingSource || fundingSource === "PERSONAL")
        ? await savedCardCustomerId(
            userId,
            validatedData.paymentGateway,
            isMockPayment,
          )
        : undefined;

    // STEP 2: ACQUIRE DISTRIBUTED LOCK (prevents race conditions)
    // #898 follow-up — also serialize on the consultee so the SAME person can't
    // book two DIFFERENT consultants at overlapping times via concurrent direct
    // checkout. The GiST overlap guard is consultant-keyed, so the consultee-slot
    // conflict in revalidateInsideLock below is otherwise a check-then-write
    // (TOCTOU) window. Global lock order (a total order ⇒ deadlock-free):
    // event/consultant → consultee → slot. So for a slot-based checkout
    // (consultation) the consultee lock is taken BEFORE the slot lock; for an
    // event-based checkout it is taken AFTER the event lock.
    const isSlotBasedCheckout = !!validatedData.startsAt;
    const planSalesProfileId =
      appointmentType === "SUBSCRIPTION"
        ? planData.consultantProfile?.id
        : undefined;
    // One deadline for every lock tier below: a wait on one is not available to the next.
    const lockBudget = requestLockBudget();
    if (isSlotBasedCheckout) {
      if (planSalesProfileId) {
        planSalesLock = await lockExpertPlanSales(
          planSalesProfileId,
          lockBudget,
        );
      }
      consulteeLock = await lockConsulteeBooking(userId, undefined, lockBudget);
    }
    const buyerProfile = isSlotBasedCheckout
      ? await prisma.consultantProfile.findUnique({
          where: { userId },
          select: { id: true },
        })
      : null;
    lock = await acquireCheckoutLock(
      validatedData,
      planData,
      buyerProfile?.id ?? null,
      lockBudget,
    );
    lockType = validatedData.startsAt ? "slot-based" : "event-based";
    if (!isSlotBasedCheckout) {
      if (planSalesProfileId) {
        planSalesLock = await lockExpertPlanSales(
          planSalesProfileId,
          lockBudget,
        );
      }
      consulteeLock = await lockConsulteeBooking(userId, undefined, lockBudget);
      if (
        (appointmentType === "WEBINAR" || appointmentType === "CLASS") &&
        validatedData.eventId
      ) {
        buyerSeatGrant = await lockBuyerSeatAtoms(
          userId,
          appointmentType,
          validatedData.eventId,
          lockBudget,
        );
      }
    }

    console.log(
      JSON.stringify({
        event: "checkout_lock_acquired",
        lockType,
        appointmentType: validatedData.appointmentType,
        timestamp: new Date().toISOString(),
      }),
    );

    // STEP 3: RE-VALIDATE INSIDE LOCK (critical for preventing TOCTOU race conditions)
    const freshOrgFunding = await revalidateInsideLock(
      validatedData,
      userId,
      fundingProgramId,
      organizationId && callerMembershipId
        ? {
            organizationId,
            callerMembershipId,
            programAssignmentId,
            appointmentType,
            billingAccountId,
          }
        : null,
    );
    // Re-bind the rail from the locked read. This is the only place
    // fundingSource becomes authoritative, and it sits above every derivation
    // rather than inside any of them — a rail that moved mid-checkout is read
    // once, here, instead of being re-asked at each use.
    if (freshOrgFunding) {
      if (freshOrgFunding.fundingSource !== fundingSource) {
        throw Object.assign(
          new Error(
            "This organization's funding source changed while this booking was in progress. Please refresh and try again.",
          ),
          { httpStatus: 403, code: "ORG_CANNOT_SPONSOR" },
        );
      }
      fundingSource = freshOrgFunding.fundingSource;
      billingAccountId = freshOrgFunding.billingAccountId;
      creditEffectiveLimit = freshOrgFunding.creditEffectiveLimit;
    }

    console.log(
      JSON.stringify({
        event: "checkout_revalidation_passed",
        appointmentType: validatedData.appointmentType,
        timestamp: new Date().toISOString(),
      }),
    );

    // Enterprise funding derived from BillingAccount.fundingSource (as
    // RE-READ under the lock above) + ProgramAssignment. These booleans gate
    // the "skip the gateway entirely" path — org-funded bookings never go
    // through Stripe/Razorpay at checkout time — and they also decide the
    // PaymentLeg source, the wallet debit and whose cancellation ladder binds,
    // all of which are computed further down inside the booking transaction.
    //
    // The `!!programAssignmentId` conjunct is the fail-closed half, and it is
    // why a mid-flight rail change is safe in the direction it is: a fresh rail
    // of WALLET/INVOICE/LICENSE on a booking resolved under PERSONAL carries no
    // assignment (the pre-lock gate only resolves one for a non-PERSONAL rail),
    // so the booking is not treated as sponsored and the buyer is charged
    // rather than the org being charged for an entitlement nobody verified.
    const isOrgWalletPayment =
      fundingSource === "WALLET" && !!programAssignmentId;
    const isOrgInvoicedPayment =
      fundingSource === "INVOICE" && !!programAssignmentId;
    const isOrgLicensedPayment =
      fundingSource === "LICENSE" && !!programAssignmentId;
    const isOrgSponsoredPayment =
      isOrgWalletPayment || isOrgInvoicedPayment || isOrgLicensedPayment;

    const isZeroAmountPayment = isZeroAmountOrder(
      amount,
      isOrgSponsoredPayment,
    );

    // STEP 4: Create payment intent (INSIDE LOCK)

    // Rec C — adopt an open fresh PENDING order for this user+plan(+org)
    // BEFORE minting anything at the gateway. Runs under the checkout lock
    // (see findReusablePendingOrderPayment for the race-safety argument), so
    // a remount/new tab converges on the first attempt's order instead of
    // charging in parallel. Mock/zero-amount/org-sponsored flows are never
    // PENDING, so the lookup can only ever match a real gateway hold.
    //
    // #1220-triage — candidates are additionally gated on the slot window
    // (a different appointment time must never resume) and on priced-input
    // parity (amount must equal THIS request's computation). Rejections are
    // superseded to EXPIRED so they can neither be resumed later nor re-minted
    // into a parallel charge by a third tab.
    const openOrderTarget = openOrderTargetOf(
      validatedData,
      userId,
      organizationId,
      subscriptionSchedulingPeriod,
    );
    const { reusable: reusableOrder, supersede: supersededOrders } =
      openOrderTarget
        ? await findReusablePendingOrderPayment(prisma, {
            ...openOrderTarget,
            expectedAmountPaise: amount,
            expectedDiscountCodeId: priced.discountCodeId,
          })
        : { reusable: null, supersede: [] };
    if (supersededOrders.length > 0) {
      // #1463 — expiring the payment is only half of it; the hold it minted has
      // to come off the calendar in the same transaction or this buyer's next
      // attempt walls itself out again. See releaseSupersededHolds.
      await releaseSupersededHolds({
        paymentIds: supersededOrders.map((s) => s.id),
        userId,
      });
      console.log(
        JSON.stringify({
          event: "checkout_open_order_superseded",
          appointmentType,
          count: supersededOrders.length,
          reason: supersededOrders[0].reason,
          timestamp: new Date().toISOString(),
        }),
      );
    }
    if (reusableOrder) {
      console.log(
        JSON.stringify({
          event: "checkout_open_order_reused",
          appointmentType,
          orderId: reusableOrder.paymentIntent,
          // #1220-triage — payment row id, not raw userId (no PII pairing in logs).
          paymentRowId: reusableOrder.id,
          timestamp: new Date().toISOString(),
        }),
      );
      // Same shape as replayByIdempotencyKey's PENDING branch so clients
      // handle both resume paths identically.
      return {
        success: true,
        reused: true,
        orderId: reusableOrder.paymentIntent,
        // The row the buyer's "Cancel checkout" releases.
        paymentId: reusableOrder.id,
        paymentIntent: {
          id: reusableOrder.paymentIntent,
          client_secret: null,
        },
        amount: Number(reusableOrder.amount),
        currency: reusableOrder.currency,
        isMockPayment: reusableOrder.isMockPayment,
        // #1437 — PENDING reuse is always a real gateway hold (mock/zero/
        // org-sponsored payments never land in PENDING, see the comment
        // above findReusablePendingOrderPayment), so the page must open it.
        skipPayment: reusableOrder.isMockPayment,
        holdExpiresAt: reusableOrder.expiresAt
          ? (appointmentType === "WEBINAR" || appointmentType === "CLASS"
              ? seatGatewayDeadline(reusableOrder.expiresAt)
              : reusableOrder.expiresAt
            ).toISOString()
          : null,
        message: "Resuming your in-progress checkout.",
      };
    }

    // #832 — one checked renewal at the long-latency boundary (gateway call
    // + tentative-booking tx still ahead). A false return means the lock
    // already expired and another buyer may hold it; proceeding is exactly
    // the double-booking hazard the lock exists to prevent. A timer-based
    // heartbeat is deliberately avoided: serverless freeze makes intervals
    // unreliable, and the message must contain "already in progress" so
    // classifyError maps it to LOCK_CONTENTION → 409.
    // #1319 (R8) — one renewal here did not cover the Serializable retry loop
    // below: four 25 s attempts outlive a 60 s CONSULTATION grant, and the
    // lock silently lapsed mid-payment. Renew at the top of EVERY attempt
    // with a grant sized to one attempt plus slack, so elapsed time stops
    // mattering; only per-attempt duration does. Ownership lost → abort the
    // attempt (not a P2034, so the retry helper rethrows immediately).
    const checkoutTxTimeoutMs = 25_000;
    const perAttemptTtl = Math.max(
      CHECKOUT_LOCK_TTL_MS[validatedData.appointmentType] ?? 60_000,
      checkoutTxTimeoutMs + 10_000,
    );
    // Each held lock renews on its own: a renewal-only plan checkout has no primary lock.
    const renewOrAbort = async (ttl: number): Promise<void> => {
      const renewed =
        !lock ||
        (Array.isArray(lock)
          ? await extendSlotInterval(lock, ttl)
          : await extendLock(lock, ttl));
      if (!renewed) {
        throw new Error(
          "Checkout took too long and its hold expired — another checkout for this slot may be already in progress. Please try again.",
        );
      }
      if (consulteeLock) {
        const consulteeRenewed = await extendLock(consulteeLock, ttl);
        if (consulteeRenewed === false) {
          throw new Error(
            "Checkout took too long and its hold expired — another checkout for this slot may be already in progress. Please try again.",
          );
        }
      }
      if (planSalesLock && !(await extendLock(planSalesLock, ttl))) {
        throw new Error(
          "Checkout took too long and its hold expired — another checkout for this slot may be already in progress. Please try again.",
        );
      }
      if (buyerSeatGrant && !(await extendSlotInterval(buyerSeatGrant, ttl))) {
        throw new Error(
          "Checkout took too long and its hold expired — another checkout for this slot may be already in progress. Please try again.",
        );
      }
    };
    await renewOrAbort(perAttemptTtl);

    // A full expert is refused before any gateway order exists; the commit
    // re-checks under the same lock. No transaction is open here.
    if (appointmentType === "SUBSCRIPTION") {
      const purchase = await resolveSubscriptionPurchase(
        prisma,
        validatedData,
        priced.consulteeProfileId,
        subscriptionSchedulingPeriod,
      );
      await assertSubscriptionDemandRoom(
        prisma,
        purchase,
        priced.consulteeProfileId,
      );
    }

    // #1861 L1 — one deadline for the gateway's capture window and the
    // PENDING row, so a Serializable retry cannot push the row past the order.
    const isSeatCheckout =
      validatedData.appointmentType === "WEBINAR" ||
      validatedData.appointmentType === "CLASS";
    const holdExpiresAt = new Date(
      Date.now() +
        (isSeatCheckout ? SEAT_CHECKOUT_HOLD_MS : DIRECT_CHECKOUT_HOLD_MS),
    );
    // A seat's gateway window ends a grace before its hold, so a capture the
    // gateway accepted late still lands on a seat that counts.
    const gatewayExpiresAt = isSeatCheckout
      ? seatGatewayDeadline(holdExpiresAt)
      : holdExpiresAt;
    // A gateway seat is committed with a pre-mint intent under the event key;
    // its order is minted after the key is released (see seat-pre-mint).
    const preMintSeat =
      isSeatCheckout &&
      !isOrgSponsoredPayment &&
      !isZeroAmountPayment &&
      !isMockPayment;
    const mintGatewayOrder = async () => {
      const { createPaymentIntent } = await import("../index");
      return createPaymentIntent({
        amount,
        currency,
        metadata: buildPaymentMetadata(validatedData, userId, {
          organizationId,
          fundingSource,
        }),
        paymentGateway: validatedData.paymentGateway,
        isMockPayment,
        customerId: savedCardCustomer,
        holdExpiresAt: gatewayExpiresAt,
      });
    };

    // Enterprise org funding skips the gateway entirely.
    if (isOrgSponsoredPayment) {
      const prefix = isOrgWalletPayment
        ? "org_wallet"
        : isOrgLicensedPayment
          ? "org_license"
          : "org_invoice";
      const syntheticId = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      paymentResponse = { id: syntheticId, client_secret: null };
    } else if (isZeroAmountPayment) {
      const freePaymentId = `free_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      paymentResponse = { id: freePaymentId, client_secret: null };
      console.log(
        JSON.stringify({
          event: "zero_amount_payment_detected",
          creditsApplied,
          originalAmount,
          userId,
          timestamp: new Date().toISOString(),
        }),
      );
    } else if (preMintSeat) {
      paymentResponse = newSeatPreMintIntent();
    } else {
      try {
        paymentResponse = await mintGatewayOrder();
      } catch (paymentError) {
        console.error("Payment intent creation failed:", paymentError);
        reportSentryError(paymentError, { subsystem: "payments" });
        // Typed gateway errors keep their code for the route's classifier.
        if (paymentError instanceof PaymentError) throw paymentError;
        throw new Error(
          "Failed to create payment intent. Please try again later.",
          { cause: paymentError },
        );
      }
    }

    // Every rail above sets an order or throws; the booking tx reads this narrowed value.
    if (!paymentResponse) {
      throw new PaymentError(
        "Failed to create payment intent. Please try again later.",
        "PAYMENT_INTENT_MISSING",
        validatedData.paymentGateway,
      );
    }
    const mintedOrder = paymentResponse;

    // STEP 5: Create tentative appointment + payment record (INSIDE LOCK)
    // This prevents race conditions by making validation see tentative bookings
    try {
      // #1093 tail — the ONLY Serializable site that wasn't retried: a P2034
      // under hot-webinar contention surfaced as a generic failure instead of
      // being retried into the sibling's committed state.
      //
      // #1435 — so the body no longer touches the OUTER prisma client at all.
      // Every org-programme bell is CAPTURED inside the transaction and rung
      // once it has settled. The two success-path bells travel out on the
      // transaction's return value, which by construction is the committing
      // attempt's, so a P2034 retry cannot ring them twice; the cap-exhausted
      // bell cannot (it throws), so it rides out on this holder instead.
      const exhaustedBell: { programAssignmentId: string | null } = {
        programAssignmentId: null,
      };

      // #1513 review — provision the platform policy row HERE, on the global
      // client, not from inside the transaction below. The provisioner recovers
      // from a P2002 by re-reading the winner's row, and inside a Serializable
      // transaction a P2002 aborts the transaction, so that re-read would fail
      // and take the sale with it. On the global client every statement is its
      // own autocommit unit, so the loser of the race really does get to re-read.
      // It must also stay OUTSIDE any `$transaction` callback: PG_POOL_MAX=1
      // means a global-client query issued while a transaction holds the single
      // connection deadlocks (#1435, see lib/prisma.ts).
      await ensurePlatformCancellationPolicy(prisma);

      // A free seat's booked email renders here, on the global client, before the Serializable commit opens.
      const seatType = validatedData.appointmentType;
      const preparedSeatNotice =
        isZeroAmountPayment &&
        validatedData.eventId &&
        (seatType === "WEBINAR" || seatType === "CLASS")
          ? await prepareFreeSeatNotice({
              appointmentType: seatType,
              eventId: validatedData.eventId,
              userId,
            })
          : null;

      const result = await commitCheckout({
        validatedData,
        userId,
        isMockPayment,
        mintedOrder,
        holdExpiresAt,
        renewOrAbort,
        hostTimeEntries: [
          ...(Array.isArray(lock) ? slotGrantEntries(lock) : []),
          ...(buyerSeatGrant ? slotGrantEntries(buyerSeatGrant) : []),
        ],
        perAttemptTtl,
        checkoutTxTimeoutMs,
        organizationId,
        billingAccountId,
        fundingSource,
        programAssignmentId,
        callerMembershipId,
        creditEffectiveLimit,
        isOrgWalletPayment,
        isOrgInvoicedPayment,
        isOrgLicensedPayment,
        isOrgSponsoredPayment,
        isZeroAmountPayment,
        displayCurrencyAtCheckout,
        exchangeRateAtCheckout,
        exhaustedBell,
        priced,
        preparedSeatNotice,
      }).catch(async (err) => {
        // #1435 — post-rollback delivery for the one bell whose news IS the
        // refusal. Nothing else below is reached when the transaction fails.
        if (exhaustedBell.programAssignmentId) {
          await dispatchProgramBell(exhaustedBell.programAssignmentId, {
            kind: "EXHAUSTED",
          });
        }
        throw err;
      });

      // A rejoined free seat stands on its earlier payment, so the answer names that payment's intent.
      if (result.reusedPaymentIntent) {
        paymentResponse = {
          id: result.reusedPaymentIntent,
          client_secret: null,
        };
      }

      if (preMintSeat) {
        // The seat is committed: free the event and buyer keys for the next
        // checkout before the gateway round trip, then fill in the order.
        if (lock) await releaseCheckoutLock(lock, lockType);
        lock = null;
        if (consulteeLock) await unlockConsulteeBooking(consulteeLock);
        consulteeLock = null;
        if (buyerSeatGrant) await unlockSlotInterval(buyerSeatGrant);
        buyerSeatGrant = null;
        paymentResponse = await mintPreMintedSeatOrder({
          preMintIntent: mintedOrder.id,
          userId,
          gateway: validatedData.paymentGateway,
          mint: mintGatewayOrder,
        }).catch((mintError: unknown) => {
          throw new SeatOrderMintFailure(mintError);
        });
      }

      // #1435 — post-COMMIT delivery for the bells that describe a booking that
      // actually happened. See dispatchProgramBell for why neither lookup can
      // run inside the transaction.
      if (result.capNearBell) {
        await dispatchProgramBell(result.capNearBell.programAssignmentId, {
          kind: "CAP_NEAR",
          engagementsUsed: result.capNearBell.engagementsUsed,
          cap: result.capNearBell.cap,
          usedPct: result.capNearBell.usedPct,
        });
      }
      if (result.overageBell) {
        await notifyOverageDueAfterCommit(result.overageBell);
      }

      const logMessage = isZeroAmountPayment
        ? `🎁 Zero-amount payment (credits covered full cost) + appointment created: ${paymentResponse.id}`
        : isMockPayment
          ? `🎭 Mock payment + tentative appointment created: ${paymentResponse.id}`
          : `💳 Payment intent + tentative appointment created: ${paymentResponse.id} - Waiting for payment confirmation`;

      console.log(logMessage);
      console.log(
        JSON.stringify({
          event: "checkout_appointment_created",
          appointmentType: validatedData.appointmentType,
          appointmentId: result.appointmentId,
          isMockPayment,
          timestamp: new Date().toISOString(),
        }),
      );

      // Mock/zero-amount/org-sponsored payments never see a capture webhook,
      // so their post-commit follow-ups run here.
      if (isMockPayment || isZeroAmountPayment || isOrgSponsoredPayment) {
        await flushNotificationsAfter(
          result.creditNotices,
          "referral.credits_applied",
        );

        // #1365 — these payments never see a capture webhook, so the tax
        // invoice has to be minted here too. Org-sponsored payments no-op
        // inside the minter by design; they are invoiced on the org series.
        // A free order with no credit has no supply, so its reads are skipped.
        if (hasBilledSupply(amount, creditsApplied)) {
          await mintConsumerInvoiceBestEffort({
            paymentIntent: mintedOrder.id,
          });
        }

        // A free seat's booked notice was staged in the commit; it is sent here.
        if (result.seatNotice) {
          await flushNotificationsAfter(
            result.seatNotice,
            "checkout.free-seat-booked",
          );
        }

        const appointmentIdForChannels = result.appointmentId;
        if (appointmentIdForChannels) {
          await scheduleAfter(async () => {
            try {
              const { ensureChannelsForAppointment } =
                await import("@/lib/payments/webhooks/ensure-channels");
              await ensureChannelsForAppointment(appointmentIdForChannels);
            } catch (channelErr) {
              console.error("[checkout.ensure-channels] failed:", channelErr);
            }
          }, "checkout.ensure-channels");
        }
      }

      let message =
        "Payment intent created. Complete payment to book appointment.";
      if (isZeroAmountPayment) {
        message = "Nothing to pay — your booking is confirmed.";
      } else if (isMockPayment) {
        message = "Mock payment completed and appointment created successfully";
      } else if (isOrgSponsoredPayment) {
        message =
          "Payment completed via organization funding. Appointment booked successfully.";
        if (referralCreditsDropped) {
          message += ` ${REFERRAL_CREDITS_DROPPED_NOTICE}`;
        }
      }

      return {
        success: true,
        paymentIntent: paymentResponse,
        // The row the buyer's "Cancel checkout" releases.
        paymentId: result.paymentId,
        message,
        referralCreditsDropped,
        amount,
        currency,
        isMockPayment: isMockPayment || isZeroAmountPayment,
        isZeroAmountPayment,
        // #1437 — WALLET/INVOICE/LICENSE org funding also confirms
        // synchronously with a synthetic org_* id and no gateway order;
        // isMockPayment/isZeroAmountPayment don't cover it, so the client
        // was opening Razorpay on an id the gateway had never heard of.
        // Matches checkout-replay.ts's SUCCEEDED-branch field name.
        skipPayment:
          isMockPayment || isZeroAmountPayment || isOrgSponsoredPayment,
        // #1861 L1 — Checkout's `timeout` is sized to this.
        holdExpiresAt: result.holdExpiresAt
          ? (isSeatCheckout
              ? seatGatewayDeadline(result.holdExpiresAt)
              : result.holdExpiresAt
            ).toISOString()
          : null,
      };
    } catch (caught) {
      // The seat was committed and is already released: a mint failure is a
      // gateway answer, never a failed booking write.
      if (caught instanceof SeatOrderMintFailure) {
        const { mintError } = caught;
        if (mintError instanceof SeatHoldLapsedError) throw mintError;
        console.error("Payment intent creation failed:", mintError);
        reportSentryError(mintError, { subsystem: "payments" });
        if (mintError instanceof PaymentError) throw mintError;
        throw new Error(
          "Failed to create payment intent. Please try again later.",
          { cause: mintError },
        );
      }
      const dbError = asSeatPaymentConflict(asWelcomeDiscountConflict(caught));
      // A conflict Postgres aborted or a transaction Prisma expired booked
      // nothing; it passes through typed for the route to answer and report.
      const rolledBack = isRolledBackTransaction(dbError);
      console.error("Failed to create payment record:", dbError);
      // Classification for Sentry tagging ONLY — deliberately NOT the same
      // list `preservedMessages` below uses for the rethrow decision, so
      // adding a tagging-only pattern here can never change which message
      // reaches the caller.
      const modelledOutcomePatterns = [
        "already registered",
        "already enrolled",
        "full",
        "cancelled",
        "ended",
        "not been scheduled",
        "already have a pending or active subscription",
        "already have a session booked", // consultee double-book (FAMILIARISE_WEB-P)
        "overlapping dates",
        "insufficient credits",
        "session cap", // ProgramAssignmentLimitError-derived message, above
        // #1132 — slot contention is a modelled outcome, not a fault. These
        // were added to `preservedMessages` below so the user gets a real
        // message, but tagging is a separate list by design (see comment
        // above), so without them here every lost slot raced to Sentry as
        // `expected: false` and normal contention looked like a payment
        // incident.
        "already booked",
        "no longer available",
      ];
      // Typed errors and stable codes first — a substring is a last resort,
      // not the mechanism. recordOverageAtCheckout stamps
      // code: "PROGRAM_CAP_EXHAUSTED" on its 402, which this used to miss
      // entirely and report as a fault.
      const dbErrorCode = (dbError as { code?: unknown } | null)?.code;
      // #1583 C-P1-04 — the loser of two same-key checkouts; the route
      // replays the winner, so this is a modelled race and must not be rewrapped.
      const isIdempotencyKeyCollision = isUniqueViolationOn(
        dbError,
        "clientIdempotencyKey",
      );
      const isModelledOutcome =
        isIdempotencyKeyCollision ||
        dbError instanceof SlotTakenError ||
        dbError instanceof WalletFrozenError ||
        dbError instanceof ProgramAssignmentLimitError ||
        dbErrorCode === "PROGRAM_CAP_EXHAUSTED" ||
        // #1458 — the per-assignment session cap is the same class of modelled
        // refusal as the per-cycle overage ceiling above. The overage funding
        // codes are deliberately NOT here: they mean a programme was configured
        // in a shape we cannot collect on, which has to keep paging.
        dbErrorCode === "PROGRAM_SESSION_CAP_REACHED" ||
        // #1477 — an org that has spent its wallet down is refusing the
        // booking, not faulting on it. The rethrow below already lets it
        // through on its registered code; tagging is a separate list by
        // design, so without this line the routine refusal kept paging.
        dbErrorCode === "WALLET_INSUFFICIENT_FUNDS" ||
        // #1582 B-P1-01b — the in-tx org/panel/credit refusals and the
        // CREDIT_SHORTFALL race are answers, not faults.
        (isBusinessErrorCode(dbErrorCode) &&
          IN_TX_MODELLED_REFUSAL_CODES.has(dbErrorCode)) ||
        (dbError instanceof Error &&
          modelledOutcomePatterns.some((msg) =>
            // Word-bounded: bare `includes` let "full" match "successful" and
            // "ended" match "unintended", tagging real faults as routine.
            new RegExp(`\\b${msg}\\b`, "i").test(dbError.message),
          ));
      if (!rolledBack) {
        reportSentryError(dbError, {
          subsystem: "payments",
          expected: isModelledOutcome,
        });
      }

      // CRITICAL: Cancel payment intent since DB operation failed
      // (Skip cleanup for zero-amount payments — they have no real gateway intent)
      if (
        paymentResponse &&
        !isZeroAmountPayment &&
        !isPreMintIntent(paymentResponse.id)
      ) {
        try {
          const { cancelPaymentIntent } = await import("../index");
          await cancelPaymentIntent(paymentResponse.id);
        } catch (cancelErr) {
          console.error(
            `Failed to cancel payment intent ${paymentResponse.id}:`,
            cancelErr,
          );
          reportSentryError(cancelErr, {
            subsystem: "payments",
            level: "warning",
          });
        }
      }

      // #1695 — Razorpay cannot void a minted order, so a buyer who completes
      // it after this abort (a CREDIT_SHORTFALL retry, say) captures money
      // with no Payment row to land on, and the webhook re-drives "Payment
      // record not found" forever. An EXPIRED tombstone gives that capture a
      // row: the capture handler claims it and auto-refunds. Best-effort, and
      // never on mock, org-funded or zero-amount intents, which the gateway
      // never sees.
      // A seat's pre-mint intent names no gateway order: nothing to tombstone.
      if (
        paymentResponse &&
        !isPreMintIntent(paymentResponse.id) &&
        !isZeroAmountPayment &&
        !isOrgSponsoredPayment &&
        !isMockPayment &&
        validatedData.paymentGateway === PaymentGateway.RAZORPAY
      ) {
        await tombstoneAbortedGatewayOrder({
          paymentIntent: paymentResponse.id,
          userId,
          amount,
          originalAmount,
          taxAmount,
          gstRegime: priced.gstRegime,
          currency,
          reason: dbError instanceof Error ? dbError.message : String(dbError),
        });
      }

      // #837 — WalletFrozenError carries httpStatus=409 + an actionable reason;
      // don't let it collapse into the generic "Failed to record payment
      // information" below. Rethrow so the route surfaces the 409.
      if (dbError instanceof WalletFrozenError || rolledBack) {
        throw dbError;
      }

      // #1583 C-P1-04 — the route's P2002 replay branch needs the Prisma error
      // itself; wrapped, the loser answered 500 instead of the winner's response.
      if (isIdempotencyKeyCollision) {
        throw dbError;
      }

      // #1458 — an error carrying a registered business code already resolves
      // to its own status and toast in the classifier, so rewriting it to the
      // generic message below is pure loss: PROGRAM_CAP_EXHAUSTED was thrown as
      // a 402 with actionable copy and reached the buyer as a 500
      // "Something Went Wrong". Codes are checked before messages because a
      // code survives a reworded sentence and a substring does not.
      if (dbError instanceof Error && isBusinessErrorCode(dbErrorCode)) {
        throw dbError;
      }

      // Preserve specific error messages (duplicate registration, full capacity, etc.)
      if (dbError instanceof Error) {
        const preservedMessages = [
          "already registered",
          "already enrolled",
          "full",
          "cancelled",
          "ended",
          "not been scheduled",
          "already have a pending or active subscription",
          "already have a session booked", // consultee double-book (FAMILIARISE_WEB-P)
          "overlapping dates",
          "insufficient credits",
          // #1132 — validateSlotAvailability throws these from INSIDE the
          // transaction, so without them here a genuine slot conflict was
          // rewritten to "Failed to record payment information" → UNKNOWN →
          // "Something Went Wrong", and the user had no idea to pick another
          // slot. ADR 16's clean-error claim only held for the pre-transaction
          // check.
          "already booked",
          "no longer available",
        ];
        if (
          preservedMessages.some((msg) =>
            dbError.message.toLowerCase().includes(msg),
          )
        ) {
          throw dbError;
        }
      }

      // A read timeout stays wrapped: it may have cut off a COMMIT that landed,
      // so the route must not answer it as uncharged.
      throw new Error(
        "Failed to record payment information. Please try again.",
        { cause: dbError },
      );
    }
  } catch (error) {
    // Outermost boundary — also catches validation errors from
    // calculateAmountAndValidate/acquireCheckoutLock/revalidateInsideLock
    // (steps 1-3, above the STEP-5 try/catch that already reports) which
    // otherwise reach here uncaptured. Lock contention is a modelled,
    // expected race between two concurrent checkouts; consultee double-book
    // from revalidateInsideLock is the same class of rejection (FAMILIARISE_WEB-P).
    // Anything else here is unclassified and reported as a fault by default.
    const isLockContention =
      error instanceof Error &&
      (error.message.includes("currently checking out") ||
        error.message.includes("currently being booked"));
    // Tag-only: the explicit lock-expiry throw above ("...already in
    // progress...") is the same modelled race, but is NOT folded into
    // isLockContention — that variable also picks the rethrow message below,
    // and this message already classifies correctly downstream (LOCK_CONTENTION
    // via payment-error-classification.ts), so changing it would misroute it
    // to AVAILABILITY instead.
    const isModeledLockRace =
      isLockContention ||
      (error instanceof Error && error.message.includes("already in progress"));
    const isConsulteeDoubleBook =
      error instanceof Error &&
      error.message.toLowerCase().includes("already have a session booked");
    // #1477 — the inner catch rethrows anything carrying a registered business
    // code, so every one of those refusals arrives here too and was re-reported
    // as a fault, undoing the `expected: true` it had just been given. Asking
    // the classifier the same question it will answer for the response keeps
    // the two verdicts from disagreeing.
    const isBusinessRefusal = isBusinessErrorCode(
      (error as { code?: unknown } | null)?.code,
    );
    // #1583 C-P1-04 — the same-key collision the inner catch let through.
    const isKeyCollision = isUniqueViolationOn(error, "clientIdempotencyKey");
    // A bare rollback or database timeout is answered and reported once, by the route.
    if (!isRolledBackTransaction(error) && !isQueryReadTimeout(error)) {
      reportSentryError(error, {
        subsystem: "payments",
        expected:
          isModeledLockRace ||
          isConsulteeDoubleBook ||
          isBusinessRefusal ||
          isKeyCollision ||
          error instanceof SlotTakenError,
      });
    }
    // Typed busy errors keep their 409 and retryAfter for the route and the client's retry.
    const isTypedBusy =
      error instanceof EventCheckoutBusyError ||
      error instanceof ConsulteeBookingBusyError;
    if (isLockContention && !isTypedBusy) {
      throw new Error(
        "Another user is currently booking this slot. Please wait a few seconds and try again.",
      );
    }
    throw error;
  } finally {
    // ALWAYS RELEASE LOCKS (even on error). Release order doesn't affect
    // deadlock-freedom (only acquisition order does), so both are freed here.
    if (lock) {
      await releaseCheckoutLock(lock, lockType);
    }
    if (consulteeLock) {
      await unlockConsulteeBooking(consulteeLock);
    }
    if (planSalesLock) {
      await unlockRequestCap(planSalesLock);
    }
    if (buyerSeatGrant) {
      await unlockSlotInterval(buyerSeatGrant);
    }
  }
}
