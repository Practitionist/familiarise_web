/**
 * #778 elegance — checkout-time overage recording, extracted out of the (huge)
 * checkout function so the overage flow reads as one unit. The chargeStatus
 * state machine (`transitionOverage`) lives in `overage-transitions.ts` (kept
 * dependency-light); this module carries the heavier graph (computeOverage +
 * the Novu member-due notification).
 */
import { reportSentryError } from "@/lib/observability/report";
import prisma from "@/lib/prisma";
import {
  PaymentStatus,
  type Currency,
  type PaymentGateway,
  type ProgramType,
} from "@prisma/client";
import {
  computeOverageForBooking,
  surchargeTaxPaise,
} from "@/lib/payments/billing/overage";
import { walletCredit, walletDebit } from "@/lib/api/organizations/wallet";
import { orgBuyerCountry } from "@/lib/compliance/gst";
import { postLedgerTxn } from "@/lib/payments/ledger/post";
import { notifyOrgProgramOverageDue } from "@/lib/novu/org-workflows";
import { sendOrgOverageDueEmail } from "@/lib/email";
import { getAppUrl } from "@/lib/url";
import { PaymentError } from "@/lib/payments/core/types";
import type { Tx } from "@/lib/prisma";
import { sumPaise } from "@/lib/payments/utils/money";

export interface RecordOverageInput {
  tx: Tx;
  programAssignmentId: string;
  /** Output of recordBookingUtilization for this booking (already metered). */
  utilization: {
    programType: ProgramType;
    engagementsConsumedDelta: number;
    engagementsUsedAfter: number;
    consumedPaiseAfter: number;
    creditBudgetPaise: number | null;
  };
  bookingPricePaise: number;
  currency: Currency;
  paymentId: string;
  userId: string;
  organizationId: string | null;
  paymentGateway: PaymentGateway;
  /**
   * True when metering a lazily allocated subscription session after
   * initial signup, where the parent orgPayment may already be invoiced or
   * have exhausted its un-carved INVOICE_ACCRUAL balance.
   */
  isLazyAllocation?: boolean;
}

/** The member-due bell, deferred until the caller's transaction has committed. */
export interface PendingOverageNotification {
  userId: string;
  programAssignmentId: string;
  marginalPaise: number;
  currency: Currency;
  overageEventId: string;
}

/** GST on a CHARGE_ORG surcharge: the org is the payer, so its own place of supply decides. */
async function orgSurchargeTaxPaise(
  tx: Tx,
  organizationId: string | null,
  surchargePaise: number,
): Promise<number> {
  if (surchargePaise <= 0) return 0;
  const org = organizationId
    ? await tx.organization.findUnique({
        where: { id: organizationId },
        select: { dataResidencyRegion: true },
      })
    : null;
  return surchargeTaxPaise(surchargePaise, org ? orgBuyerCountry(org) : "IN");
}

/**
 * Record one over-cap booking. Assumes the caller already metered the booking
 * and saw `wasOverage = true` (BLOCK behaviour throws inside the metering
 * helper, never here). Resolves the configured behaviour through the pure
 * `computeOverage`, enforces the per-cycle circuit breaker, and persists the
 * OverageEvent (+ the CHARGE_MEMBER side-Payment or the CHARGE_ORG accrual leg).
 *
 * Throws `PROGRAM_CAP_EXHAUSTED` (httpStatus 402) when the circuit breaker
 * vetoes — same shape as the BLOCK path so the dashboard can explain the
 * cycle ceiling vs the per-member allocation.
 *
 * Returns the member-due bell to ring, or null when there is nothing to tell
 * anyone. The caller rings it AFTER its transaction commits — see
 * `notifyOverageDueAfterCommit`.
 */
export async function recordOverageAtCheckout(
  input: RecordOverageInput,
): Promise<PendingOverageNotification | null> {
  const {
    tx,
    programAssignmentId,
    utilization,
    bookingPricePaise: amount,
    paymentId,
  } = input;

  const isCredit = utilization.programType === "CREDIT_POOL";
  const programRow = await tx.program.findFirst({
    where: { assignments: { some: { id: programAssignmentId } } },
    select: {
      licensedSeatConfig: {
        select: {
          overageBehavior: true,
          priceCapPerEngagementPaise: true,
          coveredEngagementsPerCycle: true,
          overageSurchargeBps: true,
          maxOveragePerCyclePaise: true,
        },
      },
      creditPoolConfig: {
        select: {
          overageBehavior: true,
          priceCapPerEngagementPaise: true,
          overageSurchargeBps: true,
          maxOveragePerCyclePaise: true,
        },
      },
    },
  });
  const lsc = programRow?.licensedSeatConfig;
  const cpc = programRow?.creditPoolConfig;

  // Cycle overage-so-far. A ProgramAssignment is per-cycle, so every
  // OverageEvent on this assignmentId is already cycle-scoped. No settledAt
  // filter (a mid-cycle invoice run stamps settledAt but must not reset the
  // breaker); excludes REVERSED/BLOCKED/FAILED so a refunded/never-collected
  // overage frees the ceiling again. Tax-exclusive (base + surcharge), like the cap.
  const currentAssignment =
    typeof tx.programAssignment?.findUnique === "function"
      ? await tx.programAssignment.findUnique({
          where: { id: programAssignmentId },
          select: {
            periodStart: true,
            rolledFromAssignment: {
              select: { id: true, status: true, periodStart: true },
            },
          },
        })
      : null;
  const carriedOverPredecessorId =
    currentAssignment?.rolledFromAssignment &&
    currentAssignment.rolledFromAssignment.status === "CANCELLED" &&
    currentAssignment.rolledFromAssignment.periodStart.getTime() ===
      currentAssignment.periodStart.getTime()
      ? currentAssignment.rolledFromAssignment.id
      : null;
  const cycleAssignmentIds = carriedOverPredecessorId
    ? [programAssignmentId, carriedOverPredecessorId]
    : null;
  const soFarAgg = await tx.overageEvent.aggregate({
    where: {
      programAssignmentId: cycleAssignmentIds
        ? { in: cycleAssignmentIds }
        : programAssignmentId,
      chargeStatus: { notIn: ["REVERSED", "BLOCKED", "FAILED"] },
    },
    _sum: { basePaise: true, surchargePaise: true },
  });
  const cycleOverageSoFarPaise =
    sumPaise(soFarAgg._sum.basePaise) + sumPaise(soFarAgg._sum.surchargePaise);

  // Drive the decision through the shared computeOverageForBooking() mapper.
  // For LICENSED_SEAT the PRE-booking engagement count is needed (the meter
  // already applied this booking's delta); for CREDIT_POOL the PRE-booking
  // consumed paise.
  const engagementsConsumed = Math.max(1, utilization.engagementsConsumedDelta);
  const overage = computeOverageForBooking(
    isCredit
      ? {
          programType: "CREDIT_POOL",
          overageBehavior: cpc?.overageBehavior ?? "BLOCK",
          maxOveragePerCyclePaise: cpc?.maxOveragePerCyclePaise ?? null,
          cycleOverageSoFarPaise,
          overageSurchargeBps: cpc?.overageSurchargeBps ?? null,
          creditBudgetPaise: utilization.creditBudgetPaise,
          consumedPaise: utilization.consumedPaiseAfter - amount,
          priceCapPerEngagementPaise:
            cpc?.priceCapPerEngagementPaise !== null &&
            cpc?.priceCapPerEngagementPaise !== undefined
              ? Number(cpc.priceCapPerEngagementPaise)
              : null,
        }
      : {
          programType: "LICENSED_SEAT",
          overageBehavior: lsc?.overageBehavior ?? "BLOCK",
          maxOveragePerCyclePaise: lsc?.maxOveragePerCyclePaise ?? null,
          cycleOverageSoFarPaise,
          overageSurchargeBps: lsc?.overageSurchargeBps ?? null,
          coveredEngagementsPerCycle: lsc?.coveredEngagementsPerCycle ?? null,
          engagementsUsed:
            utilization.engagementsUsedAfter -
            utilization.engagementsConsumedDelta,
          priceCapPerEngagementPaise: lsc?.priceCapPerEngagementPaise ?? null,
        },
    { bookingPricePaise: amount, engagementsConsumed },
  );
  const { marginalPaise, basePaise, surchargePaise } = overage;

  // Circuit breaker: ceiling exceeded → reject the booking like BLOCK. Distinct
  // code so the dashboard can explain it's the cycle cap, not the allocation.
  if (overage.decision === "BLOCK" && overage.chargeTo === null) {
    const capExhaustedErr = Object.assign(
      new Error(
        "PROGRAM_CAP_EXHAUSTED: This booking would exceed the program's per-cycle overage ceiling. Contact your organization administrator to raise the ceiling or wait for the next cycle.",
      ),
      { httpStatus: 402, code: "PROGRAM_CAP_EXHAUSTED" },
    );
    // Modelled outcome (the circuit breaker working as designed), not a
    // fault — captured for volume/pattern visibility only.
    reportSentryError(capExhaustedErr, {
      subsystem: "payments",
      expected: true,
    });
    throw capExhaustedErr;
  }

  if (marginalPaise <= 0) return null;

  const bu = await tx.bookingUtilization.findUnique({
    where: { paymentId },
    select: { id: true },
  });
  if (!bu) return null;

  const parentPayment = await tx.payment.findUnique({
    where: { id: paymentId },
    select: {
      billableToOrgInvoiceId: true,
      buyerCountry: true,
      consumerStateCode: true,
      isInternational: true,
    },
  });
  const parentInvoiced = !!parentPayment?.billableToOrgInvoiceId;

  if (overage.chargeTo === "MEMBER") {
    return recordMemberOverageCharge(input, {
      bookingUtilizationId: bu.id,
      basePaise,
      surchargePaise,
      parentInvoiced,
      buyerCountry: parentPayment?.buyerCountry ?? "IN",
      consumerStateCode: parentPayment?.consumerStateCode ?? null,
      isInternational: parentPayment?.isInternational ?? false,
    });
  }

  if (overage.chargeTo === "ORG") {
    return recordOrgOverageCharge(input, {
      bookingUtilizationId: bu.id,
      basePaise,
      surchargePaise,
      marginalPaise,
      parentInvoiced,
    });
  }

  // CHARGE_ORG bills through the monthly rollup; nobody is told anything now.
  return null;
}

async function carveParentBaseForMemberOverage(
  tx: Tx,
  paymentId: string,
  basePaise: number,
  parentInvoiced: boolean,
  isLazyAllocation?: boolean,
): Promise<number> {
  if (basePaise <= 0 || parentInvoiced) {
    // When parent payment was already invoiced in a prior cycle, do not mutate
    // the locked parent payment or its legs, and do not re-bill basePaise to
    // the member.
    return 0;
  }

  const parentBase = await tx.paymentLeg.findUnique({
    where: { paymentId_source: { paymentId, source: "INVOICE_ACCRUAL" } },
    select: { amountPaise: true },
  });
  if (parentBase && parentBase.amountPaise >= basePaise) {
    await tx.paymentLeg.update({
      where: {
        paymentId_source: { paymentId, source: "INVOICE_ACCRUAL" },
      },
      data: { amountPaise: { decrement: basePaise } },
    });
    await tx.payment.update({
      where: { id: paymentId },
      data: { amount: { decrement: basePaise } },
    });
    return basePaise;
  }

  if (parentBase && isLazyAllocation) {
    const lazyCarve = Math.min(parentBase.amountPaise, basePaise);
    if (lazyCarve > 0) {
      await tx.paymentLeg.update({
        where: {
          paymentId_source: { paymentId, source: "INVOICE_ACCRUAL" },
        },
        data: { amountPaise: { decrement: lazyCarve } },
      });
      await tx.payment.update({
        where: { id: paymentId },
        data: { amount: { decrement: lazyCarve } },
      });
    }
    return lazyCarve;
  }

  if (!parentBase) {
    const walletLeg = await tx.paymentLeg.findUnique({
      where: { paymentId_source: { paymentId, source: "WALLET" } },
      select: { amountPaise: true },
    });
    if (walletLeg && (walletLeg.amountPaise >= basePaise || isLazyAllocation)) {
      const carved = Math.min(walletLeg.amountPaise, basePaise);
      if (carved > 0) {
        await tx.paymentLeg.update({
          where: { paymentId_source: { paymentId, source: "WALLET" } },
          data: { amountPaise: { decrement: carved } },
        });
        await tx.payment.update({
          where: { id: paymentId },
          data: { amount: { decrement: carved } },
        });
        const parentRow =
          typeof tx.payment?.findUnique === "function"
            ? await tx.payment.findUnique({
                where: { id: paymentId },
                select: { billingAccountId: true },
              })
            : null;
        if (
          parentRow?.billingAccountId &&
          typeof tx.billingAccount?.update === "function"
        ) {
          await walletCredit(tx, {
            billingAccountId: parentRow.billingAccountId,
            amountPaise: carved,
            reason: "REFUND",
            paymentId,
          });
        }
      }
      return carved;
    }

    const licenseLeg = await tx.paymentLeg.findUnique({
      where: { paymentId_source: { paymentId, source: "LICENSE" } },
      select: { amountPaise: true },
    });
    if (licenseLeg) {
      // LICENSE legs carry 0 paise on the booking payment (prepaid at contract
      // level); the member side-payment collects the full over-cap base + surcharge.
      return basePaise;
    }

    const cardLeg = await tx.paymentLeg.findUnique({
      where: { paymentId_source: { paymentId, source: "CARD" } },
      select: { amountPaise: true },
    });
    if (cardLeg) {
      // On a PERSONAL booking the member's card already paid the base price on
      // the parent payment; only any overage surcharge remains to be billed.
      return 0;
    }
  }

  if (isLazyAllocation) {
    return 0;
  }

  const carveErr = new PaymentError(
    "This programme charges members for bookings past its cap, which is not supported on this organisation's funding source. Ask your billing admin to switch the programme to charge the organisation, or to block over-cap bookings.",
    "OVERAGE_CHARGE_MEMBER_UNSUPPORTED",
  );
  reportSentryError(carveErr, {
    subsystem: "payments",
    contexts: {
      overage: {
        paymentId,
        basePaise,
        parentInvoiceAccrualPaise: parentBase ? parentBase.amountPaise : null,
      },
    },
  });
  throw carveErr;
}

async function recordMemberOverageCharge(
  input: RecordOverageInput,
  ctx: {
    bookingUtilizationId: string;
    basePaise: number;
    surchargePaise: number;
    parentInvoiced: boolean;
    buyerCountry: string;
    consumerStateCode: string | null;
    isInternational: boolean;
  },
): Promise<PendingOverageNotification | null> {
  const {
    tx,
    programAssignmentId,
    currency,
    paymentId,
    userId,
    organizationId,
    paymentGateway,
  } = input;

  // Carve the over-cap pass-through (basePaise) out of the org-funded parent
  // FIRST so we know the exact carvedBasePaise to bill the member (preventing
  // double-collection when the parent is already invoiced or partially carved).
  const carvedBasePaise = await carveParentBaseForMemberOverage(
    tx,
    paymentId,
    ctx.basePaise,
    ctx.parentInvoiced,
    input.isLazyAllocation,
  );
  const effectiveMarginalPaise = carvedBasePaise + ctx.surchargePaise;
  if (effectiveMarginalPaise <= 0) {
    // Base already billed to the org (or not carvable) and no surcharge:
    // the member owes nothing, so mint no side-payment and send no notice.
    return null;
  }

  // The member is a B2C buyer: GST on the surcharge by their own place of supply.
  const taxPaise = surchargeTaxPaise(ctx.surchargePaise, ctx.buyerCountry);
  const chargedPaise = effectiveMarginalPaise + taxPaise;

  // Instant member charge. The booking proceeds; create a parent-linked
  // PENDING side-Payment for the effective marginal. The gateway is NOT called
  // inside this Serializable TX — the order is minted lazily when the member
  // opens the resume-checkout surface, and the webhook flips both → CHARGED.
  // `appointmentId: null` avoids the @@unique([userId, appointmentId]) clash.
  const sideCharge = await tx.payment.create({
    data: {
      amount: chargedPaise,
      originalAmount: effectiveMarginalPaise,
      taxAmount: taxPaise,
      // The member's tax invoice places the supply exactly as the booking's.
      buyerCountry: ctx.buyerCountry,
      isInternational: ctx.isInternational,
      consumerStateCode: ctx.consumerStateCode,
      currency,
      paymentMethod: "CARD",
      paymentIntent: `overage:${paymentId}`,
      paymentGateway,
      paymentStatus: PaymentStatus.PENDING,
      isMockPayment: false,
      userId,
      appointmentId: null,
      organizationId,
      parentPaymentId: paymentId,
      clientIdempotencyKey: `overage:${globalThis.crypto.randomUUID()}`,
      // Born with its card leg: the deferred leg-sum trigger checks it at COMMIT.
      legs: { create: { source: "CARD", amountPaise: chargedPaise } },
    },
  });
  const memberOverageEvent = await tx.overageEvent.create({
    data: {
      programAssignmentId,
      bookingUtilizationId: ctx.bookingUtilizationId,
      overageBehavior: "CHARGE_MEMBER",
      basePaise: carvedBasePaise,
      surchargePaise: ctx.surchargePaise,
      // GST-inclusive: what the member is charged, equal to the side-Payment amount.
      marginalPaise: chargedPaise,
      // Mirrors the booking currency (the side-Payment + timeout notify
      // read it back); hardcoding INR mislabels a non-INR booking.
      currency,
      chargeStatus: "PENDING",
      paymentId: sideCharge.id,
    },
  });

  // Hold any PENDING earnings on the parent payment until the member side-payment
  // is captured or fails/times out (released in handleOverageMemberSuccess or
  // restoreOverageBaseCarve).
  if (typeof tx.consultantEarnings?.updateMany === "function") {
    await tx.consultantEarnings.updateMany({
      where: { paymentId, status: "PENDING" },
      data: { status: "HELD", preDisputeStatus: "PENDING" },
    });
  }
  if (typeof tx.organizationEarnings?.updateMany === "function") {
    await tx.organizationEarnings.updateMany({
      where: { paymentId, status: "PENDING" },
      data: { status: "HELD", preDisputeStatus: "PENDING" },
    });
  }

  return {
    userId,
    programAssignmentId,
    marginalPaise: chargedPaise,
    currency,
    overageEventId: memberOverageEvent.id,
  };
}

/**
 * Mint a child `ENTERPRISE_INVOICE_ACCRUAL` Payment carrying a tax-inclusive
 * `OVERAGE_INVOICE_ACCRUAL` leg, born `SUCCEEDED` so the rollup bills it, and
 * post its accrual journal (`Dr ORG_RECEIVABLE / Cr PLATFORM_FEE / Cr GST_PAYABLE`)
 * since no booking journal ever runs for it.
 */
async function mintChildOverageAccrualPayment(
  input: RecordOverageInput,
  accrualPaise: number,
  taxPaise: number,
) {
  const {
    tx,
    programAssignmentId,
    currency,
    paymentId,
    userId,
    organizationId,
    paymentGateway,
  } = input;
  const amount = accrualPaise + taxPaise;
  const child = await tx.payment.create({
    data: {
      amount,
      originalAmount: accrualPaise,
      taxAmount: taxPaise,
      currency,
      paymentMethod: "ENTERPRISE_INVOICE_ACCRUAL",
      paymentIntent: `overage_accrual_${globalThis.crypto.randomUUID()}`,
      paymentGateway,
      paymentStatus: PaymentStatus.SUCCEEDED,
      isMockPayment: false,
      userId,
      appointmentId: null,
      organizationId,
      parentPaymentId: paymentId,
      legs: {
        create: {
          source: "OVERAGE_INVOICE_ACCRUAL",
          amountPaise: amount,
          sourceRef: programAssignmentId,
        },
      },
    },
  });
  if (organizationId && amount > 0) {
    await postLedgerTxn(tx, {
      idempotencyKey: `overage-accrual:${child.id}`,
      kind: "INVOICE_ISSUED",
      paymentId: child.id,
      description: "CHARGE_ORG overage accrued onto the next org invoice",
      postings: [
        {
          account: { kind: "ORG_RECEIVABLE", organizationId },
          direction: "DEBIT",
          amountPaise: amount,
        },
        ...(accrualPaise > 0
          ? [
              {
                account: { kind: "PLATFORM_FEE" as const },
                direction: "CREDIT" as const,
                amountPaise: accrualPaise,
              },
            ]
          : []),
        ...(taxPaise > 0
          ? [
              {
                account: { kind: "GST_PAYABLE" as const },
                direction: "CREDIT" as const,
                amountPaise: taxPaise,
              },
            ]
          : []),
      ],
    });
  }
  return child;
}

async function recordParentInvoicedOrgOverage(
  input: RecordOverageInput,
  bookingUtilizationId: string,
  surchargePaise: number,
): Promise<null> {
  const { tx, programAssignmentId, currency, paymentId } = input;
  if (surchargePaise > 0) {
    const taxPaise = await orgSurchargeTaxPaise(
      tx,
      input.organizationId,
      surchargePaise,
    );
    const childAccrualPayment = await mintChildOverageAccrualPayment(
      input,
      surchargePaise,
      taxPaise,
    );
    await tx.overageEvent.create({
      data: {
        programAssignmentId,
        bookingUtilizationId,
        overageBehavior: "CHARGE_ORG",
        basePaise: 0,
        surchargePaise,
        marginalPaise: surchargePaise + taxPaise,
        currency,
        chargeStatus: "PENDING",
        paymentId: childAccrualPayment.id,
      },
    });
    return null;
  }

  await tx.overageEvent.create({
    data: {
      programAssignmentId,
      bookingUtilizationId,
      overageBehavior: "CHARGE_ORG",
      basePaise: 0,
      surchargePaise: 0,
      marginalPaise: 0,
      currency,
      chargeStatus: "ACCRUED",
      settledAt: new Date(),
      paymentId,
    },
  });
  return null;
}

async function recordOrgOverageCharge(
  input: RecordOverageInput,
  ctx: {
    bookingUtilizationId: string;
    basePaise: number;
    surchargePaise: number;
    marginalPaise: number;
    parentInvoiced: boolean;
  },
): Promise<null> {
  const { tx, programAssignmentId, currency, paymentId } = input;
  const { basePaise, surchargePaise, marginalPaise, parentInvoiced } = ctx;

  // When the parent orgPayment is already invoiced (`parentInvoiced`),
  // its basePaise was already billed on the parent's invoice. Do not mutate
  // the locked parent payment or its legs.
  if (parentInvoiced) {
    return recordParentInvoicedOrgOverage(
      input,
      ctx.bookingUtilizationId,
      surchargePaise,
    );
  }

  const walletLeg = await tx.paymentLeg.findUnique({
    where: { paymentId_source: { paymentId, source: "WALLET" } },
    select: { amountPaise: true },
  });
  if (walletLeg) {
    return recordWalletCollectedOrgOverage(tx, {
      paymentId,
      programAssignmentId,
      bookingUtilizationId: ctx.bookingUtilizationId,
      basePaise,
      surchargePaise,
      marginalPaise,
      currency,
      organizationId: input.organizationId,
      isLazyAllocation: input.isLazyAllocation,
    });
  }

  const baseLeg = await tx.paymentLeg.findUnique({
    where: { paymentId_source: { paymentId, source: "INVOICE_ACCRUAL" } },
    select: { amountPaise: true },
  });
  if (!baseLeg) {
    const licenseLeg = await tx.paymentLeg.findUnique({
      where: { paymentId_source: { paymentId, source: "LICENSE" } },
      select: { amountPaise: true },
    });
    const cardLeg = !licenseLeg
      ? await tx.paymentLeg.findUnique({
          where: { paymentId_source: { paymentId, source: "CARD" } },
          select: { amountPaise: true },
        })
      : null;
    if (input.isLazyAllocation || licenseLeg || cardLeg) {
      // When the parent has no INVOICE_ACCRUAL leg (lazy allocation, LICENSE,
      // or PERSONAL card parent), mint a standalone child accrual Payment with
      // an OVERAGE_INVOICE_ACCRUAL leg and link paymentId on OverageEvent so
      // rollupOrgInvoiceAccruals picks up and bills the overage without
      // violating the parent's leg-sum trigger invariant.
      const effectiveBasePaise = walletLeg ? 0 : basePaise;
      const accrualPaise = effectiveBasePaise + surchargePaise;
      const taxPaise = await orgSurchargeTaxPaise(
        tx,
        input.organizationId,
        surchargePaise,
      );
      const childAccrualPayment = await mintChildOverageAccrualPayment(
        input,
        accrualPaise,
        taxPaise,
      );
      await tx.overageEvent.create({
        data: {
          programAssignmentId,
          bookingUtilizationId: ctx.bookingUtilizationId,
          overageBehavior: "CHARGE_ORG",
          basePaise: effectiveBasePaise,
          surchargePaise,
          marginalPaise: accrualPaise + taxPaise,
          currency,
          chargeStatus: "PENDING",
          paymentId: childAccrualPayment.id,
        },
      });
      return null;
    }
    const fundingErr = new PaymentError(
      "This booking is past your programme's cap and the programme's funding source cannot be charged for the difference. Ask your billing admin to switch the programme to block over-cap bookings, or to fund it from the organisation's wallet or invoice account.",
      "OVERAGE_UNSUPPORTED_FUNDING",
    );
    reportSentryError(fundingErr, {
      subsystem: "payments",
      contexts: { overage: { paymentId, marginalPaise } },
    });
    throw fundingErr;
  }

  // The org is the payer: GST on the surcharge rides the tax-inclusive overage
  // leg and the parent's taxAmount, so the booking journal and the rollup carry it.
  const taxPaise = await orgSurchargeTaxPaise(
    tx,
    input.organizationId,
    surchargePaise,
  );
  const chargedPaise = marginalPaise + taxPaise;

  // #1744 row 1 — a short base leg (credits/discounts already netted) used to
  // carve nothing, so the slice it did hold was billed again inside the
  // OVERAGE leg. Carve whatever the base leg holds, up to basePaise.
  const carved = Math.min(baseLeg.amountPaise, basePaise);
  if (carved > 0) {
    await tx.paymentLeg.update({
      where: { paymentId_source: { paymentId, source: "INVOICE_ACCRUAL" } },
      data: { amountPaise: { decrement: carved } },
    });
  }
  // Upsert/increment OVERAGE_INVOICE_ACCRUAL when multiple overage
  // sessions are lazily allocated on the same uninvoiced subscription payment.
  const existingOverageLeg = await tx.paymentLeg.findUnique({
    where: {
      paymentId_source: {
        paymentId,
        source: "OVERAGE_INVOICE_ACCRUAL",
      },
    },
    select: { amountPaise: true },
  });
  if (existingOverageLeg) {
    await tx.paymentLeg.update({
      where: {
        paymentId_source: {
          paymentId,
          source: "OVERAGE_INVOICE_ACCRUAL",
        },
      },
      data: { amountPaise: { increment: chargedPaise } },
    });
  } else {
    await tx.paymentLeg.create({
      data: {
        paymentId,
        source: "OVERAGE_INVOICE_ACCRUAL",
        amountPaise: chargedPaise,
        sourceRef: `overage:${programAssignmentId}`,
      },
    });
  }
  const amountDelta = chargedPaise - carved;
  if (amountDelta > 0) {
    await tx.payment.update({
      where: { id: paymentId },
      data: {
        amount: { increment: amountDelta },
        ...(taxPaise > 0 ? { taxAmount: { increment: taxPaise } } : {}),
      },
    });
  }
  await tx.overageEvent.create({
    data: {
      programAssignmentId,
      bookingUtilizationId: ctx.bookingUtilizationId,
      overageBehavior: "CHARGE_ORG",
      basePaise,
      surchargePaise,
      marginalPaise: chargedPaise,
      currency,
      chargeStatus: "PENDING",
      // paymentId / invoiceLineItemId / settledAt stamped by the rollup.
    },
  });
  return null;
}

/**
 * Record a CHARGE_ORG overage on a WALLET-funded parent (#2005).
 *
 * On the wallet rail the debit taken when the booking committed is the whole
 * nominal price, so the over-cap pass-through (`basePaise`) is already in the
 * platform's hands the moment the transaction commits. When a surcharge applies
 * (`surchargePaise > 0`), the surcharge plus its output GST (`taxPaise`) is
 * debited from the org's wallet and added to the WALLET leg, `Payment.amount`,
 * and `Payment.taxAmount` so the leg-sum invariant (`Σ non-credit legs == Payment.amount`)
 * and booking ledger stay balanced.
 */
async function recordWalletCollectedOrgOverage(
  tx: Tx,
  args: {
    paymentId: string;
    programAssignmentId: string;
    bookingUtilizationId: string;
    basePaise: number;
    surchargePaise: number;
    marginalPaise: number;
    currency: Currency;
    organizationId?: string | null;
    isLazyAllocation?: boolean;
  },
): Promise<null> {
  const taxPaise = await orgSurchargeTaxPaise(
    tx,
    args.organizationId ?? null,
    args.surchargePaise,
  );
  const totalSurchargePaise = args.surchargePaise + taxPaise;

  if (args.surchargePaise > 0) {
    const parentRow = await tx.payment.findUnique({
      where: { id: args.paymentId },
      select: { billingAccountId: true },
    });
    if (!parentRow?.billingAccountId) {
      throw new PaymentError(
        "Wallet overage surcharge has no billing account on parent payment.",
        "OVERAGE_UNSUPPORTED_FUNDING",
      );
    }
    await walletDebit(tx, {
      billingAccountId: parentRow.billingAccountId,
      amountPaise: totalSurchargePaise,
      reason: "BOOKING",
      paymentId: args.paymentId,
    });
    await tx.paymentLeg.update({
      where: {
        paymentId_source: { paymentId: args.paymentId, source: "WALLET" },
      },
      data: { amountPaise: { increment: totalSurchargePaise } },
    });
    await tx.payment.update({
      where: { id: args.paymentId },
      data: {
        amount: { increment: totalSurchargePaise },
        ...(taxPaise > 0 ? { taxAmount: { increment: taxPaise } } : {}),
      },
    });
  }

  const overageEvent = await tx.overageEvent.create({
    data: {
      programAssignmentId: args.programAssignmentId,
      bookingUtilizationId: args.bookingUtilizationId,
      overageBehavior: "CHARGE_ORG",
      basePaise: args.basePaise,
      surchargePaise: args.surchargePaise,
      marginalPaise: args.marginalPaise + taxPaise,
      currency: args.currency,
      chargeStatus: "CHARGED",
      settledAt: new Date(),
      paymentId: args.paymentId,
    },
  });

  if (args.isLazyAllocation && args.organizationId && totalSurchargePaise > 0) {
    await postLedgerTxn(tx, {
      idempotencyKey: `overage-accrual:${overageEvent.id}`,
      kind: "BOOKING",
      paymentId: args.paymentId,
      description: "CHARGE_ORG wallet overage surcharge and output GST",
      postings: [
        {
          account: { kind: "WALLET", organizationId: args.organizationId },
          direction: "DEBIT",
          amountPaise: totalSurchargePaise,
        },
        {
          account: { kind: "PLATFORM_FEE" },
          direction: "CREDIT",
          amountPaise: args.surchargePaise,
        },
        ...(taxPaise > 0
          ? [
              {
                account: { kind: "GST_PAYABLE" as const },
                direction: "CREDIT" as const,
                amountPaise: taxPaise,
              },
            ]
          : []),
      ],
    });
  }

  // Nothing is owed by anyone, so there is no bell to ring.
  return null;
}

/**
 * Ring the member-due bell for a committed overage. Fire-and-forget: a booking
 * that is already paid for must not fail because a notification did not go out.
 * #1653 — the email twin is awaited inside the same chain, after the bell.
 */
export function notifyOverageDueAfterCommit(
  pending: PendingOverageNotification,
): void {
  void prisma.programAssignment
    .findUnique({
      where: { id: pending.programAssignmentId },
      select: {
        program: {
          select: {
            name: true,
            contract: {
              select: { organization: { select: { name: true } } },
            },
          },
        },
      },
    })
    .then(async (ctx) => {
      if (!ctx) return;
      const orgName = ctx.program.contract.organization.name;
      await notifyOrgProgramOverageDue(pending.userId, {
        orgName,
        programName: ctx.program.name,
        amountPaise: pending.marginalPaise,
        payUrl: `/dashboard/overage?charge=${pending.overageEventId}`,
      });
      await sendOrgOverageDueEmail({
        userId: pending.userId,
        overageEventId: pending.overageEventId,
        orgName,
        programTitle: ctx.program.name,
        amountPaise: pending.marginalPaise,
        currency: pending.currency,
        payUrl: `${getAppUrl()}/dashboard/overage?charge=${pending.overageEventId}`,
      });
    })
    .catch((notifyErr) => {
      console.error("[notifyOrgProgramOverageDue] failed:", notifyErr);
      reportSentryError(notifyErr, {
        subsystem: "payments",
        level: "warning",
      });
    });
}
