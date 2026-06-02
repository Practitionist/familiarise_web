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

import prisma from "@/lib/prisma";
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
} from "@prisma/client";
import { PAYOUT_CONSTANTS, AppointmentType } from "./constants";
import { calculateRevenueSplit } from "@/lib/collaborators/service";
import { getIndianFYQuarter } from "@/lib/payments/tax/tds-service";
import { ENABLE_HOST_ORGS } from "@/lib/feature-flags";
import { recordSystemError } from "@/lib/enterprise/system-events";
import type { RevenueSplit } from "@/types/collaborators";

// ============================================
// Types
// ============================================

export interface EarningsSummary {
  consultantProfileId: string;
  totalEarnings: number;
  pendingEarnings: number;
  readyEarnings: number;
  paidEarnings: number;
  heldEarnings: number;
}

/** Resolved 3-way split for a canHost=true org consultant */
export interface OrgEarningsSplit {
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
export interface OrgEarningsSummary {
  organizationId: string;
  totalEarnings: number;
  pendingEarnings: number;
  readyEarnings: number;
  paidEarnings: number;
  heldEarnings: number;
}

export interface CreateEarningsParams {
  payment: Payment & {
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
    } | null;
  };
  appointmentType: AppointmentType;
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
import { assertEarningStatusTransitionLegal } from "./earning-status";

// ============================================
// Org Split Resolution
// ============================================

type PrismaTransaction = Prisma.TransactionClient;

/**
 * Determine if a consultant's payment should use a 3-way org split.
 *
 * Returns an OrgEarningsSplit if the consultant is an active EXPERT
 * membership at a canHost org. Returns null for independent consultants
 * or when the HOST-orgs feature flag is off.
 *
 * For multi-org consultants, uses the first active canHost membership.
 * (Future: allow consultant to select which org gets credit per-booking.)
 */
async function resolveOrgSplit(
  tx: PrismaTransaction,
  consultantProfileId: string,
  grossAmount: number,
  /** Point in time at which the rate card is resolved. Default = now(),
   *  but callers processing a historical payment MUST pass
   *  `payment.createdAt` — otherwise a retroactive rate bump on the org
   *  would silently rewrite what the consultant was owed for bookings
   *  made before the bump. */
  at: Date = new Date(),
): Promise<OrgEarningsSplit | null> {
  if (!ENABLE_HOST_ORGS) return null;

  // Arch-4: Membership where role=EXPERT and parent org canHost=true.
  // Oldest membership wins (multi-org consultants route deterministically
  // to the same org). Rate card resolved via the time-scoped resolver at
  // the booking instant.
  const membership = await tx.membership.findFirst({
    where: {
      consultantProfileId,
      role: "EXPERT",
      status: "ACTIVE",
      organization: { canHost: true, status: "ACTIVE" },
    },
    orderBy: { createdAt: "asc" },
    include: {
      organization: { select: { id: true } },
    },
  });

  if (!membership) return null;

  const orgId = membership.organization.id;
  const payoutRecipient = membership.payoutRecipient;

  const { resolveEffectiveRateCard } = await import("@/lib/api/organizations/rate-card");
  const resolved = await resolveEffectiveRateCard(tx, {
    orgId,
    membershipOverrideId: membership.rateCardOverrideId,
    at,
  });

  // Integer paise × basis-point math, no float drift.
  const platformFeePaise = Math.floor((grossAmount * resolved.platformBps) / 10_000);
  const consultantSharePaise = Math.floor((grossAmount * resolved.consultantBps) / 10_000);
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
    // Internal/salaried consultant: org absorbs the consultant slice.
    return {
      ...base,
      platformFeePaise,
      orgShare: grossAmount - platformFeePaise,
      consultantSharePaise: 0,
    };
  }

  if (orgShare < 0) {
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

/**
 * Create earnings record from a successful payment
 * Called from payment success webhook
 */
export async function createEarningsFromPayment({
  payment,
  appointmentType,
}: CreateEarningsParams): Promise<string | null> {
  // Get consultant profile ID from the appointment
  const consultantProfileId = payment.appointment?.consultantProfile?.id;

  if (!consultantProfileId) {
    console.warn(
      `No consultant profile found for payment ${payment.id}. Skipping earnings creation.`,
    );
    return null;
  }

  // Calculate revenue split using original plan price (before platform-funded discounts/credits/tax)
  // Payment.originalAmount is stored in paise (smallest unit) — same as earnings
  const grossAmount = payment.originalAmount;

  // Calculate hold period
  const holdHours =
    PAYOUT_CONSTANTS.HOLD_PERIOD_HOURS[appointmentType] ||
    PAYOUT_CONSTANTS.HOLD_PERIOD_HOURS.CONSULTATION;
  const holdUntil = new Date(Date.now() + holdHours * 60 * 60 * 1000);

  // Determine if this payment involves collaborators (webinars/classes only)
  let planType: "webinar" | "class" | null = null;
  let planId: string | null = null;

  if (appointmentType === "WEBINAR" && payment.appointment?.webinar) {
    planType = "webinar";
    planId = payment.appointment.webinar.webinarPlanId;
  } else if (appointmentType === "CLASS" && payment.appointment?.class) {
    planType = "class";
    planId = payment.appointment.class.classPlanId;
  }

  // FIX #9: Wrap earnings creation + balance updates in a transaction for atomicity.
  // Also handles P2002 unique constraint violations gracefully for idempotency.
  try {
    return await prisma.$transaction(async (tx) => {
      // Idempotency check inside transaction to prevent races
      const existingEarnings = await tx.consultantEarnings.findFirst({
        where: { paymentId: payment.id, consultantProfileId },
      });
      if (existingEarnings) {
        console.warn(
          `Earnings already exist for payment ${payment.id}. Skipping.`,
        );
        return existingEarnings.id;
      }

      // Check if this consultant belongs to a HOST/HYBRID org (3-way
      // split). Settlement uses the rate card that was EFFECTIVE AT
      // PAYMENT-CREATION TIME — hold periods can be days long, so by the
      // time earnings are settled the live rate may have been bumped.
      // Passing `payment.createdAt` keeps the split stable across that
      // window.
      const orgSplit = await resolveOrgSplit(
        tx,
        consultantProfileId,
        grossAmount,
        payment.createdAt,
      );

      // Determine platform fee and consultant pool based on whether org split applies
      const platformFeePaise = orgSplit
        ? orgSplit.platformFeePaise
        : Math.round(
            (grossAmount * PAYOUT_CONSTANTS.PLATFORM_FEE_PERCENTAGE) / 100,
          );
      const totalConsultantPool = orgSplit
        ? orgSplit.consultantSharePaise
        : grossAmount - platformFeePaise;

      // Calculate collaborator splits if applicable
      let splits: RevenueSplit[] = [];
      if (planType && planId) {
        splits = await calculateRevenueSplit(
          planType,
          planId,
          totalConsultantPool,
        );
      }

      let ownerId: string | null = null;

      if (splits.length > 0) {
        // Multi-party payment: create earnings for owner and each collaborator
        for (const split of splits) {
          const isOwner = split.role === "OWNER";
          const shareBps =
            totalConsultantPool > 0
              ? Math.round((split.share / totalConsultantPool) * 10_000)
              : 0;

          const earnings = await tx.consultantEarnings.create({
            data: {
              consultantProfileId: split.consultantProfileId,
              paymentId: payment.id,
              grossAmount: isOwner ? grossAmount : 0,
              platformFeePaise: isOwner ? platformFeePaise : 0,
              consultantSharePaise: split.share,
              role: isOwner ? EarningRole.OWNER : EarningRole.COLLABORATOR,
              shareBps,
              status: EarningStatus.PENDING,
              holdUntil,
              currency: "INR",
            },
          });

          if (split.role === "OWNER") {
            ownerId = earnings.id;
          }

          console.log(
            `Earnings created for ${split.role} (${split.consultantProfileId}): ${split.share / 100} from payment ${payment.id}${orgSplit ? " [HOST 3-way split]" : ""}`,
          );
        }
      } else {
        // Single-owner payment (no collaborators or not a webinar/class)
        const earnings = await tx.consultantEarnings.create({
          data: {
            consultantProfileId,
            paymentId: payment.id,
            grossAmount,
            platformFeePaise,
            consultantSharePaise: totalConsultantPool,
            status: EarningStatus.PENDING,
            holdUntil,
            currency: "INR",
          },
        });

        ownerId = earnings.id;
      }

      // Create OrganizationEarnings row for the HOST/HYBRID org (3-way split).
      // Skip when orgShare is 0 (Platform-only mode: platformCommissionRate = 1.0)
      // — creating 0-value rows adds noise without value.
      //
      // PR-1d / #687: if the sponsoring org is still PENDING_VERIFICATION
      // and has never paid an invoice, accruals start in PENDING_TRUST
      // instead of PENDING. The `release-pending-trust-earnings` cron
      // promotes them once the org is verified or first invoice clears.
      if (orgSplit && orgSplit.orgShare > 0) {
        const sponsorOrg = await tx.organization.findUnique({
          where: { id: orgSplit.organizationId },
          select: { status: true },
        });
        let initialStatus: EarningStatus = EarningStatus.PENDING;
        if (sponsorOrg?.status === "PENDING_VERIFICATION") {
          const paidInvoiceCount = await tx.organizationInvoice.count({
            where: {
              organizationId: orgSplit.organizationId,
              status: "PAID",
            },
          });
          if (paidInvoiceCount === 0) {
            initialStatus = EarningStatus.PENDING_TRUST;
          }
        }

        await tx.organizationEarnings.create({
          data: {
            organizationId: orgSplit.organizationId,
            paymentId: payment.id,
            grossAmountPaise: grossAmount,
            platformFeePaise: orgSplit.platformFeePaise,
            orgSharePaise: orgSplit.orgShare,
            consultantSharePaise: orgSplit.consultantSharePaise,
            refundedAmountPaise: 0,
            status: initialStatus,
            holdUntil,
            currency: "INR",
            // Rate-card snapshot: persist the exact split applied so
            // payout reconciliation reads this row, never the live card.
            rateCardIdApplied: orgSplit.rateCardIdApplied,
            platformBpsApplied: orgSplit.platformBps,
            orgBpsApplied: orgSplit.orgBps,
            consultantBpsApplied: orgSplit.consultantBps,
          },
        });

        console.log(
          `Org earnings created for ${orgSplit.organizationId}: org=${orgSplit.orgShare / 100} consultant=${orgSplit.consultantSharePaise / 100} (recipient=${orgSplit.payoutRecipient}) from payment ${payment.id}`,
        );
      } else if (orgSplit && orgSplit.orgShare === 0) {
        console.log(
          `Platform-only mode for ${orgSplit.organizationId}: skipping 0-value org earnings for payment ${payment.id}`,
        );
      }

      // #771 D1/D5 / AF-3 — double-entry booking posting (full accrual, dual-write).
      //   Dr funding legs (CASH/WALLET/ORG_RECEIVABLE) + PLATFORM_PROMO (referral
      //   credits) + DISCOUNT  ==  Cr PLATFORM_FEE + CONSULTANT_PAYABLE(per party) +
      //   ORG_PAYABLE + GST_PAYABLE.
      // #776 — posted for BOTH the single-consultant AND multi-collaborator cases.
      // Multi-collaborator webinars/classes used to be deferred (logged), so the
      // journal silently omitted an entire booking class and reconcile's
      // EARNINGS_LEDGER_DRIFT couldn't cover them. Now each collaborator gets its
      // own CONSULTANT_PAYABLE credit (shares sum to totalConsultantPool). Wrapped
      // so a ledger imbalance can never break the real booking during dual-write.
      {
        try {
          const legs = await tx.paymentLeg.findMany({
            where: { paymentId: payment.id },
            select: { source: true, amountPaise: true },
          });
          const orgId = payment.organizationId ?? null;
          const debits: Posting[] = [];
          const pushDebit = (account: AccountRef, amountPaise: number) => {
            if (amountPaise > 0)
              debits.push({ account, direction: "DEBIT", amountPaise });
          };
          if (legs.length > 0) {
            let card = 0;
            let wallet = 0;
            let receivable = 0;
            let promo = 0;
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
                case "OVERAGE_INVOICE_ACCRUAL":
                  receivable += leg.amountPaise;
                  break;
                case "REFERRAL_CREDIT":
                  promo += leg.amountPaise;
                  break;
                case "LICENSE":
                  break; // 0 — no money moves
              }
            }
            pushDebit({ kind: "CASH" }, card);
            pushDebit({ kind: "WALLET", organizationId: orgId }, wallet);
            pushDebit({ kind: "ORG_RECEIVABLE", organizationId: orgId }, receivable);
            pushDebit({ kind: "PLATFORM_PROMO" }, promo);
          } else {
            // Back-compat: legacy single-source payments carry no legs.
            pushDebit({ kind: "CASH" }, payment.amount);
          }
          // #776 — DISCOUNT is the platform-absorbed gap between gross
          // (originalAmount + tax) and the funding actually applied. Base it on the
          // sum of the funding-leg debits, NOT payment.amount: a referral-credit leg
          // funds the booking (debited as PLATFORM_PROMO) yet is excluded from
          // payment.amount (post-credit). Using `amount` double-counted the credit
          // (PROMO + DISCOUNT), imbalancing the posting so it was silently dropped —
          // every fully-credit-funded booking went un-journaled.
          const fundingDebitTotal = debits.reduce((s, d) => s + d.amountPaise, 0);
          pushDebit(
            { kind: "DISCOUNT" },
            Math.max(
              0,
              payment.originalAmount + payment.taxAmount - fundingDebitTotal,
            ),
          );

          const credits: Posting[] = [];
          const pushCredit = (account: AccountRef, amountPaise: number) => {
            if (amountPaise > 0)
              credits.push({ account, direction: "CREDIT", amountPaise });
          };
          pushCredit({ kind: "PLATFORM_FEE" }, platformFeePaise);
          if (splits.length > 0) {
            // Multi-party: one payable per collaborator (Σ split.share ===
            // totalConsultantPool), so the journal mirrors the ConsultantEarnings rows.
            for (const split of splits) {
              pushCredit(
                {
                  kind: "CONSULTANT_PAYABLE",
                  consultantProfileId: split.consultantProfileId,
                },
                split.share,
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
              { kind: "ORG_PAYABLE", organizationId: orgSplit.organizationId },
              orgSplit.orgShare,
            );
          }
          pushCredit({ kind: "GST_PAYABLE" }, payment.taxAmount);

          await postLedgerTxn(tx, {
            idempotencyKey: `booking:${payment.id}`,
            kind: "BOOKING",
            paymentId: payment.id,
            postings: [...debits, ...credits],
          });
        } catch (err) {
          console.warn(
            `[ledger] booking posting skipped for payment ${payment.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
          // #776 — surface the dual-write drift immediately instead of waiting for
          // the nightly reconcile. Fire-and-forget on its own connection; never
          // block or fail the booking on a telemetry write.
          void recordSystemError({
            organizationId: payment.organizationId ?? null,
            category: "LEDGER",
            summary: `Booking ledger posting failed for payment ${payment.id}`,
            err,
            context: { paymentId: payment.id },
          }).catch(() => {});
        }
      }

      // ============================================
      // A3 (Q3): per-collaborator HOST-org settlement
      // ============================================
      // Each ACCEPTED collaborator at a HOST org settles to *their own*
      // org independently of the primary expert's org. The collaborator's
      // share (computed by `calculateRevenueSplit` against the
      // already-org-split consultant pool) becomes the "gross" that flows
      // through their own org's rate card.
      //
      // Independent collaborators (no active EXPERT membership at any
      // HOST org) do not get an OrganizationEarnings row — their share
      // sits on `ConsultantEarnings` only and pays out via the personal
      // payout pipeline.
      //
      // Same-org collision (e.g. primary expert AND collaborator both at
      // LearnPro): the @@unique([paymentId, organizationId]) constraint
      // rejects the second insert. v1 simplification — log + skip; the
      // collaborator's share already lives on `ConsultantEarnings` so
      // their personal payout is unaffected, only the org-side accrual
      // for that share is dropped (the org already gets its cut of the
      // primary expert's gross via the OWNER row above). A v2 could roll
      // the collaborator's slice into the existing row, but that
      // requires a more invasive refactor of OrganizationEarnings'
      // single-consultant assumption.
      //
      // Runs in the SAME transaction as the OWNER earnings — atomicity
      // preserved across all per-collab org rows.
      const collaboratorSplits = splits.filter((s) => s.role !== "OWNER");
      for (const collab of collaboratorSplits) {
        if (collab.share <= 0) continue;
        const collabOrgSplit = await resolveOrgSplit(
          tx,
          collab.consultantProfileId,
          collab.share,
          payment.createdAt,
        );
        if (!collabOrgSplit) continue; // independent collaborator
        if (collabOrgSplit.orgShare <= 0) {
          console.log(
            `Platform-only mode for collaborator org ${collabOrgSplit.organizationId}: skipping 0-value org earnings for payment ${payment.id}`,
          );
          continue;
        }

        const collabSponsorOrg = await tx.organization.findUnique({
          where: { id: collabOrgSplit.organizationId },
          select: { status: true },
        });
        let collabInitialStatus: EarningStatus = EarningStatus.PENDING;
        if (collabSponsorOrg?.status === "PENDING_VERIFICATION") {
          const paidInvoiceCount = await tx.organizationInvoice.count({
            where: {
              organizationId: collabOrgSplit.organizationId,
              status: "PAID",
            },
          });
          if (paidInvoiceCount === 0) {
            collabInitialStatus = EarningStatus.PENDING_TRUST;
          }
        }

        try {
          await tx.organizationEarnings.create({
            data: {
              organizationId: collabOrgSplit.organizationId,
              paymentId: payment.id,
              // The collaborator's share is the "gross" that this org
              // is splitting — NOT the booking's full gross. Persist it
              // verbatim so reconciliation sees a consistent picture.
              grossAmountPaise: collab.share,
              platformFeePaise: collabOrgSplit.platformFeePaise,
              orgSharePaise: collabOrgSplit.orgShare,
              consultantSharePaise: collabOrgSplit.consultantSharePaise,
              refundedAmountPaise: 0,
              status: collabInitialStatus,
              holdUntil,
              currency: "INR",
              rateCardIdApplied: collabOrgSplit.rateCardIdApplied,
              platformBpsApplied: collabOrgSplit.platformBps,
              orgBpsApplied: collabOrgSplit.orgBps,
              consultantBpsApplied: collabOrgSplit.consultantBps,
            },
          });
          console.log(
            `Collaborator org earnings created for ${collabOrgSplit.organizationId} (collab ${collab.consultantProfileId}): org=${collabOrgSplit.orgShare / 100} consultant=${collabOrgSplit.consultantSharePaise / 100} from payment ${payment.id}`,
          );
        } catch (err) {
          if (
            err instanceof Prisma.PrismaClientKnownRequestError &&
            err.code === "P2002"
          ) {
            // Same-org collision with primary expert (or another
            // collaborator that already wrote a row). v1 strategy: skip.
            // See the block-level comment above for rationale.
            console.warn(
              `[Earnings] Skipping collaborator org earnings for ${collabOrgSplit.organizationId} on payment ${payment.id}: row already exists for this (payment, org) pair (collab ${collab.consultantProfileId}). Their personal share is unaffected.`,
            );
            continue;
          }
          throw err;
        }
      }

      return ownerId;
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      // Unique constraint violation — earnings already created by a concurrent call
      console.warn(
        `[Earnings] Duplicate earnings creation for payment ${payment.id} (P2002). Treating as idempotent success.`,
      );
      const existing = await prisma.consultantEarnings.findFirst({
        where: { paymentId: payment.id, consultantProfileId },
      });
      return existing?.id ?? null;
    }
    throw error;
  }
}

/**
 * Release earnings from hold period
 * Called by cron job hourly
 */
export async function releaseEarningsFromHold(): Promise<number> {
  const now = new Date();

  // Release consultant earnings
  const consultantResult = await prisma.consultantEarnings.updateMany({
    where: {
      status: EarningStatus.PENDING,
      holdUntil: { lte: now },
    },
    data: {
      status: EarningStatus.READY,
    },
  });

  // Release org earnings in parallel
  const orgResult = await prisma.organizationEarnings.updateMany({
    where: {
      status: EarningStatus.PENDING,
      holdUntil: { lte: now },
    },
    data: {
      status: EarningStatus.READY,
    },
  });

  const total = consultantResult.count + orgResult.count;
  console.log(
    `Released ${consultantResult.count} consultant + ${orgResult.count} org earnings from hold`,
  );
  return total;
}

/**
 * Get consultant earnings summary
 */
export async function getConsultantEarningsSummary(
  consultantProfileId: string,
): Promise<EarningsSummary> {
  const [pending, ready, paid, held] = await Promise.all([
    prisma.consultantEarnings.aggregate({
      where: { consultantProfileId, status: EarningStatus.PENDING },
      _sum: { consultantSharePaise: true },
    }),
    prisma.consultantEarnings.aggregate({
      where: { consultantProfileId, status: EarningStatus.READY },
      _sum: { consultantSharePaise: true },
    }),
    prisma.consultantEarnings.aggregate({
      where: { consultantProfileId, status: EarningStatus.PAID },
      _sum: { consultantSharePaise: true },
    }),
    prisma.consultantEarnings.aggregate({
      where: { consultantProfileId, status: EarningStatus.HELD },
      _sum: { consultantSharePaise: true },
    }),
  ]);

  const pendingEarnings = pending._sum.consultantSharePaise || 0;
  const readyEarnings = ready._sum.consultantSharePaise || 0;
  const paidEarnings = paid._sum.consultantSharePaise || 0;
  const heldEarnings = held._sum.consultantSharePaise || 0;

  return {
    consultantProfileId,
    totalEarnings:
      pendingEarnings + readyEarnings + paidEarnings + heldEarnings,
    pendingEarnings,
    readyEarnings,
    paidEarnings,
    heldEarnings,
  };
}

/**
 * Get consultant earnings with pagination and filters
 */
export async function getConsultantEarnings(
  consultantProfileId: string,
  options?: {
    status?: EarningStatus;
    limit?: number;
    offset?: number;
  },
) {
  const { status, limit = 20, offset = 0 } = options || {};

  const [earnings, total] = await Promise.all([
    prisma.consultantEarnings.findMany({
      where: {
        consultantProfileId,
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
    tx?: Prisma.TransactionClient;
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
    console.log(`Zero-amount refund for payment ${paymentId}, no earnings reversal needed`);
    return true;
  }

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
    const maxReversible = Math.max(0, orgEarning.orgSharePaise - alreadyRefunded);
    const rawOrgRefund = Math.round(orgEarning.orgSharePaise * refundRatio);
    const orgRefundAmount = Math.min(rawOrgRefund, maxReversible);

    if (orgRefundAmount <= 0) continue;

    const isOrgFullyRefunded =
      alreadyRefunded + orgRefundAmount >= orgEarning.orgSharePaise;

    await db.organizationEarnings.update({
      where: { id: orgEarning.id },
      data: {
        refundedAmountPaise: { increment: orgRefundAmount },
        ...(isOrgFullyRefunded && { status: EarningStatus.REFUNDED }),
      },
    });

    console.log(
      `Org earnings ${orgEarning.id} refunded: ${orgRefundAmount} paise (${isOrgFullyRefunded ? "full" : "partial"})`,
    );
  }

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
    const maxReversible = Math.max(0, earnings.consultantSharePaise - alreadyRefunded);
    const rawShare = Math.round(earnings.consultantSharePaise * refundRatio);
    const shareToReverse = Math.min(rawShare, maxReversible);

    if (shareToReverse <= 0) {
      console.warn(
        `Earnings ${earnings.id} already fully refunded (${alreadyRefunded}/${earnings.consultantSharePaise}). Skipping.`,
      );
      continue;
    }

    // Determine if this reversal fully exhausts the earning
    const isFullyRefunded = alreadyRefunded + shareToReverse >= earnings.consultantSharePaise;

    // Handle already-paid earnings (payout completed)
    if (earnings.status === EarningStatus.PAID) {
      if (!options?.forceRefund) {
        console.error(
          `Cannot refund earnings ${earnings.id} - already paid out. Use forceRefund: true to proceed with TDS reversal.`,
        );
        continue;
      }
      if (isFullyRefunded) {
        // Defensive double-check: forceRefund is the only path that
        // writes PAID → REFUNDED, but if another code path ever forgets
        // the assertion this throws before any state mutates.
        assertEarningStatusTransitionLegal(
          earnings.id,
          earnings.status,
          EarningStatus.REFUNDED,
        );
      }

      // Force refund of PAID earnings: create TDS reversal record
      if (earnings.payoutId) {
        const tdsRecord = await db.tDSRecord.findFirst({
          where: {
            payoutId: earnings.payoutId,
            consultantProfileId: earnings.consultantProfileId,
            isReversal: false,
          },
        });

        if (tdsRecord && tdsRecord.tdsDeducted > 0) {
          const tdsToReverse = Math.round(tdsRecord.tdsDeducted * refundRatio);
          await db.tDSRecord.create({
            data: {
              consultantProfileId: earnings.consultantProfileId,
              financialYear: tdsRecord.financialYear,
              quarter: getIndianFYQuarter(),
              cumulativeAmountCredited: tdsRecord.cumulativeAmountCredited,
              tdsDeducted: -tdsToReverse,
              tdsRate: tdsRecord.tdsRate,
              payoutId: earnings.payoutId,
              earningsId: earnings.id,
              isReversal: true,
            },
          });

          console.log(
            `TDS reversal created for earnings ${earnings.id}: -${tdsToReverse} paise (${isPartialRefund ? "partial" : "full"})`,
          );
        }
      }

      // Update earnings: always track refundedShareAmount, set REFUNDED when fully exhausted
      await db.consultantEarnings.update({
        where: { id: earnings.id },
        data: {
          refundedShareAmount: { increment: shareToReverse },
          ...(isFullyRefunded && { status: EarningStatus.REFUNDED }),
        },
      });

      continue;
    }

    // Update earnings for non-paid earnings (PENDING/HELD/READY):
    // always track refundedShareAmount, set REFUNDED when fully exhausted
    await db.consultantEarnings.update({
      where: { id: earnings.id },
      data: {
        refundedShareAmount: { increment: shareToReverse },
        ...(isFullyRefunded && { status: EarningStatus.REFUNDED }),
      },
    });
  }

  return true;
}

/**
 * Hold earnings (e.g., for dispute investigation)
 */
export async function holdEarnings(
  earningsId: string,
  reason?: string,
): Promise<boolean> {
  const earnings = await prisma.consultantEarnings.findUnique({
    where: { id: earningsId },
  });

  if (!earnings) {
    console.warn(`Earnings not found: ${earningsId}`);
    return false;
  }

  // Can only hold if pending or ready
  if (
    earnings.status !== EarningStatus.PENDING &&
    earnings.status !== EarningStatus.READY
  ) {
    console.warn(
      `Cannot hold earnings ${earningsId} - status is ${earnings.status}`,
    );
    return false;
  }

  await prisma.consultantEarnings.update({
    where: { id: earningsId },
    data: {
      status: EarningStatus.HELD,
    },
  });

  console.log(
    `Earnings ${earningsId} held. Reason: ${reason || "Not specified"}`,
  );
  return true;
}

/**
 * Release held earnings back to ready state
 */
export async function releaseHeldEarnings(
  earningsId: string,
): Promise<boolean> {
  const earnings = await prisma.consultantEarnings.findUnique({
    where: { id: earningsId },
  });

  if (!earnings || earnings.status !== EarningStatus.HELD) {
    return false;
  }

  await prisma.consultantEarnings.update({
    where: { id: earningsId },
    data: {
      status: EarningStatus.READY,
    },
  });

  return true;
}

/**
 * Get earnings statistics for admin dashboard
 */
export async function getEarningsStats() {
  const [pending, ready, paid, held, refunded] = await Promise.all([
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
      consultantSharePaise: pending._sum.consultantSharePaise || 0,
      platformFeePaise: pending._sum.platformFeePaise || 0,
    },
    ready: {
      count: ready._count,
      consultantSharePaise: ready._sum.consultantSharePaise || 0,
      platformFeePaise: ready._sum.platformFeePaise || 0,
    },
    paid: {
      count: paid._count,
      consultantSharePaise: paid._sum.consultantSharePaise || 0,
      platformFeePaise: paid._sum.platformFeePaise || 0,
    },
    held: {
      count: held._count,
      consultantSharePaise: held._sum.consultantSharePaise || 0,
      platformFeePaise: held._sum.platformFeePaise || 0,
    },
    refunded: {
      count: refunded._count,
      consultantSharePaise: refunded._sum.consultantSharePaise || 0,
      platformFeePaise: refunded._sum.platformFeePaise || 0,
    },
    totalPlatformRevenue:
      (paid._sum.platformFeePaise || 0) + (ready._sum.platformFeePaise || 0),
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
  const [pending, ready, paid, held] = await Promise.all([
    prisma.organizationEarnings.aggregate({
      where: { organizationId, status: EarningStatus.PENDING },
      _sum: { orgSharePaise: true },
    }),
    prisma.organizationEarnings.aggregate({
      where: { organizationId, status: EarningStatus.READY },
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

  const pendingEarnings = pending._sum.orgSharePaise ?? 0;
  const readyEarnings = ready._sum.orgSharePaise ?? 0;
  const paidEarnings = paid._sum.orgSharePaise ?? 0;
  const heldEarnings = held._sum.orgSharePaise ?? 0;

  return {
    organizationId,
    totalEarnings:
      pendingEarnings + readyEarnings + paidEarnings + heldEarnings,
    pendingEarnings,
    readyEarnings,
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
