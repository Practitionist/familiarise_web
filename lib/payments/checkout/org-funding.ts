// The org-funded gate ahead of the lock (org status, membership, consent, rail,
// credit ceiling, programme assignment), the invoice credit-limit check, and
// the coverage and GST refusals the checkout payer picker reads before Pay.

import {
  checkAssignee,
  SPONSOR_SEAT_MESSAGES,
} from "@/lib/api/organizations/sponsor-seat";
import prisma, { type Tx } from "@/lib/prisma";
import type { CheckoutInput } from "@/schemas/checkout";
import {
  getInvoiceCreditLimitPaise,
  assertVerifiedDomainOrThrow,
} from "@/lib/enterprise/governance";
import { checkConsent } from "@/lib/compliance/dpdp";
import { PURPOSE_CODES } from "@/lib/compliance/purpose-codes";
import { ENABLE_DUNNING_SUSPEND } from "@/lib/feature-flags";
import { sumPaise } from "@/lib/payments/utils/money";
import {
  assertOrgBillingAvailable,
  currentGstRegime,
} from "@/lib/payments/tax/gst-regime";
import { isRefusal, type RefusalShape } from "@/lib/errors/refusal";
import type { CoveredPlanType } from "@prisma/client";
import { COVERED_PLAN_TYPE_LABEL } from "@/lib/labels/org-labels";

/**
 * #1744 row 4 — the one credit-limit predicate both gates share: the booking
 * being priced counts, so `exposure + booking > limit` refuses. Copy is in
 * whole rupees; the limit is a business figure, not a paise integer.
 */
export function assertWithinInvoiceCreditLimit(
  exposurePaise: number,
  bookingPaise: number,
  limitPaise: number,
): void {
  if (exposurePaise + bookingPaise <= limitPaise) return;
  const rupees = (p: number) =>
    `₹${Math.round(p / 100).toLocaleString("en-IN")}`;
  throw Object.assign(
    new Error(
      `This booking would take the organisation past its invoice credit limit of ${rupees(limitPaise)} (${rupees(exposurePaise)} already outstanding). Outstanding invoices must be paid before new bookings.`,
    ),
    { httpStatus: 402, code: "ORG_CREDIT_LIMIT_REACHED" },
  );
}

/**
 * An org's unbilled invoice accruals NET of their refund reversal legs
 * (mirrors invoice-rollup.ts, which bills the net). The credit-limit exposure
 * and the billing page's "not yet invoiced" figure both read this.
 */
export async function readUnbilledAccrualPaise(
  db: Pick<Tx, "paymentLeg">,
  organizationId: string,
): Promise<number> {
  const accrualAgg = await db.paymentLeg.aggregate({
    where: {
      source: {
        in: [
          "INVOICE_ACCRUAL",
          "OVERAGE_INVOICE_ACCRUAL",
          // Refunds append negative *_REVERSAL siblings; without them
          // a refunded seat kept counting against the limit.
          "INVOICE_ACCRUAL_REVERSAL",
          "OVERAGE_INVOICE_ACCRUAL_REVERSAL",
        ],
      },
      payment: {
        organizationId,
        paymentStatus: "SUCCEEDED",
        billableToOrgInvoiceId: null,
      },
    },
    _sum: { amountPaise: true },
  });
  return sumPaise(accrualAgg._sum.amountPaise);
}

/**
 * An org's open invoice exposure: unbilled accruals NET of
 * their refund reversal legs, plus invoices already issued and unpaid. Both
 * credit-limit gates read this.
 */
export async function readInvoiceExposurePaise(
  db: Pick<Tx, "paymentLeg" | "organizationInvoice">,
  organizationId: string,
): Promise<number> {
  // Sequential (never Promise.all on `tx`): under PG_POOL_MAX=1 a single
  // interactive-tx connection cannot serve concurrent queries.
  const accrued = await readUnbilledAccrualPaise(db, organizationId);
  const outstandingAgg = await db.organizationInvoice.aggregate({
    where: {
      organizationId,
      status: { in: ["ISSUED", "OVERDUE"] },
    },
    _sum: { totalPaise: true },
  });
  return accrued + sumPaise(outstandingAgg._sum.totalPaise);
}

export const PROGRAM_ASSIGNMENT_INACTIVE = "PROGRAM_ASSIGNMENT_INACTIVE";

/** The refusal sentence when no active programme assignment covers `planType`. */
export function noCoveringAssignmentMessage(planType: CoveredPlanType): string {
  const bookings = `${COVERED_PLAN_TYPE_LABEL[planType].toLowerCase()} bookings`;
  return `No active program assignment covers this booking. Ask your organisation admin to assign you to a Program that covers ${bookings}.`;
}

/**
 * The member's active assignment at this organisation, today, whose Program
 * and contract are ACTIVE and whose `coveredPlanTypes` include `planType`
 * (empty covers everything).
 */
export function findCoveringAssignment(
  membershipId: string,
  organizationId: string,
  planType: CoveredPlanType,
): Promise<{ id: string; programId: string } | null> {
  const now = new Date();
  return prisma.programAssignment.findFirst({
    where: {
      membershipId,
      status: "ACTIVE",
      periodStart: { lte: now },
      periodEnd: { gte: now },
      program: {
        status: "ACTIVE",
        OR: [
          { coveredPlanTypes: { isEmpty: true } },
          { coveredPlanTypes: { has: planType } },
        ],
        contract: {
          organizationId,
          status: "ACTIVE",
          effectiveFrom: { lte: now },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: now } }],
        },
      },
    },
    orderBy: { periodEnd: "desc" },
    select: { id: true, programId: true },
  });
}

/**
 * The refusal checkout would give this member for billing `planType` to the
 * organisation now on programme coverage or GST registration; null when neither refuses.
 */
export async function orgFundingRefusal(
  organizationId: string,
  membershipId: string,
  planType: CoveredPlanType,
): Promise<RefusalShape | null> {
  const account = await prisma.billingAccount.findUnique({
    where: { ownerOrgId: organizationId },
    select: { fundingSource: true },
  });
  // The PERSONAL rail is the learner's own card; neither gate applies to it.
  if ((account?.fundingSource ?? "PERSONAL") === "PERSONAL") return null;

  if (!(await findCoveringAssignment(membershipId, organizationId, planType))) {
    return {
      code: PROGRAM_ASSIGNMENT_INACTIVE,
      message: noCoveringAssignmentMessage(planType),
    };
  }
  try {
    assertOrgBillingAvailable(currentGstRegime());
  } catch (error) {
    if (isRefusal(error)) return error.toShape();
    throw error;
  }
  return null;
}

/**
 * What the pre-lock org gate resolved. `validatedData` comes back with its
 * referral credits stripped when an org funds the booking.
 */
export interface OrgFundingGate {
  organizationId: string | null;
  billingAccountId: string | null;
  fundingSource: "PERSONAL" | "WALLET" | "INVOICE" | "LICENSE" | null;
  programAssignmentId: string | null;
  fundingProgramId: string | null;
  callerMembershipId: string | null;
  creditEffectiveLimit: number | null;
  referralCreditsDropped: boolean;
  validatedData: CheckoutInput;
}

export async function resolveOrgFunding(
  validatedData: CheckoutInput,
  userId: string,
  appointmentType: Exclude<CheckoutInput["appointmentType"], "TRIAL">,
): Promise<OrgFundingGate> {
  // Enterprise (Arch 4-Modified): resolve org + Program context up-front.
  //
  //   fundingSource=PERSONAL → org is tagged for reporting only; learner pays.
  //   fundingSource=WALLET   → debit BillingAccount.walletBalance atomically.
  //   fundingSource=INVOICE  → accrue to the org's monthly invoice.
  //   fundingSource=LICENSE  → absorbed by a LICENSED_SEAT program, amount=0.
  //
  // Every non-PERSONAL path also requires an ACTIVE `ProgramAssignment`
  // whose Program covers the current `appointmentType` — that's the source
  // of truth for "is this booking sponsored?". A missing assignment on a
  // WALLET/INVOICE/LICENSE org fails closed: we refuse rather than
  // silently bill the learner's card.
  let organizationId: string | null = null;
  let billingAccountId: string | null = null;
  let fundingSource: "PERSONAL" | "WALLET" | "INVOICE" | "LICENSE" | null =
    null;
  let programAssignmentId: string | null = null;
  // ADR 18 — Program behind the assignment above; feeds the curated-panel
  // check in revalidateInsideLock.
  let fundingProgramId: string | null = null;
  let callerMembershipId: string | null = null;
  // #785 B6 — effective INVOICE credit limit; threaded to the Serializable
  // booking tx for a race-safe re-check (the pre-lock check below is fast-fail only).
  let creditEffectiveLimit: number | null = null;
  // Set when org funding strips the buyer's referral credits; the UI says so.
  let referralCreditsDropped = false;

  if (validatedData.organizationId) {
    const org = await prisma.organization.findUnique({
      where: { id: validatedData.organizationId },
      select: {
        id: true,
        status: true,
        canSponsor: true,
        billingAccount: {
          select: {
            id: true,
            fundingSource: true,
            creditLimit: true,
            walletBalance: true,
          },
        },
      },
    });
    if (!org) {
      throw new Error("Organization not found.");
    }
    // PR-1d: PENDING_VERIFICATION orgs may transact for INVOICE bookings
    // under the credit-limit gate (#687 invoice-fraud guard). Anything
    // else still requires fully ACTIVE status.
    // #1582 B-P1-01c — typed 403s; the pre-tx twins of the in-tx re-checks.
    if (org.status !== "ACTIVE" && org.status !== "PENDING_VERIFICATION") {
      throw Object.assign(
        new Error(
          `Organization is ${org.status.toLowerCase()}; cannot process bookings.`,
        ),
        { httpStatus: 403, code: "ORG_NOT_OPERATIONAL" },
      );
    }
    if (!org.canSponsor) {
      throw Object.assign(
        new Error(
          "This organization is not configured to sponsor bookings (canSponsor=false).",
        ),
        { httpStatus: 403, code: "ORG_CANNOT_SPONSOR" },
      );
    }

    // #812 — dunning-suspend gate (config-gated, default off). The dunning cron's
    // Stage 3 stamps OrganizationInvoice.dunningSuspendedAt once an invoice is
    // unpaid past the grace window; while any such invoice is still OVERDUE, new
    // sponsored bookings for the org are blocked until it is paid. Paying the
    // invoice clears its OVERDUE status, which lifts this gate naturally.
    if (ENABLE_DUNNING_SUSPEND) {
      const suspended = await prisma.organizationInvoice.findFirst({
        where: {
          organizationId: org.id,
          status: "OVERDUE",
          dunningSuspendedAt: { not: null },
        },
        select: { invoiceNumber: true },
        // #750 — cite the OLDEST overdue invoice in the block message, not an
        // arbitrary one.
        orderBy: { dueDate: "asc" },
      });
      if (suspended) {
        // #1467 — same shape as the assignment refusal below: a bare Error here
        // would 500 the moment the flag is switched on. 402 because the block is
        // lifted by paying money that is already owed, which is exactly what
        // Payment Required means to the buyer's client.
        throw Object.assign(
          new Error(
            `This organization has an overdue invoice (${suspended.invoiceNumber}) and is suspended from new sponsored bookings until it is paid.`,
          ),
          { httpStatus: 402, code: "BILLING_SUSPENDED_DUNNING" },
        );
      }
    }

    // SECURITY: Verify the caller is an active Membership of this org.
    const callerMembership = await prisma.membership.findUnique({
      where: { userId_organizationId: { userId, organizationId: org.id } },
      select: { role: true, status: true, id: true },
    });
    if (!callerMembership || callerMembership.status !== "ACTIVE") {
      // qa-1753 — the pre-tx twin of the in-tx check carries the same code.
      throw Object.assign(
        new Error("You are not an active member of this organization."),
        { httpStatus: 403, code: "ORG_MEMBERSHIP_REQUIRED" },
      );
    }

    // #701 — DPDP consent gate. The member is having a session booked + paid on
    // their behalf by the org; require a live SESSION_BOOKING consent artifact
    // before processing it. Fail-closed (checkConsent is false with no artifact).
    if (
      !(await checkConsent({
        userId,
        purposeCode: PURPOSE_CODES.SESSION_BOOKING,
      }))
    ) {
      throw Object.assign(
        new Error(
          "Your organisation needs your permission to book sessions for you. You can give it in Settings › Account › Data consent.",
        ),
        {
          httpStatus: 403,
          code: "CONSENT_REQUIRED",
          purposeCode: "SESSION_BOOKING",
        },
      );
    }

    organizationId = org.id;
    callerMembershipId = callerMembership.id;
    billingAccountId = org.billingAccount?.id ?? null;
    fundingSource = org.billingAccount?.fundingSource ?? "PERSONAL";
    // Org money funds LEARNER memberships only, never an operator's own booking.
    if (
      fundingSource !== "PERSONAL" &&
      !checkAssignee(callerMembership, callerMembership.id, null).ok
    ) {
      throw Object.assign(new Error(SPONSOR_SEAT_MESSAGES.ROLE), {
        httpStatus: 409,
        code: "SPONSOR_SEAT_ROLE",
      });
    }

    // Block personal referral credits on org-funded bookings.
    if (validatedData.useReferralCredits && fundingSource !== "PERSONAL") {
      validatedData = { ...validatedData, useReferralCredits: false };
      referralCreditsDropped = true;
    }

    // INVOICE fundingSource: enforce creditLimit. PR-1d (#687):
    // unverified orgs (PENDING_VERIFICATION) get an automatic
    // governance credit-limit even when the BillingAccount.creditLimit
    // column is null — the default ₹50k starter blocks the
    // book-everything-then-ghost abuse pattern. The cap auto-lifts
    // once the org is verified OR pays its first invoice.
    if (fundingSource === "INVOICE") {
      // K-02 / #687 — an org may not accrue INVOICE debt without a verified
      // domain. The credit-limit gate below caps unverified-STATUS orgs; this
      // asserts the orthogonal domain-ownership proof (OrgDomainClaim), the
      // gate governance.ts documents for INVOICE funding but had no caller.
      await assertVerifiedDomainOrThrow(prisma, org.id, "INVOICE_FUNDING");

      const explicitLimit = org.billingAccount?.creditLimit ?? null;
      const isVerified = org.status === "ACTIVE";
      const governanceLimit = isVerified ? null : getInvoiceCreditLimitPaise();
      const effectiveLimit =
        explicitLimit === null
          ? governanceLimit
          : governanceLimit === null
            ? explicitLimit
            : Math.min(explicitLimit, governanceLimit);
      creditEffectiveLimit = effectiveLimit;
      // #1744 row 4 — the fast-fail exposure check moved below STEP 1: it needs
      // this booking's price, which is not derived yet at this point.
    }

    // Resolve a currently-active ProgramAssignment for this member that
    // covers the appointment type. The assignment's Program must be
    // ACTIVE and attached to an ACTIVE contract still within its
    // effectiveFrom..effectiveTo window. The Program's
    // `coveredPlanTypes` array filters which appointment types it
    // sponsors (empty array = covers everything).
    // For PERSONAL funding, an active ProgramAssignment is optional (enables
    // curated-panel and cap/overage governance when assigned, while allowing
    // unassigned personal bookings to proceed).
    if (
      fundingSource !== "PERSONAL" ||
      Boolean(prisma.programAssignment?.findFirst)
    ) {
      const assignment = await findCoveringAssignment(
        callerMembership.id,
        org.id,
        appointmentType,
      );

      if (!assignment && fundingSource !== "PERSONAL") {
        throw Object.assign(
          new Error(noCoveringAssignmentMessage(appointmentType)),
          { httpStatus: 409, code: PROGRAM_ASSIGNMENT_INACTIVE },
        );
      }
      if (assignment) {
        programAssignmentId = assignment.id;
        fundingProgramId = assignment.programId;
      }
    }
  }

  return {
    organizationId,
    billingAccountId,
    fundingSource,
    programAssignmentId,
    fundingProgramId,
    callerMembershipId,
    creditEffectiveLimit,
    referralCreditsDropped,
    validatedData,
  };
}
