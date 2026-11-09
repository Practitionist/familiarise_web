// The org rail inside the checkout tx: wallet debit, the org funding leg,
// the programme meter, the cap-near bell and overage settlement.

import type { Tx } from "@/lib/prisma";
import { walletDebit } from "@/lib/api/organizations/wallet";
import {
  isWalletFrozen,
  WalletFrozenError,
} from "@/lib/payments/wallet-freeze";
import {
  recordBookingUtilization,
  ProgramAssignmentLimitError,
} from "@/lib/api/organizations/program-helpers";
import {
  recordOverageAtCheckout,
  type PendingOverageNotification,
} from "@/lib/payments/billing/overage-settlement";
import type { CheckoutCommitInput } from "@/lib/payments/checkout/commit/types";
import { recordRelatedPartyBooking } from "@/lib/enterprise/related-party";

export async function recordCheckoutUtilization(
  tx: Tx,
  input: CheckoutCommitInput,
  carried: {
    createdAppointment: { id: string } | null | undefined;
    payment: { id: string; amount: number; expiresAt: Date | null };
    engagementsForCap: number | null;
    classEngagementIds: string[];
  },
) {
  const {
    validatedData,
    userId,
    organizationId,
    billingAccountId,
    programAssignmentId,
    callerMembershipId,
    isOrgWalletPayment,
    isOrgLicensedPayment,
    isOrgSponsoredPayment,
    exhaustedBell,
  } = input;
  const { amount, currency } = input.priced;
  const { createdAppointment, payment, engagementsForCap, classEngagementIds } =
    carried;

  // #1435 — this attempt's bells, returned below and rung post-commit.
  let capNearBell: {
    programAssignmentId: string;
    engagementsUsed: number;
    cap: number;
    usedPct: number;
  } | null = null;
  let overageBell: PendingOverageNotification | null = null;

  if (isOrgWalletPayment && billingAccountId) {
    if (await isWalletFrozen(tx, billingAccountId)) {
      throw new WalletFrozenError(billingAccountId);
    }
    await walletDebit(tx, {
      billingAccountId,
      amountPaise: amount,
      reason: "BOOKING",
      paymentId: payment.id,
      membershipId: callerMembershipId ?? undefined,
    });
  }

  if (programAssignmentId && isOrgSponsoredPayment) {
    await tx.paymentLeg.create({
      data: {
        paymentId: payment.id,
        source: isOrgWalletPayment
          ? "WALLET"
          : isOrgLicensedPayment
            ? "LICENSE"
            : "INVOICE_ACCRUAL",
        amountPaise: isOrgLicensedPayment ? 0 : amount,
        sourceRef: programAssignmentId,
      },
    });
  }

  // Org rails never fund a trial; the guard narrows the plan kind.
  if (
    isOrgSponsoredPayment &&
    organizationId &&
    validatedData.appointmentType !== "TRIAL"
  ) {
    await recordRelatedPartyBooking(tx, {
      organizationId,
      planKind: validatedData.appointmentType,
      planId: validatedData.planId,
      paymentId: payment.id,
      appointmentId: createdAppointment?.id ?? null,
      buyerMembershipId: callerMembershipId ?? null,
    });
  }

  if (programAssignmentId && engagementsForCap !== null) {
    let utilizationResult: Awaited<
      ReturnType<typeof recordBookingUtilization>
    > = {
      wasOverage: false,
      engagementsConsumedDelta: 0,
      engagementsUsedAfter: 0,
      cap: null,
      programType: "LICENSED_SEAT",
      consumedPaiseAfter: 0,
      creditBudgetPaise: null,
      usageLedgerEntryId: null,
    };
    try {
      utilizationResult = await recordBookingUtilization(tx, {
        programAssignmentId,
        paymentId: payment.id,
        engagementsConsumed: engagementsForCap,
        priceAtBookingPaise: amount,
        // PR-1e (G3) — the helper's set-diff idempotency guard only
        // arms itself when the caller NAMES the appointments.
        // Omitting them left every checkout debit unguarded, so a
        // replay against the same Payment (retried webhook, resumed
        // order) incremented the meter a second time.
        // CONSULTATION/WEBINAR are one engagement on the appointment
        // just created; CLASS meters one per class session, which is
        // exactly the occurrence set handleClassCheckout counted.
        appointmentIds:
          validatedData.appointmentType === "CLASS"
            ? classEngagementIds
            : createdAppointment
              ? [createdAppointment.id]
              : [],
      });
    } catch (err) {
      if (err instanceof ProgramAssignmentLimitError) {
        // The assignee + org operators are told the programme is
        // spent. This is the one bell that belongs on the ROLLBACK
        // path — the refusal IS the news — so it is rung from the
        // retry wrapper's catch rather than after a commit that
        // never happens.
        exhaustedBell.programAssignmentId = programAssignmentId;

        // #1458 — a stable code, because the message-preservation
        // list below never matched this sentence and the buyer got
        // "Failed to record payment information" for a cap they can
        // ask an admin to raise.
        throw Object.assign(
          new Error(
            "You've used all the sessions in your programme for this cycle. Ask your organisation admin, or wait for the next cycle.",
          ),
          { httpStatus: 402, code: "PROGRAM_SESSION_CAP_REACHED" },
        );
      }
      throw err;
    }

    // #768 #22 — 80% cap-near early warning. Fire ONCE per cycle on
    // the <80% → >=80% transition (not on every booking past 80%).
    // Integer-only threshold cross: before/cap < 0.8 (before*5 <
    // cap*4) AND after/cap >= 0.8 (after*5 >= cap*4). Skipped when
    // cap is null (unlimited) or 0. Captured for post-commit
    // delivery + same roster as the 100% event.
    {
      // #775 — LICENSED_SEAT meters in engagements, CREDIT_POOL in
      // paise (consumedPaise vs creditBudgetPaise). The 80% transition
      // math is unit-agnostic; the Novu payload reports credits for
      // pools (÷100) and engagements for seats.
      const isCredit = utilizationResult.programType === "CREDIT_POOL";
      const capAfter = isCredit
        ? utilizationResult.creditBudgetPaise
        : utilizationResult.cap;
      const after = isCredit
        ? utilizationResult.consumedPaiseAfter
        : utilizationResult.engagementsUsedAfter;
      const before = isCredit
        ? after - amount
        : after - utilizationResult.engagementsConsumedDelta;
      if (
        capAfter !== null &&
        capAfter !== undefined &&
        capAfter > 0 &&
        before * 5 < capAfter * 4 &&
        after * 5 >= capAfter * 4
      ) {
        // #1169 PR 2 — the bell must ring once per booking, not once
        // per Serializable attempt. The slot is a local of this
        // attempt and only the committing attempt's is returned,
        // which is what enforces that now.
        capNearBell = {
          programAssignmentId,
          engagementsUsed: isCredit ? Math.round(after / 100) : after,
          cap: isCredit ? Math.round(capAfter / 100) : capAfter,
          usedPct: Math.round((after / capAfter) * 100),
        };
      }
    }

    // C2: overage charging. recordBookingUtilization above flagged
    // `wasOverage = true` if the increment crossed the cap (only
    // possible when overageBehavior is CHARGE_MEMBER or CHARGE_ORG;
    // BLOCK throws inside the helper). Branch on the program's
    // configured behavior (#775):
    //   - CHARGE_ORG: write an OVERAGE_INVOICE_ACCRUAL PaymentLeg +
    //     OverageEvent(PENDING). The monthly invoice rollup picks it
    //     up (→ ACCRUED) and the invoice-paid handler marks it CHARGED.
    //   - CHARGE_MEMBER: the booking proceeds; the member owes the
    //     marginal. Create a parent-linked PENDING side-Payment +
    //     OverageEvent(PENDING). The member completes it via the
    //     resume-checkout surface (order created there, not in this TX)
    //     and the gateway webhook transitions it → CHARGED.
    //   - BLOCK behavior: never reaches here (helper already threw).
    //     The circuit-breaker veto is the only BLOCK decision here.
    if (utilizationResult.wasOverage && isOrgSponsoredPayment) {
      // #778 elegance — extracted to recordOverageAtCheckout (resolves
      // the behaviour via computeOverage, enforces the circuit breaker,
      // persists the OverageEvent + CHARGE_MEMBER side-Payment /
      // CHARGE_ORG accrual leg). Throws PROGRAM_CAP_EXHAUSTED (402) on
      // the breaker veto. PERSONAL-funded bookings already charge the
      // member's gateway directly, so only org-sponsored payments run
      // checkout overage settlement.
      overageBell = await recordOverageAtCheckout({
        tx,
        programAssignmentId,
        utilization: {
          programType: utilizationResult.programType,
          engagementsConsumedDelta: utilizationResult.engagementsConsumedDelta,
          engagementsUsedAfter: utilizationResult.engagementsUsedAfter,
          consumedPaiseAfter: utilizationResult.consumedPaiseAfter,
          creditBudgetPaise: utilizationResult.creditBudgetPaise,
          usageLedgerEntryId: utilizationResult.usageLedgerEntryId,
        },
        bookingPricePaise: amount,
        currency,
        paymentId: payment.id,
        userId,
        organizationId,
        paymentGateway: validatedData.paymentGateway,
      });
    }
  }
  return { capNearBell, overageBell };
}
