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
import { computeOverageForBooking } from "@/lib/payments/billing/overage";
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
   * #1895: True when metering a lazily allocated subscription session after
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
  /** #1653 — the email formats the amount; the bell keeps its INR default. */
  currency: Currency;
  overageEventId: string;
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
  // overage frees the ceiling again.
  const soFarAgg = await tx.overageEvent.aggregate({
    where: {
      programAssignmentId,
      chargeStatus: { notIn: ["REVERSED", "BLOCKED", "FAILED"] },
    },
    _sum: { marginalPaise: true },
  });
  const cycleOverageSoFarPaise = sumPaise(soFarAgg._sum.marginalPaise);

  // Drive the decision through the shared computeOverageForBooking() mapper.
  // For LICENSED_SEAT the PRE-booking engagement count is needed (the meter
  // already applied this booking's delta); for CREDIT_POOL the PRE-booking
  // consumed paise. The preview surface (#777 §C) builds the same context from
  // the assignment's current state, so the two can't drift.
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

  const parentPayment =
    typeof tx.payment?.findUnique === "function"
      ? await tx.payment.findUnique({
          where: { id: paymentId },
          select: { billableToOrgInvoiceId: true },
        })
      : null;
  const parentInvoiced = !!parentPayment?.billableToOrgInvoiceId;

  if (overage.chargeTo === "MEMBER") {
    return recordMemberOverageCharge(input, {
      bookingUtilizationId: bu.id,
      basePaise,
      surchargePaise,
      parentInvoiced,
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
  if (!parentBase || parentBase.amountPaise < basePaise) {
    if (!isLazyAllocation) {
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
            parentInvoiceAccrualPaise: parentBase
              ? parentBase.amountPaise
              : null,
          },
        },
      });
      throw carveErr;
    }
    const lazyCarve = parentBase
      ? Math.min(parentBase.amountPaise, basePaise)
      : 0;
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

async function recordMemberOverageCharge(
  input: RecordOverageInput,
  ctx: {
    bookingUtilizationId: string;
    basePaise: number;
    surchargePaise: number;
    parentInvoiced: boolean;
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

  // #785 / #1895 — carve the over-cap pass-through (basePaise) out of the
  // org-funded parent FIRST so we know the exact carvedBasePaise to bill the
  // member (preventing double-collection when the parent is already invoiced
  // or only partially un-carved).
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

  // Instant member charge. The booking proceeds; create a parent-linked
  // PENDING side-Payment for the effective marginal. The gateway is NOT called
  // inside this Serializable TX — the order is minted lazily when the member
  // opens the resume-checkout surface, and the webhook flips both → CHARGED.
  // `appointmentId: null` avoids the @@unique([userId, appointmentId]) clash.
  const sideCharge = await tx.payment.create({
    data: {
      amount: effectiveMarginalPaise,
      originalAmount: effectiveMarginalPaise,
      taxAmount: 0,
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
    },
  });
  const memberOverageEvent = await tx.overageEvent.create({
    data: {
      programAssignmentId,
      bookingUtilizationId: ctx.bookingUtilizationId,
      overageBehavior: "CHARGE_MEMBER",
      basePaise: carvedBasePaise,
      surchargePaise: ctx.surchargePaise,
      marginalPaise: effectiveMarginalPaise,
      // Mirrors the booking currency (the side-Payment + timeout notify
      // read it back); hardcoding INR mislabels a non-INR booking.
      currency,
      chargeStatus: "PENDING",
      paymentId: sideCharge.id,
    },
  });

  return {
    userId,
    programAssignmentId,
    marginalPaise: effectiveMarginalPaise,
    currency,
    overageEventId: memberOverageEvent.id,
  };
}

/**
 * Mint a child `ENTERPRISE_INVOICE_ACCRUAL` Payment carrying an
 * `OVERAGE_INVOICE_ACCRUAL` leg. Like all enterprise invoice accrual payments,
 * `paymentStatus` is `SUCCEEDED` at birth because the booking is confirmed on
 * enterprise credit and the monthly invoice generator only rolls up legs whose
 * parent payment has `paymentStatus = SUCCEEDED` and `invoiceLineItemId = null`.
 */
function mintChildOverageAccrualPayment(
  input: RecordOverageInput,
  accrualPaise: number,
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
  return tx.payment.create({
    data: {
      amount: accrualPaise,
      originalAmount: accrualPaise,
      taxAmount: 0,
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
          amountPaise: accrualPaise,
          sourceRef: programAssignmentId,
        },
      },
    },
  });
}

async function recordParentInvoicedOrgOverage(
  input: RecordOverageInput,
  bookingUtilizationId: string,
  surchargePaise: number,
): Promise<null> {
  const { tx, programAssignmentId, currency, paymentId } = input;
  if (surchargePaise > 0) {
    const childAccrualPayment = await mintChildOverageAccrualPayment(
      input,
      surchargePaise,
    );
    await tx.overageEvent.create({
      data: {
        programAssignmentId,
        bookingUtilizationId,
        overageBehavior: "CHARGE_ORG",
        basePaise: 0,
        surchargePaise,
        marginalPaise: surchargePaise,
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

  // #1895: When the parent orgPayment is already invoiced (`parentInvoiced`),
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
  if (walletLeg && (!input.isLazyAllocation || surchargePaise === 0)) {
    return recordWalletCollectedOrgOverage(tx, {
      paymentId,
      programAssignmentId,
      bookingUtilizationId: ctx.bookingUtilizationId,
      basePaise,
      surchargePaise,
      marginalPaise,
      currency,
    });
  }

  const baseLeg = await tx.paymentLeg.findUnique({
    where: { paymentId_source: { paymentId, source: "INVOICE_ACCRUAL" } },
    select: { amountPaise: true },
  });
  if (!baseLeg) {
    if (input.isLazyAllocation) {
      // #1895: On a lazy subscription allocation where the parent has no
      // INVOICE_ACCRUAL leg, mint a standalone child accrual Payment with an
      // OVERAGE_INVOICE_ACCRUAL leg and link paymentId on OverageEvent so
      // rollupOrgInvoiceAccruals picks up and bills the overage.
      const effectiveBasePaise = walletLeg ? 0 : basePaise;
      const accrualPaise = effectiveBasePaise + surchargePaise;
      const childAccrualPayment = await mintChildOverageAccrualPayment(
        input,
        accrualPaise,
      );
      await tx.overageEvent.create({
        data: {
          programAssignmentId,
          bookingUtilizationId: ctx.bookingUtilizationId,
          overageBehavior: "CHARGE_ORG",
          basePaise: effectiveBasePaise,
          surchargePaise,
          marginalPaise: accrualPaise,
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
  // #1895 — upsert/increment OVERAGE_INVOICE_ACCRUAL when multiple overage
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
      data: { amountPaise: { increment: marginalPaise } },
    });
  } else {
    await tx.paymentLeg.create({
      data: {
        paymentId,
        source: "OVERAGE_INVOICE_ACCRUAL",
        amountPaise: marginalPaise,
        sourceRef: `overage:${programAssignmentId}`,
      },
    });
  }
  const amountDelta = marginalPaise - carved;
  if (amountDelta > 0) {
    await tx.payment.update({
      where: { id: paymentId },
      data: { amount: { increment: amountDelta } },
    });
  }
  await tx.overageEvent.create({
    data: {
      programAssignmentId,
      bookingUtilizationId: ctx.bookingUtilizationId,
      overageBehavior: "CHARGE_ORG",
      basePaise,
      surchargePaise,
      marginalPaise,
      currency,
      chargeStatus: "PENDING",
      // paymentId / invoiceLineItemId / settledAt stamped by the rollup.
    },
  });
  return null;
}

/**
 * Record a CHARGE_ORG overage on a WALLET-funded parent (#1458).
 *
 * On the wallet rail the debit taken when the booking committed is the whole
 * nominal price, so the over-cap pass-through (`basePaise`) is already in the
 * platform's hands the moment the transaction commits. There is nothing left to
 * bill: the event is born CHARGED and settled, pointing at the payment whose
 * WALLET leg collected it. Writing an OVERAGE_INVOICE_ACCRUAL leg here instead
 * would break the `Σ non-credit legs == Payment.amount` identity the DB trigger
 * enforces, and incrementing `Payment.amount` on top of it made a later
 * cancellation refund the organisation more than its wallet was ever debited.
 *
 * The surcharge is the one part the wallet debit did NOT collect, because it is
 * a markup on top of the price rather than a slice of it. No rail collects it
 * after the fact without inflating the amount again, so the booking is refused
 * rather than quietly under-collected; the config-time guard in
 * `lib/enterprise/reachable-paths.ts` is what keeps operators out of this state.
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
  },
): Promise<null> {
  if (args.surchargePaise > 0) {
    const surchargeErr = new PaymentError(
      "This programme adds a surcharge to bookings past its cap, which a wallet-funded organisation cannot be charged for. Ask your billing admin to remove the overage surcharge or to block over-cap bookings.",
      "OVERAGE_UNSUPPORTED_FUNDING",
    );
    reportSentryError(surchargeErr, {
      subsystem: "payments",
      contexts: {
        overage: {
          paymentId: args.paymentId,
          surchargePaise: args.surchargePaise,
        },
      },
    });
    throw surchargeErr;
  }

  await tx.overageEvent.create({
    data: {
      programAssignmentId: args.programAssignmentId,
      bookingUtilizationId: args.bookingUtilizationId,
      overageBehavior: "CHARGE_ORG",
      basePaise: args.basePaise,
      surchargePaise: args.surchargePaise,
      marginalPaise: args.marginalPaise,
      currency: args.currency,
      // CHARGED is the enum's "money collected" state and the wallet debit is
      // that collection, so the event is settled at birth. It carries no
      // invoiceLineItemId because it never reaches an invoice — `paymentId` is
      // the proof of collection instead, and the reconciler's (G2) link
      // invariant accepts either.
      chargeStatus: "CHARGED",
      settledAt: new Date(),
      paymentId: args.paymentId,
    },
  });

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
