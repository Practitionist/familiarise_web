/**
 * Earnings Service
 * Manages consultant and organization earnings from payments.
 *
 * For HOST / HYBRID orgs, implements a 3-way revenue split:
 *   Payment (100%) = Platform fee (configurable, default 10%)
 *                   + Org retain (configurable, default 5%)
 *                   + Consultant payout (configurable, default 85%)
 *
 * The split is controlled by the org's active `RateCard` row and can be
 * overridden per-membership via `Membership.rateCardOverrideId`.
 *
 * When `Membership.payoutRecipient = ORGANIZATION`, the consultant's share
 * is redirected to the org (internal / salaried consultant case) and the
 * consultant's personal payout for that booking is zero.
 */

import { reportSentryError } from "@/lib/observability/report";
import { z } from "zod";
import prisma, { type Tx } from "@/lib/prisma";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import {
  postLedgerTxn,
  type AccountRef,
  type Posting,
} from "@/lib/payments/ledger/post";
import {
  EarningRole,
  EarningStatus,
  Payment,
  Prisma,
  type CoveredPlanType,
} from "@prisma/client";
import { AppointmentType } from "./constants";
import {
  computeHoldUntil,
  holdHoursFor,
  resolveEarningsAnchor,
} from "./earnings-hold";
import { calculateRevenueSplit } from "@/lib/collaborators/service";
import {
  planB2cPlatformFeePaise,
  settleB2cPlatformFeePaise,
} from "@/lib/payments/pricing/platform-fee";
import { recordTdsReversal } from "@/lib/payments/tax/tds-service";
import { ENABLE_HOST_ORGS } from "@/lib/feature-flags";
import { recordSystemErrorSafe } from "@/lib/enterprise/system-events";
import { hasUnappliedReceipt } from "@/lib/payments/ledger/unapplied-receipts";
import type { RevenueSplit } from "@/types/collaborators";

// ============================================
// Types
// ============================================

export interface EarningsSummary {
  consultantProfileId: string;
  totalEarnings: number;
  pendingEarnings: number;
  readyEarnings: number;
  /** #837 — in a payout batch, cash not yet disbursed (distinct from PAID). */
  batchedEarnings: number;
  paidEarnings: number;
  heldEarnings: number;
  /**
   * Earnings accrued from a not-yet-verified INVOICE-funded org (see
   * EarningStatus.PENDING_TRUST). Deliberately EXCLUDED from
   * totalEarnings — the money isn't cleared until the org is verified
   * or pays; the dashboard surfaces it as its own bucket.
   */
  pendingTrustEarnings: number;
}

/** Resolved 3-way split for a canHost=true org consultant */
interface OrgEarningsSplit {
  organizationId: string;
  rateCardIdApplied: string | null;
  platformBps: number;
  orgBps: number;
  consultantBps: number;
  platformFeePaise: number; // in paise
  orgShare: number; // in paise (org retains this)
  consultantSharePaise: number; // in paise (goes to consultant, or 0 if internal)
  payoutRecipient: "SELF" | "ORGANIZATION";
}

/** Summary of an org's earnings across all statuses */
interface OrgEarningsSummary {
  organizationId: string;
  totalEarnings: number;
  pendingEarnings: number;
  readyEarnings: number;
  /** #837 — in a payout batch, cash not yet disbursed (distinct from PAID). */
  batchedEarnings: number;
  paidEarnings: number;
  heldEarnings: number;
}

// #780/#781 — payments arrive via the extended client (money as number, FX
// Decimal as number); the raw Payment model type still says bigint/Decimal.
type PaymentRow = Omit<
  Payment,
  | "amount"
  | "originalAmount"
  | "taxAmount"
  | "exchangeRateAtCheckout"
  | "welcomeDiscountPaise"
> & {
  amount: number;
  originalAmount: number;
  taxAmount: number;
  exchangeRateAtCheckout: number | null;
  welcomeDiscountPaise: number | null;
};

export interface CreateEarningsParams {
  payment: PaymentRow & {
    appointment?: {
      consultantProfile?: {
        id: string;
      };
      webinar?: {
        webinarPlanId: string;
      } | null;
      class?: {
        classPlanId: string;
      } | null;
      /** #1775 C-9 — a trial's earning waits for delivery (holdUntil null). */
      trial?: { id: string } | null;
    } | null;
  };
  appointmentType: AppointmentType;
  tx?: Tx;
  preplanned?: PreplannedEarningsContext | null;
}

export interface PreplannedEarningsContext {
  resolvedPayment: ResolvedEarningsPayment;
  anchor: {
    lastOccurrenceEndsAt: Date | null;
    appointmentOccurrenceId: string | null;
  };
  orgSplit: OrgEarningsSplit | null;
  parkForTrust: boolean;
  splits: RevenueSplit[];
  collabSettlements: Map<
    string,
    { sharePaise: number; orgSplit: OrgEarningsSplit }
  >;
  tranches: SubscriptionTranches | null;
  legs: Array<{ source: string; amountPaise: number }>;
  walletLegOrgId: string | null;
  orgOverageSurchargePaise: number;
}

// ============================================
// Status transition guard (#700 LED-2)
// ============================================
// The transition predicate lives in its own file so consumers (esp.
// unit tests) can import it without dragging in earnings-service's
// transitive Stream / Razorpay deps. We re-export here for ergonomics
// at existing call sites.
export {
  IllegalEarningStatusTransitionError,
  assertEarningStatusTransitionLegal,
} from "./earning-status";
import { allocateCycleClawback } from "./earnings-reversal";
import { prorate, sumPaise } from "@/lib/payments/utils/money";
import {
  sessionsTotalOf,
  subscriptionTranches,
  type SubscriptionTranches,
} from "@/lib/booking/entitlement";

import {
  applyCappedEarningReversal,
  applyCappedOrgEarningReversal,
  REFUNDABLE_UNPAID_EARNING_SOURCE,
} from "@/lib/payments/payouts/earning-reversal-cas";

/**
 * #1766 — the cycle shape a subscription's earnings are split into: one
 * PENDING tranche per cycle, stamped by the completion path when the cycle's
 * last session completes. Null for anything that is not a subscription with
 * a plan, so the caller falls back to the single whole-purchase row.
 */
async function resolveSubscriptionTranches(
  tx: Tx | typeof prisma,
  appointmentId: string | null | undefined,
): Promise<SubscriptionTranches | null> {
  if (!appointmentId) return null;
  const appointment = await tx.appointment.findUnique({
    where: { id: appointmentId },
    select: {
      subscription: {
        select: {
          sessionsTotal: true,
          subscriptionPlan: {
            select: {
              totalSessions: true,
              sessionsPerWeek: true,
              durationInMonths: true,
            },
          },
        },
      },
    },
  });
  const sub = appointment?.subscription;
  if (!sub) return null;
  const tranches = subscriptionTranches(
    sub.subscriptionPlan,
    sessionsTotalOf(sub),
  );
  return tranches.total > 0 ? tranches : null;
}

// ============================================
// Org Split Resolution
// ============================================

/**
 * #1335 — the rate card's plan vocabulary, keyed by the settlement's own.
 *
 * Written as an exhaustive `Record` rather than a cast so a new
 * `AppointmentType` or a renamed `CoveredPlanType` member is a compile error
 * here instead of a booking that silently settles on the wrong card.
 */
const RATE_CARD_PLAN_TYPE: Record<AppointmentType, CoveredPlanType> = {
  CONSULTATION: "CONSULTATION",
  WEBINAR: "WEBINAR",
  SUBSCRIPTION: "SUBSCRIPTION",
  CLASS: "CLASS",
};

/**
 * #1335 — the Contract governing this booking's settlement, or null.
 *
 * The only link a settling payment has to a `Contract` is the org-funded one:
 * `BookingUtilization` (unique on `paymentId`) → `ProgramAssignment` →
 * `Program` → `Contract`. A marketplace or self-funded booking has no contract
 * at all, and a SUBSCRIPTION meters its utilization at slot-allocation time,
 * which is after settlement, so it has none yet either. Both cases resolve
 * null and fall through to org scope.
 *
 * The contract is forwarded ONLY when it belongs to the settling org. A
 * contract-scoped card is created under `POST /organizations/{orgId}/rate-cards`
 * with the contract checked against that org, so `ownerContractId` alone
 * identifies its owner — and `resolveEffectiveRateCard` matches
 * `ownerContractId` without re-asserting the org. Forwarding a sponsor's
 * contract into a different host org's settlement would therefore pay one
 * tenant's booking on another tenant's negotiated split. The guard can only
 * ever select fewer cards, never a wrong-tenant one.
 */
async function resolveSettlementContractId(
  tx: Tx | typeof prisma,
  paymentId: string,
  orgId: string,
): Promise<string | null> {
  const utilization = await tx.bookingUtilization.findUnique({
    where: { paymentId },
    select: {
      programAssignment: {
        select: {
          program: {
            select: {
              contract: { select: { id: true, organizationId: true } },
            },
          },
        },
      },
    },
  });
  const contract = utilization?.programAssignment.program.contract;
  return contract?.organizationId === orgId ? contract.id : null;
}

/**
 * Determine if a consultant's payment should use a 3-way org split.
 *
 * Returns an OrgEarningsSplit if the consultant is an active EXPERT
 * membership at a canHost org. Returns null for independent consultants
 * or when the HOST-orgs feature flag is off.
 *
 * For multi-org consultants the OWNING org wins when the plan has one — an
 * org that publishes a plan through its catalog is the seller, so it must be
 * the org that gets paid for it. Without that, an expert who is EXPERT at two
 * host orgs sends Org B's catalog revenue to Org A purely because they joined
 * Org A first. That was unreachable until the org catalog could set
 * `Plan.organizationId`; it is reachable now.
 *
 * With no owning org (a personal B2C plan) the previous rule stands: the
 * oldest active canHost membership. ADR 18 records that as known-crude, and it
 * remains the fallback rather than the primary rule.
 */
async function resolveOrgSplit(
  tx: Tx | typeof prisma,
  consultantProfileId: string,
  grossAmount: number,
  /** Point in time at which the rate card is resolved. Default = now(),
   *  but callers processing a historical payment MUST pass
   *  `payment.createdAt` — otherwise a retroactive rate bump on the org
   *  would silently rewrite what the consultant was owed for bookings
   *  made before the bump. */
  at: Date = new Date(),
  /** The booked plan, when it is one of the two org-ownable kinds. Read
   *  inside this transaction rather than by the caller, so plan ownership and
   *  the earnings rows it decides are read and written under one snapshot. */
  plan: { id: string; kind: "webinar" | "class" } | null = null,
  /** #1335 — the booking this split settles, used only to widen the rate-card
   *  lookup beyond org scope when `RATE_CARD_SCOPED_RESOLUTION` is on. Null on
   *  the collaborator leg: ADR 18 makes collaborations org-blind, so the
   *  seller's contract and plan must not reach a collaborator's own org card. */
  booking: {
    paymentId: string;
    appointmentType: AppointmentType;
  } | null = null,
): Promise<OrgEarningsSplit | null> {
  if (!ENABLE_HOST_ORGS) return null;

  // Only Webinar and Class can be org-owned — Consultation and Subscription
  // require a consultantProfileId, so an org can never solely own one.
  const ownerOrgId = plan
    ? ((
        await (plan.kind === "webinar"
          ? tx.webinarPlan.findUnique({
              where: { id: plan.id },
              select: { organizationId: true },
            })
          : tx.classPlan.findUnique({
              where: { id: plan.id },
              select: { organizationId: true },
            }))
      )?.organizationId ?? null)
    : null;

  // Arch-4: Membership where role=EXPERT and parent org canHost=true.
  // Rate card resolved via the time-scoped resolver at the booking instant.
  //
  // The owning org is tried FIRST. The membership still has to exist and be
  // ACTIVE at a canHost org — an org cannot direct earnings to itself for
  // someone who is not its expert, and the catalog endpoint enforces the same
  // thing at publish time.
  const membership =
    (ownerOrgId
      ? await tx.membership.findFirst({
          where: {
            consultantProfileId,
            role: "EXPERT",
            status: "ACTIVE",
            organizationId: ownerOrgId,
            organization: { canHost: true, status: "ACTIVE" },
          },
          include: { organization: { select: { id: true } } },
        })
      : null) ??
    // Fallback: oldest membership wins, so multi-org consultants selling their
    // OWN plans route deterministically to the same org.
    (await tx.membership.findFirst({
      where: {
        consultantProfileId,
        role: "EXPERT",
        status: "ACTIVE",
        organization: { canHost: true, status: "ACTIVE" },
      },
      orderBy: { createdAt: "asc" },
      include: { organization: { select: { id: true } } },
    }));

  if (!membership) return null;

  const orgId = membership.organization.id;
  const payoutRecipient = membership.payoutRecipient;

  const { resolveEffectiveRateCard, isScopedRateCardResolutionEnabled } =
    await import("@/lib/api/organizations/rate-card");

  // #1335 — the resolver has always ranked contract- and plan-scoped cards
  // above the org default, but settlement only ever handed it the org, so
  // those tiers were unreachable and a scoped card could be created and never
  // chosen. Forwarding the scope changes which card settles live money, so it
  // is gated: off, this is the pre-#1335 call verbatim.
  const scoped =
    booking && isScopedRateCardResolutionEnabled()
      ? {
          contractId: await resolveSettlementContractId(
            tx,
            booking.paymentId,
            orgId,
          ),
          planType: RATE_CARD_PLAN_TYPE[booking.appointmentType],
          // Only Webinar and Class carry a plan id into settlement. A
          // consultation- or subscription-plan-scoped card therefore still
          // resolves at planType granularity, not plan granularity.
          planId: plan?.id ?? null,
        }
      : {};

  const resolved = await resolveEffectiveRateCard(tx, {
    orgId,
    membershipOverrideId: membership.rateCardOverrideId,
    at,
    ...scoped,
  });

  // Integer paise × basis-point math, no float drift.
  const platformFeePaise = Math.floor(
    (grossAmount * resolved.platformBps) / 10_000,
  );
  const consultantSharePaise = Math.floor(
    (grossAmount * resolved.consultantBps) / 10_000,
  );
  const orgShare = grossAmount - platformFeePaise - consultantSharePaise;

  const base = {
    organizationId: orgId,
    rateCardIdApplied: resolved.rateCardId,
    platformBps: resolved.platformBps,
    orgBps: resolved.orgBps,
    consultantBps: resolved.consultantBps,
    payoutRecipient,
  };

  if (payoutRecipient === "ORGANIZATION") {
    // Internal/salaried consultant: org absorbs the consultant slice, so the
    // persisted bps say so too (#1584 P1-EC01 — the snapshot was self-inconsistent).
    return {
      ...base,
      orgBps: base.orgBps + base.consultantBps,
      consultantBps: 0,
      platformFeePaise,
      orgShare: grossAmount - platformFeePaise,
      consultantSharePaise: 0,
    };
  }

  if (orgShare < 0) {
    reportSentryError(
      new Error(
        `[Earnings] Negative orgShare (${orgShare}) for org ${orgId}: platformBps=${resolved.platformBps}, consultantBps=${resolved.consultantBps}. Clamping.`,
      ),
      { subsystem: "payments", level: "warning" },
    );
    console.error(
      `[Earnings] Negative orgShare (${orgShare}) for org ${orgId}: ` +
        `platformBps=${resolved.platformBps}, consultantBps=${resolved.consultantBps}. Clamping.`,
    );
    return {
      ...base,
      platformFeePaise,
      orgShare: 0,
      consultantSharePaise: grossAmount - platformFeePaise,
    };
  }

  return {
    ...base,
    platformFeePaise,
    orgShare,
    consultantSharePaise,
  };
}

// ============================================
// Earnings Service Functions
// ============================================

const APPOINTMENT_TYPE_NORMALIZE: Record<
  "CONSULTATION" | "SUBSCRIPTION" | "WEBINAR" | "CLASS" | "TRIAL",
  AppointmentType
> = {
  CONSULTATION: "CONSULTATION",
  SUBSCRIPTION: "SUBSCRIPTION",
  WEBINAR: "WEBINAR",
  CLASS: "CLASS",
  TRIAL: "SUBSCRIPTION",
};

const rawEarningsAppointmentTypeSchema = z
  .enum(["CONSULTATION", "SUBSCRIPTION", "WEBINAR", "CLASS", "TRIAL"])
  .transform((t): AppointmentType => APPOINTMENT_TYPE_NORMALIZE[t])
  .catch("CONSULTATION");

export interface ResolvedEarningsPayment {
  paymentForEarnings: CreateEarningsParams["payment"];
  earningsAppointmentType: AppointmentType;
  consultantProfileId: string;
}

/**
 * #1439 — the webhook success path and the checkout mock/zero/sponsored path
 * both create earnings straight after confirming a payment, and both need
 * the same appointment -> consultantProfile resolution across the four plan
 * kinds. Shared here so the include and the profile-selection precedence
 * can't drift between the two call sites. Returns null when there is no
 * appointment or no resolvable consultant profile — the caller skips
 * earnings creation in that case, same as before this was extracted.
 */
export async function resolvePaymentForEarnings(
  where: Prisma.PaymentWhereUniqueInput,
  rawAppointmentType: string,
  db: Tx | typeof prisma = prisma,
): Promise<ResolvedEarningsPayment | null> {
  const paymentWithAppointment = await db.payment.findUnique({
    where,
    include: {
      appointment: {
        include: {
          consultation: {
            include: {
              consultationPlan: {
                include: { consultantProfile: true },
              },
            },
          },
          subscription: {
            include: {
              subscriptionPlan: {
                include: { consultantProfile: true },
              },
            },
          },
          webinar: {
            select: {
              id: true,
              webinarPlanId: true,
              webinarPlan: {
                include: { consultantProfile: true },
              },
            },
          },
          class: {
            select: {
              id: true,
              classPlanId: true,
              classPlan: {
                include: { consultantProfile: true },
              },
            },
          },
          // #1775 C-9 — a paid trial has no consultation/subscription row.
          trial: {
            select: {
              id: true,
              subscriptionPlan: { include: { consultantProfile: true } },
            },
          },
        },
      },
    },
  });

  if (!paymentWithAppointment?.appointment) return null;

  const consultantProfile =
    paymentWithAppointment.appointment.consultation?.consultationPlan
      ?.consultantProfile ||
    paymentWithAppointment.appointment.subscription?.subscriptionPlan
      ?.consultantProfile ||
    paymentWithAppointment.appointment.webinar?.webinarPlan
      ?.consultantProfile ||
    paymentWithAppointment.appointment.class?.classPlan?.consultantProfile ||
    paymentWithAppointment.appointment.trial?.subscriptionPlan
      ?.consultantProfile;

  if (!consultantProfile) return null;

  const earningsAppointmentType =
    rawEarningsAppointmentTypeSchema.parse(rawAppointmentType);

  const paymentForEarnings: CreateEarningsParams["payment"] = {
    ...paymentWithAppointment,
    appointment: {
      consultantProfile: { id: consultantProfile.id },
      webinar: paymentWithAppointment.appointment.webinar
        ? {
            webinarPlanId:
              paymentWithAppointment.appointment.webinar.webinarPlanId,
          }
        : null,
      class: paymentWithAppointment.appointment.class
        ? {
            classPlanId: paymentWithAppointment.appointment.class.classPlanId,
          }
        : null,
      trial: paymentWithAppointment.appointment.trial
        ? { id: paymentWithAppointment.appointment.trial.id }
        : null,
    },
  };

  return {
    paymentForEarnings,
    earningsAppointmentType,
    consultantProfileId: consultantProfile.id,
  };
}

/**
 * #1758 — Pre-transaction planner that reads rate card, consultant profile,
 * collaborator splits, trust-park status, subscription tranches, and payment
 * legs BEFORE opening the Phase-1 Serializable transaction so Phase 1 can
 * write ConsultantEarnings + OrganizationEarnings + the `booking:<paymentId>`
 * journal atomically alongside appointment confirmation without ballooning
 * Serializable lock hold times.
 */
function resolvePlanScope(
  appointmentType: string,
  appointment:
    | {
        webinar?: { webinarPlanId: string } | null;
        class?: { classPlanId: string } | null;
      }
    | null
    | undefined,
): {
  planType: "webinar" | "class" | null;
  planId: string | null;
  scope: { id: string; kind: "webinar" | "class" } | null;
} {
  if (appointmentType === "WEBINAR" && appointment?.webinar) {
    const planId = appointment.webinar.webinarPlanId;
    return {
      planType: "webinar",
      planId,
      scope: planId ? { id: planId, kind: "webinar" } : null,
    };
  }
  if (appointmentType === "CLASS" && appointment?.class) {
    const planId = appointment.class.classPlanId;
    return {
      planType: "class",
      planId,
      scope: planId ? { id: planId, kind: "class" } : null,
    };
  }
  return { planType: null, planId: null, scope: null };
}

async function checkSponsorTrustPark(
  db: Tx | typeof prisma,
  payment: {
    organizationId?: string | null;
    billingAccountId?: string | null;
  },
): Promise<boolean> {
  const sponsorOrgId = payment.organizationId;
  if (
    !sponsorOrgId ||
    !payment.billingAccountId ||
    typeof db.billingAccount?.findUnique !== "function" ||
    typeof db.organization?.findUnique !== "function"
  ) {
    return false;
  }
  const billingAccount = await db.billingAccount.findUnique({
    where: { id: payment.billingAccountId },
    select: { fundingSource: true },
  });
  if (billingAccount?.fundingSource !== "INVOICE") {
    return false;
  }
  const sponsorOrg = await db.organization.findUnique({
    where: { id: sponsorOrgId },
    select: { status: true },
  });
  if (sponsorOrg?.status !== "PENDING_VERIFICATION") {
    return false;
  }
  const paidInvoiceCount = await db.organizationInvoice.count({
    where: { organizationId: sponsorOrgId, status: "PAID" },
  });
  return paidInvoiceCount === 0;
}

async function resolveInTxTrustPark(
  tx: Tx,
  payment: {
    organizationId?: string | null;
    billingAccountId?: string | null;
  },
  preplanned?: PreplannedEarningsContext | null,
): Promise<boolean> {
  if (
    typeof tx.billingAccount?.findUnique === "function" &&
    typeof tx.organization?.findUnique === "function"
  ) {
    return checkSponsorTrustPark(tx, payment);
  }
  return preplanned?.parkForTrust ?? false;
}

async function planCollaboratorSettlements(
  db: Tx | typeof prisma,
  splits: RevenueSplit[],
  _primaryOrgSplit: OrgEarningsSplit | null,
  createdAt: Date,
  _logCollisionPaymentId?: string,
): Promise<Map<string, { sharePaise: number; orgSplit: OrgEarningsSplit }>> {
  const collabSettlements = new Map<
    string,
    { sharePaise: number; orgSplit: OrgEarningsSplit }
  >();
  const collabSplits = splits.filter((s) => s.role !== "OWNER" && s.share > 0);
  if (collabSplits.length === 0) return collabSettlements;

  for (const split of collabSplits) {
    const collabOrgSplit = await resolveOrgSplit(
      // NOSONAR
      db,
      split.consultantProfileId,
      split.share,
      createdAt,
    );
    if (!collabOrgSplit) continue;
    collabSettlements.set(split.consultantProfileId, {
      sharePaise: split.share,
      orgSplit: collabOrgSplit,
    });
  }
  return collabSettlements;
}

async function resolvePlannedWalletAndOverage(
  db: Tx | typeof prisma,
  payment: {
    id: string;
    originalAmount?: number;
    taxAmount?: number | null;
    organizationId?: string | null;
    billingAccountId?: string | null;
  },
  legs: PreplannedEarningsContext["legs"],
): Promise<{
  walletLegOrgId: string | null;
  orgOverageSurchargePaise: number;
}> {
  let wallet = 0;
  let overageAccrualPaise = 0;
  for (const leg of legs) {
    if (leg.amountPaise <= 0) continue;
    if (leg.source === "WALLET") wallet += leg.amountPaise;
    if (leg.source === "OVERAGE_INVOICE_ACCRUAL") {
      overageAccrualPaise += leg.amountPaise;
    }
  }

  let walletLegOrgId: string | null = payment.organizationId ?? null;
  if (!walletLegOrgId && wallet > 0 && payment.billingAccountId) {
    const walletOwner = await db.billingAccount.findUnique({
      where: { id: payment.billingAccountId },
      select: { ownerOrgId: true },
    });
    walletLegOrgId = walletOwner?.ownerOrgId ?? null;
  }

  const nominalTotal =
    payment.originalAmount !== undefined
      ? payment.originalAmount + (payment.taxAmount ?? 0)
      : wallet;
  let orgOverageSurchargePaise = 0;
  if (overageAccrualPaise > 0 || wallet > nominalTotal) {
    const orgOverage = await db.overageEvent.findFirst({
      where: {
        bookingUtilization: { paymentId: payment.id },
        overageBehavior: "CHARGE_ORG",
      },
      select: { surchargePaise: true },
    });
    orgOverageSurchargePaise = sumPaise(orgOverage?.surchargePaise);
  }

  return { walletLegOrgId, orgOverageSurchargePaise };
}

export async function planEarningsForPayment(
  whereOrId: string | Prisma.PaymentWhereUniqueInput,
  rawAppointmentType: string = "CONSULTATION",
  db: Tx | typeof prisma = prisma,
): Promise<PreplannedEarningsContext | null> {
  const where: Prisma.PaymentWhereUniqueInput =
    typeof whereOrId === "string" ? { id: whereOrId } : whereOrId;
  const resolvedPayment = await resolvePaymentForEarnings(
    where,
    rawAppointmentType,
    db,
  );
  if (!resolvedPayment) return null;

  const {
    paymentForEarnings: payment,
    earningsAppointmentType: appointmentType,
    consultantProfileId,
  } = resolvedPayment;
  const grossAmount = payment.originalAmount;
  const { planType, planId, scope } = resolvePlanScope(
    appointmentType,
    payment.appointment,
  );

  const anchor = await resolveEarningsAnchor(
    db,
    payment.appointmentId,
    appointmentType,
  );

  const orgSplit = await resolveOrgSplit(
    db,
    consultantProfileId,
    grossAmount,
    payment.createdAt,
    scope,
    { paymentId: payment.id, appointmentType },
  );

  const parkForTrust = await checkSponsorTrustPark(db, payment);

  const platformFeePaise = orgSplit
    ? orgSplit.platformFeePaise
    : await planB2cPlatformFeePaise(
        db,
        payment,
        consultantProfileId,
        grossAmount,
      );
  const totalConsultantPool = orgSplit
    ? orgSplit.consultantSharePaise
    : grossAmount - platformFeePaise;

  const splits =
    planType && planId
      ? await calculateRevenueSplit(planType, planId, totalConsultantPool, db, {
          excludeBuyerUserId: payment.userId,
        })
      : [];

  const collabSettlements = await planCollaboratorSettlements(
    db,
    splits,
    orgSplit,
    payment.createdAt,
  );

  const tranches =
    splits.length === 0 && appointmentType === "SUBSCRIPTION"
      ? await resolveSubscriptionTranches(db, payment.appointmentId)
      : null;

  const legs = await db.paymentLeg.findMany({
    where: { paymentId: payment.id },
    select: { source: true, amountPaise: true },
  });

  const { walletLegOrgId, orgOverageSurchargePaise } =
    await resolvePlannedWalletAndOverage(db, payment, legs);

  return {
    resolvedPayment,
    anchor,
    orgSplit,
    parkForTrust,
    splits,
    collabSettlements,
    tranches,
    legs,
    walletLegOrgId,
    orgOverageSurchargePaise,
  };
}

function computeShareBpsList(
  splits: RevenueSplit[],
  totalConsultantPool: number,
): number[] {
  const shareBpsList = splits.map((s) =>
    totalConsultantPool > 0
      ? Math.floor((s.share / totalConsultantPool) * 10_000)
      : 0,
  );
  if (totalConsultantPool > 0 && shareBpsList.length > 0) {
    const assigned = shareBpsList.reduce((a, b) => a + b, 0);
    shareBpsList[shareBpsList.length - 1] += 10_000 - assigned;
  }
  return shareBpsList;
}

async function createMultiPartyConsultantEarnings(
  tx: Tx,
  params: {
    splits: RevenueSplit[];
    totalConsultantPool: number;
    collabSettlements: Map<
      string,
      { sharePaise: number; orgSplit: OrgEarningsSplit }
    >;
    paymentId: string;
    grossAmount: number;
    platformFeePaise: number;
    appointmentOccurrenceId: string | null;
    initialEarningStatus: EarningStatus;
    holdUntil: Date | null;
    orgSplit: OrgEarningsSplit | null;
  },
): Promise<string | null> {
  const {
    splits,
    totalConsultantPool,
    collabSettlements,
    paymentId,
    grossAmount,
    platformFeePaise,
    appointmentOccurrenceId,
    initialEarningStatus,
    holdUntil,
    orgSplit,
  } = params;

  const shareBpsList = computeShareBpsList(splits, totalConsultantPool);
  const hostSplitNote = orgSplit ? " [HOST 3-way split]" : "";
  let ownerId: string | null = null;

  for (let i = 0; i < splits.length; i++) {
    const split = splits[i];
    const isOwner = split.role === "OWNER";
    const settlement = isOwner
      ? undefined
      : collabSettlements.get(split.consultantProfileId);
    const creditedShare = settlement
      ? settlement.orgSplit.consultantSharePaise
      : split.share;
    const splitPlatformFee = isOwner
      ? platformFeePaise
      : (settlement?.orgSplit.platformFeePaise ?? 0);
    const earnings = await tx.consultantEarnings.create({
      data: {
        consultantProfileId: split.consultantProfileId,
        paymentId,
        grossAmount: isOwner ? grossAmount : 0,
        platformFeePaise: splitPlatformFee,
        consultantSharePaise: creditedShare,
        role: isOwner ? EarningRole.OWNER : EarningRole.COLLABORATOR,
        shareBps: shareBpsList[i],
        appointmentOccurrenceId,
        status: initialEarningStatus,
        holdUntil,
        currency: "INR",
      },
    });
    if (isOwner) {
      ownerId = earnings.id;
    }
    const collabSettledNote = settlement ? " [collab org-settled]" : "";
    console.log(
      `Earnings created for ${split.role} (${split.consultantProfileId}): ${creditedShare / 100} from payment ${paymentId}${hostSplitNote}${collabSettledNote}`,
    );
  }
  return ownerId;
}

async function resolveEffectiveTranches(
  tx: Tx,
  appointmentType: AppointmentType,
  appointmentId: string | null,
  preplanned?: PreplannedEarningsContext | null,
): Promise<PreplannedEarningsContext["tranches"]> {
  if (preplanned !== null && preplanned !== undefined) {
    return preplanned.tranches;
  }
  if (appointmentType === "SUBSCRIPTION") {
    return resolveSubscriptionTranches(tx, appointmentId);
  }
  return null;
}

async function createSingleOwnerConsultantEarnings(
  tx: Tx,
  params: {
    consultantProfileId: string;
    paymentId: string;
    grossAmount: number;
    platformFeePaise: number;
    totalConsultantPool: number;
    appointmentOccurrenceId: string | null;
    initialEarningStatus: EarningStatus;
    holdUntil: Date | null;
    tranches: PreplannedEarningsContext["tranches"];
  },
): Promise<string> {
  const {
    consultantProfileId,
    paymentId,
    grossAmount,
    platformFeePaise,
    totalConsultantPool,
    appointmentOccurrenceId,
    initialEarningStatus,
    holdUntil,
    tranches,
  } = params;

  if (tranches) {
    const perTranche = (k: number) => ({
      gross: prorate(grossAmount, tranches.capacityOf(k), tranches.total),
      fee: prorate(platformFeePaise, tranches.capacityOf(k), tranches.total),
      share: prorate(
        totalConsultantPool,
        tranches.capacityOf(k),
        tranches.total,
      ),
    });
    const tail = Array.from({ length: tranches.count - 1 }, (_, i) =>
      perTranche(i + 1),
    );
    const sumOf = (key: "gross" | "fee" | "share") =>
      tail.reduce((acc, t) => acc + t[key], 0);
    const rows = [
      {
        gross: grossAmount - sumOf("gross"),
        fee: platformFeePaise - sumOf("fee"),
        share: totalConsultantPool - sumOf("share"),
      },
      ...tail,
    ];
    const trancheData = (
      k: number,
      row: { gross: number; fee: number; share: number },
    ) => ({
      consultantProfileId,
      paymentId,
      grossAmount: row.gross,
      platformFeePaise: row.fee,
      consultantSharePaise: row.share,
      appointmentOccurrenceId,
      cycleOrdinal: k,
      status: initialEarningStatus,
      holdUntil: null,
      currency: "INR" as const,
    });
    const first = await tx.consultantEarnings.create({
      data: trancheData(0, rows[0]),
    });
    if (rows.length > 1) {
      await tx.consultantEarnings.createMany({
        data: rows.slice(1).map((row, i) => trancheData(i + 1, row)),
      });
    }
    return first.id;
  }

  const earnings = await tx.consultantEarnings.create({
    data: {
      consultantProfileId,
      paymentId,
      grossAmount,
      platformFeePaise,
      consultantSharePaise: totalConsultantPool,
      appointmentOccurrenceId,
      status: initialEarningStatus,
      holdUntil,
      currency: "INR",
    },
  });
  return earnings.id;
}

async function createPrimaryAndCollabOrgEarnings(
  tx: Tx,
  params: {
    consultantProfileId: string;
    orgSplit: OrgEarningsSplit | null;
    collabSettlements: Map<
      string,
      { sharePaise: number; orgSplit: OrgEarningsSplit }
    >;
    paymentId: string;
    grossAmount: number;
    initialEarningStatus: EarningStatus;
    holdUntil: Date | null;
  },
): Promise<void> {
  const {
    consultantProfileId,
    orgSplit,
    collabSettlements,
    paymentId,
    grossAmount,
    initialEarningStatus,
    holdUntil,
  } = params;

  if (orgSplit && orgSplit.orgShare > 0) {
    await tx.organizationEarnings.create({
      data: {
        organizationId: orgSplit.organizationId,
        paymentId,
        consultantProfileId,
        role: EarningRole.OWNER,
        grossAmountPaise: grossAmount,
        platformFeePaise: orgSplit.platformFeePaise,
        orgSharePaise: orgSplit.orgShare,
        consultantSharePaise: orgSplit.consultantSharePaise,
        refundedAmountPaise: 0,
        status: initialEarningStatus,
        holdUntil,
        currency: "INR",
        rateCardIdApplied: orgSplit.rateCardIdApplied,
        platformBpsApplied: orgSplit.platformBps,
        orgBpsApplied: orgSplit.orgBps,
        consultantBpsApplied: orgSplit.consultantBps,
      },
    });
    console.log(
      `Org earnings created for ${orgSplit.organizationId}: org=${orgSplit.orgShare / 100} consultant=${orgSplit.consultantSharePaise / 100} (recipient=${orgSplit.payoutRecipient}) from payment ${paymentId}`,
    );
  } else if (orgSplit?.orgShare === 0) {
    console.log(
      `Platform-only mode for ${orgSplit.organizationId}: skipping 0-value org earnings for payment ${paymentId}`,
    );
  }

  for (const [collabProfileId, s] of Array.from(collabSettlements.entries())) {
    if (s.orgSplit.orgShare <= 0) {
      console.log(
        `Platform-only mode for collaborator org ${s.orgSplit.organizationId}: skipping 0-value org earnings for payment ${paymentId}`,
      );
      continue;
    }
    await tx.organizationEarnings.create({
      data: {
        organizationId: s.orgSplit.organizationId,
        paymentId,
        consultantProfileId: collabProfileId,
        role: EarningRole.COLLABORATOR,
        grossAmountPaise: s.sharePaise,
        platformFeePaise: s.orgSplit.platformFeePaise,
        orgSharePaise: s.orgSplit.orgShare,
        consultantSharePaise: s.orgSplit.consultantSharePaise,
        refundedAmountPaise: 0,
        status: initialEarningStatus,
        holdUntil,
        currency: "INR",
        rateCardIdApplied: s.orgSplit.rateCardIdApplied,
        platformBpsApplied: s.orgSplit.platformBps,
        orgBpsApplied: s.orgSplit.orgBps,
        consultantBpsApplied: s.orgSplit.consultantBps,
      },
    });
    console.log(
      `Collaborator org earnings created for ${s.orgSplit.organizationId} (collab ${collabProfileId}): org=${s.orgSplit.orgShare / 100} consultant=${s.orgSplit.consultantSharePaise / 100} from payment ${paymentId}`,
    );
  }
}

function tallyPaymentLegsBySource(
  legs: ReadonlyArray<{ source: string; amountPaise: number }>,
) {
  let card = 0;
  let wallet = 0;
  let receivable = 0;
  let promo = 0;
  let overageAccrualPaise = 0;
  for (const leg of legs) {
    if (leg.amountPaise <= 0) continue;
    switch (leg.source) {
      case "CARD":
        card += leg.amountPaise;
        break;
      case "WALLET":
        wallet += leg.amountPaise;
        break;
      case "INVOICE_ACCRUAL":
        receivable += leg.amountPaise;
        break;
      case "OVERAGE_INVOICE_ACCRUAL":
        receivable += leg.amountPaise;
        overageAccrualPaise += leg.amountPaise;
        break;
      case "REFERRAL_CREDIT":
        promo += leg.amountPaise;
        break;
      default:
        break;
    }
  }
  return { card, wallet, receivable, promo, overageAccrualPaise };
}

async function resolveBookingJournalDebits(
  tx: Tx,
  payment: CreateEarningsParams["payment"],
  preplanned?: PreplannedEarningsContext | null,
): Promise<{
  debits: Posting[];
  overageAccrualPaise: number;
  hasWalletSurcharge: boolean;
}> {
  const liveLegs =
    typeof tx.paymentLeg?.findMany === "function"
      ? await tx.paymentLeg.findMany({
          where: { paymentId: payment.id },
          select: { source: true, amountPaise: true },
        })
      : undefined;
  const legs = Array.isArray(liveLegs) ? liveLegs : (preplanned?.legs ?? []);
  const orgId = payment.organizationId ?? null;
  let overageAccrualPaise = 0;
  let hasWalletSurcharge = false;
  const debits: Posting[] = [];
  const pushDebit = (account: AccountRef, amountPaise: number) => {
    if (amountPaise > 0) {
      debits.push({ account, direction: "DEBIT", amountPaise });
    }
  };

  if (legs.length > 0) {
    const tallied = tallyPaymentLegsBySource(legs);
    overageAccrualPaise = tallied.overageAccrualPaise;
    hasWalletSurcharge =
      tallied.wallet > payment.originalAmount + (payment.taxAmount ?? 0);
    pushDebit({ kind: "CASH" }, tallied.card);

    let walletLegOrgId = orgId;
    if (!walletLegOrgId && tallied.wallet > 0 && payment.billingAccountId) {
      walletLegOrgId = preplanned
        ? preplanned.walletLegOrgId
        : ((
            await tx.billingAccount.findUnique({
              where: { id: payment.billingAccountId },
              select: { ownerOrgId: true },
            })
          )?.ownerOrgId ?? null);
    }
    pushDebit(
      { kind: "WALLET", organizationId: walletLegOrgId },
      tallied.wallet,
    );
    pushDebit(
      { kind: "ORG_RECEIVABLE", organizationId: orgId },
      tallied.receivable,
    );
    pushDebit({ kind: "PLATFORM_PROMO" }, tallied.promo);
  } else {
    pushDebit({ kind: "CASH" }, payment.amount);
  }

  const fundingDebitTotal = debits.reduce((s, d) => s + d.amountPaise, 0);
  pushDebit(
    { kind: "DISCOUNT" },
    Math.max(
      0,
      payment.originalAmount + (payment.taxAmount ?? 0) - fundingDebitTotal,
    ),
  );
  return { debits, overageAccrualPaise, hasWalletSurcharge };
}

async function resolveOverageSurchargeForCredits(
  tx: Tx,
  paymentId: string,
  overageAccrualPaise: number,
  hasWalletSurcharge: boolean,
  preplanned?: PreplannedEarningsContext | null,
): Promise<number> {
  if (overageAccrualPaise <= 0 && !hasWalletSurcharge) return 0;
  if (
    typeof tx.overageEvent?.findFirst === "function" &&
    (!preplanned || preplanned.orgOverageSurchargePaise === 0)
  ) {
    const orgOverage = await tx.overageEvent.findFirst({
      where: {
        bookingUtilization: { paymentId },
        overageBehavior: "CHARGE_ORG",
      },
      select: { surchargePaise: true },
    });
    return sumPaise(orgOverage?.surchargePaise);
  }
  return preplanned?.orgOverageSurchargePaise ?? 0;
}

async function resolveBookingJournalCredits(
  tx: Tx,
  params: {
    payment: CreateEarningsParams["payment"];
    consultantProfileId: string;
    platformFeePaise: number;
    totalConsultantPool: number;
    orgSplit: OrgEarningsSplit | null;
    splits: RevenueSplit[];
    collabSettlements: Map<
      string,
      { sharePaise: number; orgSplit: OrgEarningsSplit }
    >;
    overageAccrualPaise: number;
    hasWalletSurcharge: boolean;
    preplanned?: PreplannedEarningsContext | null;
  },
): Promise<Posting[]> {
  const {
    payment,
    consultantProfileId,
    platformFeePaise,
    totalConsultantPool,
    orgSplit,
    splits,
    collabSettlements,
    overageAccrualPaise,
    hasWalletSurcharge,
    preplanned,
  } = params;

  const credits: Posting[] = [];
  const pushCredit = (account: AccountRef, amountPaise: number) => {
    if (amountPaise > 0) {
      credits.push({ account, direction: "CREDIT", amountPaise });
    }
  };

  let platformFeeCreditPaise = platformFeePaise;
  for (const s of Array.from(collabSettlements.values())) {
    platformFeeCreditPaise += s.orgSplit.platformFeePaise;
  }
  platformFeeCreditPaise += await resolveOverageSurchargeForCredits(
    tx,
    payment.id,
    overageAccrualPaise,
    hasWalletSurcharge,
    preplanned,
  );
  pushCredit({ kind: "PLATFORM_FEE" }, platformFeeCreditPaise);

  if (splits.length > 0) {
    for (const split of splits) {
      const settlement =
        split.role === "OWNER"
          ? undefined
          : collabSettlements.get(split.consultantProfileId);
      pushCredit(
        {
          kind: "CONSULTANT_PAYABLE",
          consultantProfileId: split.consultantProfileId,
        },
        settlement ? settlement.orgSplit.consultantSharePaise : split.share,
      );
    }
  } else {
    pushCredit(
      { kind: "CONSULTANT_PAYABLE", consultantProfileId },
      totalConsultantPool,
    );
  }

  if (orgSplit && orgSplit.orgShare > 0) {
    pushCredit(
      {
        kind: "ORG_PAYABLE",
        organizationId: orgSplit.organizationId,
      },
      orgSplit.orgShare,
    );
  }
  for (const s of Array.from(collabSettlements.values())) {
    pushCredit(
      {
        kind: "ORG_PAYABLE",
        organizationId: s.orgSplit.organizationId,
      },
      s.orgSplit.orgShare,
    );
  }
  pushCredit({ kind: "GST_PAYABLE" }, payment.taxAmount ?? 0);
  return credits;
}

async function postBookingLedgerJournal(
  tx: Tx,
  params: {
    payment: CreateEarningsParams["payment"];
    consultantProfileId: string;
    platformFeePaise: number;
    totalConsultantPool: number;
    orgSplit: OrgEarningsSplit | null;
    splits: RevenueSplit[];
    collabSettlements: Map<
      string,
      { sharePaise: number; orgSplit: OrgEarningsSplit }
    >;
    preplanned?: PreplannedEarningsContext | null;
  },
): Promise<void> {
  const { payment } = params;
  try {
    const { debits, overageAccrualPaise, hasWalletSurcharge } =
      await resolveBookingJournalDebits(tx, payment, params.preplanned);
    const credits = await resolveBookingJournalCredits(tx, {
      ...params,
      overageAccrualPaise,
      hasWalletSurcharge,
    });
    await postLedgerTxn(tx, {
      idempotencyKey: `booking:${payment.id}`,
      kind: "BOOKING",
      paymentId: payment.id,
      postings: [...debits, ...credits],
    });
  } catch (err) {
    const isRetryableSerialization =
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2034";
    if (!isRetryableSerialization) {
      reportSentryError(err, { subsystem: "payments" });
      console.error(
        `[ledger] booking posting FAILED for payment ${payment.id} — rolling back the booking: ${err instanceof Error ? err.message : String(err)}`,
      );
      void recordSystemErrorSafe({
        organizationId: payment.organizationId ?? null,
        category: "LEDGER",
        summary: `Booking ledger posting failed for payment ${payment.id}`,
        err,
        context: { paymentId: payment.id },
      });
    } else {
      reportSentryError(err, {
        subsystem: "payments",
        expected: true,
      });
    }
    throw err;
  }
}

/** A parked capture funds no booking, so it must never accrue earnings or a booking journal. */
export class ParkedCaptureEarningsError extends Error {
  readonly code = "PARKED_CAPTURE";
  constructor(readonly paymentId: string) {
    super(`Payment ${paymentId} is a parked capture; earnings refused`);
    this.name = "ParkedCaptureEarningsError";
  }
}

/**
 * Create earnings record from a successful payment
 * Called from payment success webhook
 */
export async function createEarningsFromPayment(
  payment: CreateEarningsParams["payment"],
  appointmentTypeArg?: AppointmentType,
  txArg?: Tx,
  preplannedArg?: PreplannedEarningsContext | null,
): Promise<string | null>;
export async function createEarningsFromPayment(
  params: CreateEarningsParams,
): Promise<string | null>;
export async function createEarningsFromPayment(
  paramsOrPayment: CreateEarningsParams | CreateEarningsParams["payment"],
  appointmentTypeArg?: AppointmentType,
  txArg?: Tx,
  preplannedArg?: PreplannedEarningsContext | null,
): Promise<string | null> {
  const normalized: CreateEarningsParams =
    "payment" in paramsOrPayment && "appointmentType" in paramsOrPayment
      ? paramsOrPayment
      : {
          payment: paramsOrPayment,
          appointmentType: appointmentTypeArg ?? "CONSULTATION",
          tx: txArg,
          preplanned: preplannedArg,
        };
  const { payment, appointmentType, tx: outerTx, preplanned } = normalized;
  const hasPreplanned = preplanned !== null && preplanned !== undefined;

  const consultantProfileId = payment.appointment?.consultantProfile?.id;
  if (!consultantProfileId) {
    console.warn(
      `No consultant profile found for payment ${payment.id}. Skipping earnings creation.`,
    );
    return null;
  }

  const grossAmount = payment.originalAmount;
  const anchor = hasPreplanned
    ? preplanned.anchor
    : await resolveEarningsAnchor(
        outerTx ?? prisma,
        payment.appointmentId,
        appointmentType,
      );
  const holdUntil = payment.appointment?.trial
    ? null
    : computeHoldUntil({
        capturedAt: new Date(),
        lastOccurrenceEndsAt: anchor.lastOccurrenceEndsAt,
        holdHours: holdHoursFor(appointmentType),
      });

  const { planType, planId, scope } = resolvePlanScope(
    appointmentType,
    payment.appointment,
  );

  const runInTx = async (tx: Tx): Promise<string | null> => {
    if (await hasUnappliedReceipt(tx, payment.id)) {
      throw new ParkedCaptureEarningsError(payment.id);
    }
    const existingEarnings = await tx.consultantEarnings.findFirst({
      where: { paymentId: payment.id, consultantProfileId },
    });
    if (existingEarnings) {
      console.warn(
        `Earnings already exist for payment ${payment.id}. Skipping.`,
      );
      return existingEarnings.id;
    }

    const orgSplit = hasPreplanned
      ? preplanned.orgSplit
      : await resolveOrgSplit(
          tx,
          consultantProfileId,
          grossAmount,
          payment.createdAt,
          scope,
          { paymentId: payment.id, appointmentType },
        );

    const parkForTrust = await resolveInTxTrustPark(tx, payment, preplanned);
    const initialEarningStatus: EarningStatus = parkForTrust
      ? EarningStatus.PENDING_TRUST
      : EarningStatus.PENDING;

    const splitsFor = (pool: number): Promise<RevenueSplit[]> =>
      planType && planId
        ? calculateRevenueSplit(planType, planId, pool, tx, {
            excludeBuyerUserId: payment.userId,
          })
        : Promise.resolve([]);
    // A multi-party sale never takes a fee waiver, on either path; the split count is pool-independent.
    const multiParty = hasPreplanned
      ? preplanned.splits.length > 0
      : (await splitsFor(0)).length > 0;
    const platformFeePaise = orgSplit
      ? orgSplit.platformFeePaise
      : await settleB2cPlatformFeePaise(
          tx,
          payment,
          consultantProfileId,
          grossAmount,
          { allowWaiver: !multiParty },
        );
    const totalConsultantPool = orgSplit
      ? orgSplit.consultantSharePaise
      : grossAmount - platformFeePaise;

    let splits: RevenueSplit[] = hasPreplanned ? preplanned.splits : [];
    if (!hasPreplanned && multiParty) {
      splits = await splitsFor(totalConsultantPool);
    }

    const collabSettlements = hasPreplanned
      ? new Map(preplanned.collabSettlements)
      : await planCollaboratorSettlements(
          tx,
          splits,
          orgSplit,
          payment.createdAt,
          payment.id,
        );

    const tranches = await resolveEffectiveTranches(
      tx,
      appointmentType,
      payment.appointmentId,
      preplanned,
    );

    let ownerId: string | null = null;
    if (splits.length > 0) {
      ownerId = await createMultiPartyConsultantEarnings(tx, {
        splits,
        totalConsultantPool,
        collabSettlements,
        paymentId: payment.id,
        grossAmount,
        platformFeePaise,
        appointmentOccurrenceId: anchor.appointmentOccurrenceId,
        initialEarningStatus,
        holdUntil,
        orgSplit,
      });
    } else {
      ownerId = await createSingleOwnerConsultantEarnings(tx, {
        consultantProfileId,
        paymentId: payment.id,
        grossAmount,
        platformFeePaise,
        totalConsultantPool,
        appointmentOccurrenceId: anchor.appointmentOccurrenceId,
        initialEarningStatus,
        holdUntil,
        tranches,
      });
    }

    await createPrimaryAndCollabOrgEarnings(tx, {
      consultantProfileId,
      orgSplit,
      collabSettlements,
      paymentId: payment.id,
      grossAmount,
      initialEarningStatus,
      holdUntil: tranches ? null : holdUntil,
    });

    await postBookingLedgerJournal(tx, {
      payment,
      consultantProfileId,
      platformFeePaise,
      totalConsultantPool,
      orgSplit,
      splits,
      collabSettlements,
      preplanned,
    });

    return ownerId;
  };

  const rawOuterTx = outerTx as
    { $executeRawUnsafe?: (query: string) => Promise<unknown> } | undefined;
  const hasOuterSavepoint =
    !!outerTx && typeof rawOuterTx?.$executeRawUnsafe === "function";

  try {
    if (outerTx) {
      if (hasOuterSavepoint) {
        await rawOuterTx!.$executeRawUnsafe!("SAVEPOINT sp_create_earnings");
      }
      const res = await runInTx(outerTx);
      if (hasOuterSavepoint) {
        await rawOuterTx!.$executeRawUnsafe!(
          "RELEASE SAVEPOINT sp_create_earnings",
        );
      }
      return res;
    }
    return await withSerializableRetry(() =>
      prisma.$transaction(runInTx, {
        isolationLevel: "Serializable",
        timeout: 10000,
      }),
    );
  } catch (error) {
    if (hasOuterSavepoint) {
      await rawOuterTx!.$executeRawUnsafe!(
        "ROLLBACK TO SAVEPOINT sp_create_earnings",
      ).catch(() => undefined);
    }
    if (error instanceof ParkedCaptureEarningsError) {
      console.warn(
        JSON.stringify({
          event: "EARNINGS_REFUSED_PARKED_CAPTURE",
          paymentId: payment.id,
        }),
      );
    }
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      // Unique constraint violation — earnings already created by a concurrent call
      console.warn(
        `[Earnings] Duplicate earnings creation for payment ${payment.id} (P2002). Treating as idempotent success.`,
      );
      reportSentryError(error, {
        subsystem: "payments",
        expected: true,
        extra: { paymentId: payment.id, consultantProfileId },
      });
      const existing = await (outerTx ?? prisma).consultantEarnings.findFirst({
        where: { paymentId: payment.id, consultantProfileId },
      });
      return existing?.id ?? null;
    }
    throw error;
  }
}

// #1471 — `releaseEarningsFromHold` used to live here as a second, unlocked
// implementation that nothing called: every scheduled entry point imports
// `scripts/earnings/release-earnings.ts` instead. It was the only copy that
// released `OrganizationEarnings`, which is why the org arm looked implemented
// while being dead. The behaviour has moved into the script (locked, bounded,
// Serializable) and the dead copy is deleted rather than kept as a trap.

/**
 * Get consultant earnings summary.
 *
 * `organizationId` is an OPTIONAL view-scope filter (#org-appts #1024):
 * omitted (`undefined`) = no filter, identical to pre-#1024 behavior, for
 * any caller outside the earnings-view path. `null` scopes to personal
 * (B2C) earnings; a string scopes to that org's earnings.
 */
export async function getConsultantEarningsSummary(
  consultantProfileId: string,
  organizationId?: string | null,
): Promise<EarningsSummary> {
  const orgFilter =
    organizationId !== undefined ? { payment: { organizationId } } : {};
  const [pending, ready, batched, paid, held, pendingTrust] = await Promise.all(
    [
      prisma.consultantEarnings.aggregate({
        where: {
          consultantProfileId,
          status: EarningStatus.PENDING,
          ...orgFilter,
        },
        _sum: { consultantSharePaise: true },
      }),
      prisma.consultantEarnings.aggregate({
        where: {
          consultantProfileId,
          status: EarningStatus.READY,
          ...orgFilter,
        },
        _sum: { consultantSharePaise: true },
      }),
      prisma.consultantEarnings.aggregate({
        where: {
          consultantProfileId,
          status: EarningStatus.BATCHED,
          ...orgFilter,
        },
        _sum: { consultantSharePaise: true },
      }),
      prisma.consultantEarnings.aggregate({
        where: {
          consultantProfileId,
          status: EarningStatus.PAID,
          ...orgFilter,
        },
        _sum: { consultantSharePaise: true },
      }),
      prisma.consultantEarnings.aggregate({
        where: {
          consultantProfileId,
          status: EarningStatus.HELD,
          ...orgFilter,
        },
        _sum: { consultantSharePaise: true },
      }),
      prisma.consultantEarnings.aggregate({
        where: {
          consultantProfileId,
          status: EarningStatus.PENDING_TRUST,
          ...orgFilter,
        },
        _sum: { consultantSharePaise: true },
      }),
    ],
  );

  const pendingEarnings = sumPaise(pending._sum.consultantSharePaise);
  const readyEarnings = sumPaise(ready._sum.consultantSharePaise);
  const batchedEarnings = sumPaise(batched._sum.consultantSharePaise);
  const paidEarnings = sumPaise(paid._sum.consultantSharePaise);
  const heldEarnings = sumPaise(held._sum.consultantSharePaise);
  const pendingTrustEarnings = sumPaise(pendingTrust._sum.consultantSharePaise);

  return {
    consultantProfileId,
    // #837 — batched money is real cleared earnings in transit; keep it in the total.
    totalEarnings:
      pendingEarnings +
      readyEarnings +
      batchedEarnings +
      paidEarnings +
      heldEarnings,
    pendingEarnings,
    readyEarnings,
    batchedEarnings,
    paidEarnings,
    heldEarnings,
    pendingTrustEarnings,
  };
}

/**
 * Get consultant earnings with pagination and filters.
 *
 * `organizationId` is an OPTIONAL view-scope filter (#org-appts #1024):
 * omitted (`undefined`) = no filter, identical to pre-#1024 behavior, for
 * any caller outside the earnings-view path. `null` scopes to personal
 * (B2C) earnings; a string scopes to that org's earnings.
 */
export async function getConsultantEarnings(
  consultantProfileId: string,
  options?: {
    status?: EarningStatus;
    limit?: number;
    offset?: number;
    organizationId?: string | null;
  },
) {
  const { status, limit = 20, offset = 0, organizationId } = options || {};
  const orgFilter =
    organizationId !== undefined ? { payment: { organizationId } } : {};

  const [earnings, total] = await Promise.all([
    prisma.consultantEarnings.findMany({
      where: {
        consultantProfileId,
        ...(status ? { status } : {}),
        ...orgFilter,
      },
      include: {
        payment: {
          select: {
            id: true,
            amount: true,
            originalAmount: true,
            currency: true,
            createdAt: true,
            // #1675 PR-Y — the sponsor (legs are the funding truth, the method
            // the pre-legs fallback) and the plan title the row is named by.
            paymentMethod: true,
            organizationId: true,
            organization: { select: { name: true } },
            legs: { select: { source: true } },
            appointment: {
              select: {
                id: true,
                appointmentType: true,
                consultation: {
                  select: { consultationPlan: { select: { title: true } } },
                },
                subscription: {
                  select: { subscriptionPlan: { select: { title: true } } },
                },
                trial: {
                  select: { subscriptionPlan: { select: { title: true } } },
                },
                webinar: {
                  select: { webinarPlan: { select: { title: true } } },
                },
                class: { select: { classPlan: { select: { title: true } } } },
              },
            },
          },
        },
        payout: {
          select: {
            id: true,
            status: true,
            processedAt: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.consultantEarnings.count({
      where: {
        consultantProfileId,
        ...(status ? { status } : {}),
        ...orgFilter,
      },
    }),
  ]);

  return {
    earnings,
    total,
    hasMore: offset + limit < total,
  };
}

/**
 * Refund earnings (called when a payment is refunded).
 *
 * Accepts an optional `tx` so callers inside `$transaction` blocks (most
 * notably the Razorpay refund webhook) can commit earnings reversals,
 * org-earnings reversals, and TDS-reversal records atomically with the
 * surrounding refund-row + wallet-credit + utilization-reversal writes.
 * When `tx` is omitted we fall back to the global `prisma` client for
 * legacy callers that drive refunds outside a transaction.
 */
export async function refundEarnings(
  paymentId: string,
  options?: {
    forceRefund?: boolean;
    /** For partial refunds: the refund amount in smallest currency unit */
    refundAmount?: number;
    /** For partial refunds: the original payment amount in smallest currency unit */
    paymentAmount?: number;
    /** Optional Prisma transaction client; see function docblock. */
    tx?: Tx;
  },
): Promise<boolean> {
  const db = options?.tx ?? prisma;
  const allEarnings = await db.consultantEarnings.findMany({
    where: { paymentId },
  });

  if (allEarnings.length === 0) {
    console.warn(`No earnings found for payment ${paymentId}`);
    return false;
  }

  // Calculate refund ratio for partial refunds.
  // If refundAmount < paymentAmount, only reverse a proportional share of earnings.
  // Handle edge case: refundAmount=0 means no reversal (ratio=0).
  const isPartialRefund =
    options?.refundAmount !== null &&
    options?.refundAmount !== undefined &&
    options?.paymentAmount !== null &&
    options?.paymentAmount !== undefined &&
    options.paymentAmount > 0 &&
    options.refundAmount < options.paymentAmount;
  const refundRatio = isPartialRefund
    ? options!.refundAmount! / options!.paymentAmount!
    : options?.refundAmount === 0
      ? 0
      : 1;

  if (refundRatio === 0) {
    console.log(
      `Zero-amount refund for payment ${paymentId}, no earnings reversal needed`,
    );
    return true;
  }

  // #813 — integer-paise proportion pair shared by the TDS-reversal helper and
  // the proration floors below. Partial refunds carry explicit paise amounts; a
  // full refund has none, so we pass an equal pair to express ratio=1 without
  // reintroducing float math.
  const refundNumPaise = isPartialRefund ? options!.refundAmount! : 1;
  const refundDenPaise = isPartialRefund ? options!.paymentAmount! : 1;
  // #778 §C-2 — floor each party's clawback (was Math.round; same plug policy
  // as operations/refund.ts): the buyer is made whole in full, so the shaved
  // paise are absorbed by the PLATFORM — never over-clawed from a consultant
  // or an org.
  const prorateRefundPaise = (paise: number) =>
    prorate(paise, refundNumPaise, refundDenPaise);

  if (isPartialRefund) {
    console.log(
      `Partial refund: ${options!.refundAmount}/${options!.paymentAmount} = ${(refundRatio * 100).toFixed(1)}% reversal for payment ${paymentId}`,
    );
  }

  // Also refund any org earnings for this payment (HOST 3-way split)
  const orgEarnings = await db.organizationEarnings.findMany({
    where: { paymentId },
  });

  for (const orgEarning of orgEarnings) {
    if (orgEarning.status === EarningStatus.REFUNDED) continue;

    const alreadyRefunded = orgEarning.refundedAmountPaise ?? 0;
    const maxReversible = Math.max(
      0,
      orgEarning.orgSharePaise - alreadyRefunded,
    );
    const rawOrgRefund = prorateRefundPaise(orgEarning.orgSharePaise);
    const orgRefundAmount = Math.min(rawOrgRefund, maxReversible);

    if (orgRefundAmount <= 0) continue;

    // #CASC — the shared CAS writer pins the legal-source set and prior amount
    // and writes an absolute value: concurrent writers compose to
    // min(share, a + b).
    const orgReversal = await applyCappedOrgEarningReversal(
      db,
      orgEarning,
      orgRefundAmount,
    );

    if (orgReversal.lostRace) {
      console.warn(
        `Org earnings ${orgEarning.id}: refundEarnings CAS lost, ` +
          `${orgReversal.reversedPaise} paise applied of ${orgRefundAmount} ` +
          `(${orgReversal.refundedAmountPaise}/${orgEarning.orgSharePaise}).`,
      );
    }

    console.log(
      `Org earnings ${orgEarning.id} refunded: ${orgReversal.reversedPaise} paise (${orgReversal.fullyRefunded ? "full" : "partial"})`,
    );
  }

  // #1766 — subscription tranches: one clawback over the summed share,
  // consumed newest-tranche-first (same allocator as applyRefundCascade).
  const trancheRows = allEarnings.filter(
    (e) => typeof e.cycleOrdinal === "number",
  );
  const trancheAbsorb = new Map(
    allocateCycleClawback(
      trancheRows,
      prorateRefundPaise(
        trancheRows.reduce((s, e) => s + e.consultantSharePaise, 0),
      ),
    ).map((a) => [a.id, a.absorbPaise] as const),
  );

  // Refund each earnings record (supports multi-party collaborator payments)
  for (const earnings of allEarnings) {
    // C7 FIX: Guard against already-refunded earnings.
    if (earnings.status === EarningStatus.REFUNDED) {
      console.warn(
        `Earnings ${earnings.id} already refunded for payment ${paymentId}. Skipping.`,
      );
      continue;
    }

    // Cap shareToReverse against remaining reversible balance to prevent
    // over-refunding on duplicate webhooks or sequential partial refunds.
    const alreadyRefunded = earnings.refundedShareAmount ?? 0;
    const maxReversible = Math.max(
      0,
      earnings.consultantSharePaise - alreadyRefunded,
    );
    const rawShare =
      typeof earnings.cycleOrdinal !== "number"
        ? prorateRefundPaise(earnings.consultantSharePaise)
        : (trancheAbsorb.get(earnings.id) ?? 0);
    const shareToReverse = Math.min(rawShare, maxReversible);

    if (shareToReverse <= 0) {
      console.warn(
        `Earnings ${earnings.id} already fully refunded (${alreadyRefunded}/${earnings.consultantSharePaise}). Skipping.`,
      );
      continue;
    }

    // PAID rows reverse only under forceRefund (with the TDS reversal).
    if (earnings.status === EarningStatus.PAID) {
      if (!options?.forceRefund) {
        console.error(
          `Cannot refund earnings ${earnings.id} - already paid out. Use forceRefund: true to proceed with TDS reversal.`,
        );
        continue;
      }
      const paidReversal = await applyCappedEarningReversal(
        db,
        earnings,
        shareToReverse,
      );

      // #813 — proportional TDS reversal via the shared helper, AFTER the CAS
      // and only when `reversedPaise > 0`. The basis stays booking-level
      // (`refundNumPaise / refundDenPaise`): a compliance figure.
      if (earnings.payoutId && paidReversal.reversedPaise > 0) {
        await recordTdsReversal(db, {
          payoutId: earnings.payoutId,
          consultantProfileId: earnings.consultantProfileId,
          earningsId: earnings.id,
          refundAmountPaise: refundNumPaise,
          paymentAmountPaise: refundDenPaise,
        });
      }
      if (paidReversal.lostRace) {
        console.warn(
          `Earnings ${earnings.id} already reversed by a concurrent refund path; ` +
            `${paidReversal.reversedPaise} paise applied here ` +
            `(${paidReversal.refundedShareAmount}/${earnings.consultantSharePaise}).`,
        );
      }

      continue;
    }

    // Non-PAID rows: a row that turns PAID mid-flight is refused, not reversed.
    const reversal = await applyCappedEarningReversal(
      db,
      earnings,
      shareToReverse,
      REFUNDABLE_UNPAID_EARNING_SOURCE,
    );
    if (reversal.lostRace) {
      console.warn(
        `Earnings ${earnings.id} CAS lost to a concurrent refund path; ` +
          `${reversal.reversedPaise} paise applied here ` +
          `(${reversal.refundedShareAmount}/${earnings.consultantSharePaise}).`,
      );
    }
  }

  return true;
}

/**
 * Get earnings statistics for admin dashboard
 */
export async function getEarningsStats() {
  const [pending, ready, batched, paid, held, refunded] = await Promise.all([
    prisma.consultantEarnings.aggregate({
      where: { status: EarningStatus.PENDING },
      _sum: { consultantSharePaise: true, platformFeePaise: true },
      _count: true,
    }),
    prisma.consultantEarnings.aggregate({
      where: { status: EarningStatus.READY },
      _sum: { consultantSharePaise: true, platformFeePaise: true },
      _count: true,
    }),
    prisma.consultantEarnings.aggregate({
      where: { status: EarningStatus.BATCHED },
      _sum: { consultantSharePaise: true, platformFeePaise: true },
      _count: true,
    }),
    prisma.consultantEarnings.aggregate({
      where: { status: EarningStatus.PAID },
      _sum: { consultantSharePaise: true, platformFeePaise: true },
      _count: true,
    }),
    prisma.consultantEarnings.aggregate({
      where: { status: EarningStatus.HELD },
      _sum: { consultantSharePaise: true, platformFeePaise: true },
      _count: true,
    }),
    prisma.consultantEarnings.aggregate({
      where: { status: EarningStatus.REFUNDED },
      _sum: { consultantSharePaise: true, platformFeePaise: true },
      _count: true,
    }),
  ]);

  return {
    pending: {
      count: pending._count,
      consultantSharePaise: sumPaise(pending._sum.consultantSharePaise),
      platformFeePaise: sumPaise(pending._sum.platformFeePaise),
    },
    ready: {
      count: ready._count,
      consultantSharePaise: sumPaise(ready._sum.consultantSharePaise),
      platformFeePaise: sumPaise(ready._sum.platformFeePaise),
    },
    // #837 — batched, cash not yet disbursed (was previously counted under ready).
    batched: {
      count: batched._count,
      consultantSharePaise: sumPaise(batched._sum.consultantSharePaise),
      platformFeePaise: sumPaise(batched._sum.platformFeePaise),
    },
    paid: {
      count: paid._count,
      consultantSharePaise: sumPaise(paid._sum.consultantSharePaise),
      platformFeePaise: sumPaise(paid._sum.platformFeePaise),
    },
    held: {
      count: held._count,
      consultantSharePaise: sumPaise(held._sum.consultantSharePaise),
      platformFeePaise: sumPaise(held._sum.platformFeePaise),
    },
    refunded: {
      count: refunded._count,
      consultantSharePaise: sumPaise(refunded._sum.consultantSharePaise),
      platformFeePaise: sumPaise(refunded._sum.platformFeePaise),
    },
    // #837 — platform fee is earned once the sale settles (READY); batched/paid
    // are downstream of READY, so include all three to keep recognized revenue whole.
    totalPlatformRevenue:
      sumPaise(paid._sum.platformFeePaise) +
      sumPaise(batched._sum.platformFeePaise) +
      sumPaise(ready._sum.platformFeePaise),
  };
}

// ============================================
// Organization Earnings Functions
// ============================================

/**
 * Get org earnings summary (parallels getConsultantEarningsSummary)
 */
export async function getOrgEarningsSummary(
  organizationId: string,
): Promise<OrgEarningsSummary> {
  const [pending, ready, batched, paid, held] = await Promise.all([
    prisma.organizationEarnings.aggregate({
      where: { organizationId, status: EarningStatus.PENDING },
      _sum: { orgSharePaise: true },
    }),
    prisma.organizationEarnings.aggregate({
      where: { organizationId, status: EarningStatus.READY },
      _sum: { orgSharePaise: true },
    }),
    prisma.organizationEarnings.aggregate({
      where: { organizationId, status: EarningStatus.BATCHED },
      _sum: { orgSharePaise: true },
    }),
    prisma.organizationEarnings.aggregate({
      where: { organizationId, status: EarningStatus.PAID },
      _sum: { orgSharePaise: true },
    }),
    prisma.organizationEarnings.aggregate({
      where: { organizationId, status: EarningStatus.HELD },
      _sum: { orgSharePaise: true },
    }),
  ]);

  const pendingEarnings = sumPaise(pending._sum.orgSharePaise);
  const readyEarnings = sumPaise(ready._sum.orgSharePaise);
  const batchedEarnings = sumPaise(batched._sum.orgSharePaise);
  const paidEarnings = sumPaise(paid._sum.orgSharePaise);
  const heldEarnings = sumPaise(held._sum.orgSharePaise);

  return {
    organizationId,
    // #837 — batched money is real cleared earnings in transit; keep it in the total.
    totalEarnings:
      pendingEarnings +
      readyEarnings +
      batchedEarnings +
      paidEarnings +
      heldEarnings,
    pendingEarnings,
    readyEarnings,
    batchedEarnings,
    paidEarnings,
    heldEarnings,
  };
}

/**
 * Get paginated org earnings list
 */
export async function getOrgEarnings(
  organizationId: string,
  options?: {
    status?: EarningStatus;
    limit?: number;
    offset?: number;
  },
) {
  const { status, limit = 20, offset = 0 } = options || {};

  const [earnings, total] = await Promise.all([
    prisma.organizationEarnings.findMany({
      where: {
        organizationId,
        ...(status ? { status } : {}),
      },
      include: {
        payment: {
          select: {
            id: true,
            amount: true,
            originalAmount: true,
            currency: true,
            createdAt: true,
            appointment: {
              select: {
                id: true,
                appointmentType: true,
              },
            },
          },
        },
        orgPayout: {
          select: {
            id: true,
            status: true,
            processedAt: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.organizationEarnings.count({
      where: {
        organizationId,
        ...(status ? { status } : {}),
      },
    }),
  ]);

  return {
    earnings,
    total,
    hasMore: offset + limit < total,
  };
}
