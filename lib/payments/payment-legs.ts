/**
 * PaymentLeg.sourceRef invariants per leg kind.
 *
 * Each leg on a `Payment` records one funding source. The `sourceRef`
 * column is a free-form string in Postgres, but semantically it carries
 * a different foreign key depending on `source`. This module centralises
 * the invariant so reconciliation jobs, refund flows, and audit writers
 * can join back without hunting through the schema.
 *
 * Keep this in lockstep with:
 *   - `prisma/schema.prisma` → `model PaymentLeg`
 *   - `docs/enterprise/10-money-and-ledger/09-payment-legs.md`
 *
 * If you add a new `PaymentLegSource` enum value you MUST add its
 * sourceRef semantics here so downstream reconcile code stays honest.
 */
import type { PaymentLegSource } from "@prisma/client";

/**
 * What a `sourceRef` string MUST contain, per leg kind:
 *
 *   CARD             → gateway payment id (pay_xxx for Razorpay, ch_xxx
 *                      or pi_xxx for Stripe). Used by refund handlers to
 *                      correlate webhook events to a leg.
 *   WALLET           → ProgramAssignment.id the leg is being billed to.
 *                      The wallet debit itself is a separate WalletEntry
 *                      row keyed on (billingAccountId, appointmentId);
 *                      sourceRef points at the assignment so reconcile
 *                      reports can answer "which program absorbed this
 *                      spend".
 *   REFERRAL_CREDIT  → ReferralCreditUsage.id created by
 *                      `applyCreditsToPayment`. Refund reversal reads
 *                      this to compute how many credits to restore.
 *   INVOICE_ACCRUAL          → ProgramAssignment.id that the accrual is being
 *                              rolled into. At month-end the invoice generator
 *                              groups legs by (organizationId, assignmentId) to
 *                              produce line items.
 *   OVERAGE_INVOICE_ACCRUAL  → ProgramAssignment.id (with "overage:" prefix in
 *                              sourceRef). Carries the marginal charge that
 *                              exceeds a LICENSED_SEAT cap under CHARGE_ORG.
 *                              Treated identically to INVOICE_ACCRUAL for
 *                              rollup and refund; separate source value prevents
 *                              @@unique([paymentId, source]) collision.
 *   LICENSE          → ProgramAssignment.id of the LICENSED_SEAT program
 *                      that absorbed the booking. `amountPaise === 0`
 *                      because licenses are a sunk cost at contract
 *                      time; the leg exists so every Payment still has
 *                      ≥1 leg and reconciliation can prove the booking
 *                      was lawfully fulfilled without a gateway charge.
 */
export type PaymentLegSourceRefKind =
  | "GATEWAY_PAYMENT_ID"
  | "PROGRAM_ASSIGNMENT_ID"
  | "REFERRAL_CREDIT_USAGE_ID";

export function sourceRefKindFor(
  source: PaymentLegSource,
): PaymentLegSourceRefKind {
  switch (source) {
    case "CARD":
      return "GATEWAY_PAYMENT_ID";
    case "REFERRAL_CREDIT":
      return "REFERRAL_CREDIT_USAGE_ID";
    case "WALLET":
    case "INVOICE_ACCRUAL":
    case "OVERAGE_INVOICE_ACCRUAL":
    case "LICENSE":
      return "PROGRAM_ASSIGNMENT_ID";
    default: {
      const _exhaustive: never = source;
      throw new Error(
        `Unknown PaymentLegSource: ${_exhaustive as string} — update lib/payments/payment-legs.ts`,
      );
    }
  }
}

/**
 * Typed builder for a PaymentLeg input. Callers pass the `source` plus
 * a strongly-typed discriminated ref; the builder converts it to the
 * flat `{ source, amountPaise, sourceRef }` shape that Prisma expects
 * while keeping the semantic mapping enforced at compile time.
 *
 * Usage:
 *   makeLeg({ source: "CARD",    amountPaise: 150000, gatewayPaymentId: "pay_x" })
 *   makeLeg({ source: "WALLET",  amountPaise:  50000, programAssignmentId: "asg_x" })
 *   makeLeg({ source: "LICENSE", amountPaise:      0, programAssignmentId: "asg_x" })
 */
export type PaymentLegInput =
  | {
      source: "CARD";
      amountPaise: number;
      gatewayPaymentId: string;
    }
  | {
      source: "REFERRAL_CREDIT";
      amountPaise: number;
      referralCreditUsageId: string;
    }
  | {
      source: "WALLET" | "INVOICE_ACCRUAL" | "OVERAGE_INVOICE_ACCRUAL" | "LICENSE";
      amountPaise: number;
      programAssignmentId: string;
    };

export function makeLeg(input: PaymentLegInput): {
  source: PaymentLegSource;
  amountPaise: number;
  sourceRef: string;
} {
  switch (input.source) {
    case "CARD":
      return {
        source: "CARD",
        amountPaise: input.amountPaise,
        sourceRef: input.gatewayPaymentId,
      };
    case "REFERRAL_CREDIT":
      return {
        source: "REFERRAL_CREDIT",
        amountPaise: input.amountPaise,
        sourceRef: input.referralCreditUsageId,
      };
    case "WALLET":
    case "INVOICE_ACCRUAL":
    case "OVERAGE_INVOICE_ACCRUAL":
    case "LICENSE":
      return {
        source: input.source,
        amountPaise: input.amountPaise,
        sourceRef: input.programAssignmentId,
      };
  }
}

/**
 * Per-payment invariant: `sum(legs.amountPaise) === Payment.amount`.
 *
 * `LICENSE` legs intentionally carry `amountPaise = 0` (the cost is
 * absorbed at contract time) — they're still part of the sum and the
 * math holds. For org-sponsored flows a single non-zero leg (WALLET or
 * INVOICE_ACCRUAL) equals `Payment.amount`. For B2C card flows with
 * referral credits applied the CARD leg carries the post-credit gateway
 * charge and the REFERRAL_CREDIT leg carries the credit value; together
 * they sum to `Payment.amount` (which is post-credit per the field-
 * level comment on `Payment.amount`).
 *
 * Returns `null` when the invariant holds, or a `PaymentLegSumMismatch`
 * payload describing the drift otherwise. Callers pick policy: hard
 * throw for tests + reconciliation jobs, structured log for hot paths
 * where breaking checkout is worse than surfacing a warning.
 *
 * The `amountPaise` values on individual legs can be negative (refund
 * adjustments write negative legs to keep the ledger immutable), so the
 * check is signed — do not `Math.abs` the sum.
 */
export type PaymentLegSumMismatch = {
  paymentAmountPaise: number;
  legSumPaise: number;
  deltaPaise: number;
  legs: Array<{ source: PaymentLegSource; amountPaise: number }>;
};

export function checkPaymentLegsSumToAmount(args: {
  paymentAmountPaise: number;
  legs: Array<{ source: PaymentLegSource; amountPaise: number }>;
}): PaymentLegSumMismatch | null {
  const legSum = args.legs.reduce((acc, leg) => acc + leg.amountPaise, 0);
  if (legSum === args.paymentAmountPaise) return null;
  return {
    paymentAmountPaise: args.paymentAmountPaise,
    legSumPaise: legSum,
    deltaPaise: legSum - args.paymentAmountPaise,
    legs: args.legs,
  };
}

/**
 * Hard-throwing sibling of `checkPaymentLegsSumToAmount`. Use in tests
 * and in reconciliation / settlement jobs where the invariant MUST hold
 * before the job continues. Do not use in the hot checkout path — a
 * production false-positive there would break booking for real users.
 */
export function assertPaymentLegsSumToAmount(args: {
  paymentAmountPaise: number;
  legs: Array<{ source: PaymentLegSource; amountPaise: number }>;
}): void {
  const mismatch = checkPaymentLegsSumToAmount(args);
  if (!mismatch) return;
  throw new Error(
    `PaymentLeg sum invariant violated: expected ${mismatch.paymentAmountPaise} paise but legs sum to ${mismatch.legSumPaise} (delta ${mismatch.deltaPaise}). Legs: ${JSON.stringify(mismatch.legs)}`,
  );
}
