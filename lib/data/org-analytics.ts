/**
 * Shared analytics aggregate read for an organization.
 *
 * Extracted from GET /api/organizations/[orgId]/analytics so the route and
 * the org home + analytics server pages' SSR prefetch read through one code
 * path — the SSR cache and the CSR fetch can't drift. Auth stays at the call
 * site: the route enforces requireOrgAccess; the prefetch runs under the
 * dashboard layout's gate.
 *
 * Returns a fully plain/JSON-safe object (no Date, no bigint — money fields
 * pass through sumPaise) so it crosses the RSC→client boundary and React Query
 * hydration applies verbatim.
 */

import type { FundingSource, MemberRole, OrgStatus } from "@prisma/client";
import prisma from "@/lib/prisma";
import { ledgerAccountId } from "@/lib/payments/ledger/post";
import { sumPaise } from "@/lib/payments/utils/money";
import { resolveActivationSignals } from "@/lib/enterprise/org-activation-signals";
import { ENABLE_HOST_ORGS } from "@/lib/feature-flags";
import { hasOrgPermission } from "@/lib/auth/org-permissions";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export interface OrgMonthlySeriesPoint {
  month: string;
  spendPaise: number;
  engagementsCount: number;
  overagePaise: number;
  activeLearners: number;
}

export interface OrgProgramBreakdownRow {
  programId: string;
  name: string;
  subType: string;
  utilizedPaise: number;
  engagementsUsed: number;
  overageCount: number;
}

export interface OrgAnalyticsPayload {
  status: OrgStatus;
  capabilities: {
    canSponsor: boolean;
    canHost: boolean;
    fundingSource: FundingSource | null;
    walletBalance: number | null;
    currency: string | null;
  };
  activation: Awaited<ReturnType<typeof resolveActivationSignals>>;
  members: {
    total: number;
    active: number;
    byRole: Array<{ role: MemberRole; count: number }>;
  };
  programs: {
    total: number;
    active: number;
    activeAssignments: number;
  };
  monthlySeries: OrgMonthlySeriesPoint[];
  programBreakdown: OrgProgramBreakdownRow[];
  wallet: {
    balancePaise: number;
    recent: Array<{ reason: string; count: number; deltaPaise: number }>;
  } | null;
  invoices: {
    outstandingCount: number;
    outstandingPaise: number;
    pastDueCount: number;
    paidLast30dCount: number;
    paidLast30dPaise: number;
  } | null;
  subscription: {
    model: "PER_SEAT" | "FLAT_FEE";
    cycle: "MONTHLY" | "QUARTERLY" | "ANNUAL";
    flatFeePaise: number | null;
  } | null;
  reimbursements: {
    last30dCount: number;
    last30dPaise: number;
  } | null;
  earnings: Array<{
    status: string;
    count: number;
    orgSharePaise: number;
    refundedPaise: number;
  }> | null;
}

/** `null` when the org row doesn't exist (route maps this to a 404). */
export async function getOrgAnalytics(
  orgId: string,
): Promise<OrgAnalyticsPayload | null> {
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: {
      status: true,
      canSponsor: true,
      canHost: true,
      billingAccount: {
        select: {
          id: true,
          fundingSource: true,
          walletBalance: true,
          currency: true,
        },
      },
    },
  });
  if (!org) return null;

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - THIRTY_DAYS_MS);
  const sixMonthsStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1),
  );
  const monthKeys: string[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1),
    );
    monthKeys.push(
      `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`,
    );
  }

  // Same row as the include above: BillingAccount.ownerOrgId is a @unique
  // 1:1 back-reference to Organization.billingAccountId, so this is the
  // identical account — no separate round-trip needed. (Was a serial
  // findFirst that added one DB hop to every org home/analytics render.)
  const baId = org.billingAccount ? { id: org.billingAccount.id } : null;

  const [
    memberAggregate,
    memberByRole,
    programTotal,
    activeAssignments,
    recentWallet,
    outstandingInvoiceAgg,
    paidInvoiceAgg,
    pastDueInvoiceCount,
    earningsAggregate,
    licenseSubscription,
    reimbursementAgg,
    activationSignals,
    sixMonthUtilizations,
    programsWithUsage,
  ] = await Promise.all([
    prisma.membership.groupBy({
      by: ["status"],
      where: { organizationId: orgId },
      _count: { _all: true },
    }),
    prisma.membership.groupBy({
      by: ["role"],
      where: { organizationId: orgId, status: "ACTIVE" },
      _count: { _all: true },
    }),
    prisma.program.groupBy({
      by: ["status"],
      where: { contract: { organizationId: orgId } },
      _count: { _all: true },
    }),
    prisma.programAssignment.count({
      where: {
        program: { contract: { organizationId: orgId } },
        periodEnd: { gte: now },
      },
    }),
    // #772 B3 — wallet activity derives from the double-entry journal: group the
    // org's WALLET-account entries (last 30d) by originating txn kind and sum the
    // signed delta (CREDIT = +, DEBIT = −), preserving the {reason,count,deltaPaise}
    // shape. ORM read + JS aggregation (no raw SQL): the 30-day window per org is
    // bounded, so pulling the entries and folding them in app code is fine.
    org.billingAccount?.fundingSource === "WALLET" &&
    baId &&
    org.billingAccount.currency
      ? (async (): Promise<
          Array<{ reason: string; count: number; deltaPaise: number | null }>
        > => {
          const entries = await prisma.ledgerEntry.findMany({
            where: {
              // #783 — INR-only ledger; WALLET is keyed INR by every posting.
              accountId: ledgerAccountId({
                kind: "WALLET",
                organizationId: orgId,
              }),
              createdAt: { gte: thirtyDaysAgo },
            },
            select: {
              direction: true,
              amountPaise: true,
              transaction: { select: { kind: true } },
            },
          });
          // #780 — extended-client reads surface amountPaise as number.
          const byKind = new Map<string, { count: number; delta: number }>();
          for (const e of entries) {
            const kind = e.transaction.kind;
            const cur = byKind.get(kind) ?? { count: 0, delta: 0 };
            cur.count += 1;
            cur.delta +=
              e.direction === "CREDIT" ? e.amountPaise : -e.amountPaise;
            byKind.set(kind, cur);
          }
          return Array.from(byKind.entries()).map(([reason, v]) => ({
            reason,
            count: v.count,
            deltaPaise: v.delta,
          }));
        })()
      : Promise.resolve(
          [] as Array<{
            reason: string;
            count: number;
            deltaPaise: number | null;
          }>,
        ),
    org.billingAccount?.fundingSource === "INVOICE" && baId
      ? prisma.organizationInvoice.aggregate({
          where: {
            billingAccountId: baId.id,
            status: { in: ["ISSUED", "OVERDUE"] },
          },
          _sum: { totalPaise: true },
          _count: { _all: true },
        })
      : Promise.resolve(null),
    org.billingAccount?.fundingSource === "INVOICE" && baId
      ? prisma.organizationInvoice.aggregate({
          where: {
            billingAccountId: baId.id,
            status: "PAID",
            paidAt: { gte: thirtyDaysAgo },
          },
          _sum: { totalPaise: true },
          _count: { _all: true },
        })
      : Promise.resolve(null),
    org.billingAccount?.fundingSource === "INVOICE" && baId
      ? prisma.organizationInvoice.count({
          where: {
            billingAccountId: baId.id,
            status: "OVERDUE",
          },
        })
      : Promise.resolve(0),
    // Honesty gate (#687): with ENABLE_HOST_ORGS off no new splits accrue, so
    // don't surface host earnings even if canHost is still set on the row.
    ENABLE_HOST_ORGS && org.canHost
      ? prisma.organizationEarnings.groupBy({
          by: ["status"],
          where: { organizationId: orgId },
          _sum: { orgSharePaise: true, refundedAmountPaise: true },
          _count: { _all: true },
        })
      : Promise.resolve([]),
    // BillingSubscription is set up by the LICENSE contract create flow
    // (see app/api/organizations/[orgId]/contracts/route.ts). For LICENSE
    // orgs we surface it so the home Get-Started checklist can mark
    // "Configure billing settings" done once a fee has been captured.
    org.billingAccount?.fundingSource === "LICENSE" && baId
      ? prisma.billingSubscription.findUnique({
          where: { billingAccountId: baId.id },
          select: { id: true, model: true, cycle: true, flatFeePaise: true },
        })
      : Promise.resolve(null),
    // PERSONAL-funded orgs: org-tagged SUCCEEDED payments in the last
    // 30d (members paid out of pocket). Drives the /home reimbursement
    // summary card — full report lives at /reimbursements. (#714)
    org.billingAccount?.fundingSource === "PERSONAL"
      ? prisma.payment.aggregate({
          where: {
            organizationId: orgId,
            paymentStatus: "SUCCEEDED",
            createdAt: { gte: thirtyDaysAgo },
          },
          _sum: { amount: true },
          _count: { _all: true },
        })
      : Promise.resolve(null),
    // #777 §A / #779 §F — the extra signals (contract / KYB / contract-expiring /
    // pending-overage / stuck-payout / credit cap-near) the home action-center
    // needs but the tiles above don't already carry.
    resolveActivationSignals(orgId),
    typeof prisma.bookingUtilization?.findMany === "function"
      ? prisma.bookingUtilization.findMany({
          where: {
            reversedAt: null,
            deletedAt: null,
            createdAt: { gte: sixMonthsStart },
            programAssignment: {
              program: { contract: { organizationId: orgId } },
            },
          },
          select: {
            createdAt: true,
            engagementsConsumed: true,
            priceAtBookingPaise: true,
            wasOverage: true,
            overageEvent: {
              select: {
                marginalPaise: true,
                chargeStatus: true,
                reversedAt: true,
              },
            },
            programAssignment: {
              select: {
                membershipId: true,
                programId: true,
              },
            },
          },
        })
      : Promise.resolve([]),
    typeof prisma.program?.findMany === "function"
      ? prisma.program.findMany({
          where: {
            contract: { organizationId: orgId },
            archivedAt: null,
          },
          select: {
            id: true,
            name: true,
            type: true,
            assignments: {
              select: {
                engagementsUsed: true,
                consumedPaise: true,
                overageCount: true,
                utilizations: {
                  where: { reversedAt: null, deletedAt: null },
                  select: {
                    priceAtBookingPaise: true,
                    engagementsConsumed: true,
                    wasOverage: true,
                  },
                },
              },
            },
          },
          orderBy: { createdAt: "desc" },
        })
      : Promise.resolve([]),
  ]);

  const memberTotal = memberAggregate.reduce(
    (acc, s) => acc + s._count._all,
    0,
  );
  const memberActive =
    memberAggregate.find((s) => s.status === "ACTIVE")?._count._all ?? 0;

  const programActive =
    programTotal.find((p) => p.status === "ACTIVE")?._count._all ?? 0;
  const programTotalCount = programTotal.reduce(
    (acc, s) => acc + s._count._all,
    0,
  );

  const buckets = new Map<
    string,
    {
      spendPaise: number;
      engagementsCount: number;
      overagePaise: number;
      learners: Set<string>;
    }
  >();
  for (const key of monthKeys) {
    buckets.set(key, {
      spendPaise: 0,
      engagementsCount: 0,
      overagePaise: 0,
      learners: new Set<string>(),
    });
  }

  for (const u of sixMonthUtilizations) {
    const dt = u.createdAt instanceof Date ? u.createdAt : new Date(u.createdAt);
    const ym = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}`;
    const bucket = buckets.get(ym);
    if (!bucket) continue;

    const pricePaise = Number(u.priceAtBookingPaise ?? 0);
    const engagements = Number(u.engagementsConsumed ?? 0);
    bucket.spendPaise += pricePaise;
    bucket.engagementsCount += engagements;

    if (
      u.overageEvent &&
      !u.overageEvent.reversedAt &&
      u.overageEvent.chargeStatus !== "REVERSED" &&
      u.overageEvent.chargeStatus !== "BLOCKED"
    ) {
      bucket.overagePaise += Number(u.overageEvent.marginalPaise ?? 0);
    } else if (u.wasOverage && !u.overageEvent) {
      bucket.overagePaise += pricePaise;
    }

    if (u.programAssignment?.membershipId) {
      bucket.learners.add(u.programAssignment.membershipId);
    }
  }

  const monthlySeries: OrgMonthlySeriesPoint[] = monthKeys.map((month) => {
    const b = buckets.get(month)!;
    return {
      month,
      spendPaise: b.spendPaise,
      engagementsCount: b.engagementsCount,
      overagePaise: b.overagePaise,
      activeLearners: b.learners.size,
    };
  });

  const programBreakdown: OrgProgramBreakdownRow[] = programsWithUsage.map(
    (p) => {
      let utilizedPaise = 0;
      let engagementsUsed = 0;
      let overageCount = 0;

      for (const a of p.assignments ?? []) {
        const utilPaiseFromRows = (a.utilizations ?? []).reduce(
          (sum, u) => sum + Number(u.priceAtBookingPaise ?? 0),
          0,
        );
        const engagementsFromRows = (a.utilizations ?? []).reduce(
          (sum, u) => sum + Number(u.engagementsConsumed ?? 0),
          0,
        );
        const overagesFromRows = (a.utilizations ?? []).filter(
          (u) => u.wasOverage,
        ).length;

        utilizedPaise += Math.max(
          Number(a.consumedPaise ?? 0),
          utilPaiseFromRows,
        );
        engagementsUsed += Math.max(
          Number(a.engagementsUsed ?? 0),
          engagementsFromRows,
        );
        overageCount += Math.max(
          Number(a.overageCount ?? 0),
          overagesFromRows,
        );
      }

      return {
        programId: p.id,
        name: p.name,
        subType: p.type,
        utilizedPaise,
        engagementsUsed,
        overageCount,
      };
    },
  );

  return {
    status: org.status,
    capabilities: {
      canSponsor: org.canSponsor,
      canHost: org.canHost,
      fundingSource: org.billingAccount?.fundingSource ?? null,
      walletBalance: org.billingAccount?.walletBalance ?? null,
      currency: org.billingAccount?.currency ?? null,
    },
    activation: activationSignals,
    members: {
      total: memberTotal,
      active: memberActive,
      byRole: memberByRole.map((r) => ({
        role: r.role,
        count: r._count._all,
      })),
    },
    programs: {
      total: programTotalCount,
      active: programActive,
      activeAssignments,
    },
    monthlySeries,
    programBreakdown,
    wallet:
      org.billingAccount?.fundingSource === "WALLET"
        ? {
            balancePaise: org.billingAccount.walletBalance ?? 0,
            recent: recentWallet.map((r) => ({
              reason: r.reason,
              count: Number(r.count),
              deltaPaise: Number(r.deltaPaise ?? 0),
            })),
          }
        : null,
    invoices:
      org.billingAccount?.fundingSource === "INVOICE"
        ? {
            outstandingCount: outstandingInvoiceAgg?._count._all ?? 0,
            // #780 — _sum bypasses the result extension: bigint until sumPaise'd.
            outstandingPaise: sumPaise(outstandingInvoiceAgg?._sum.totalPaise),
            pastDueCount: pastDueInvoiceCount,
            paidLast30dCount: paidInvoiceAgg?._count._all ?? 0,
            paidLast30dPaise: sumPaise(paidInvoiceAgg?._sum.totalPaise),
          }
        : null,
    subscription: licenseSubscription
      ? {
          model: licenseSubscription.model,
          cycle: licenseSubscription.cycle,
          flatFeePaise: licenseSubscription.flatFeePaise,
        }
      : null,
    reimbursements: reimbursementAgg
      ? {
          last30dCount: reimbursementAgg._count._all,
          last30dPaise: sumPaise(reimbursementAgg._sum.amount),
        }
      : null,
    // Honesty gate (#687): mirror the query gate above — flag off ⇒ null, not
    // an empty array, so a still-canHost row doesn't imply zeroed host earnings.
    earnings:
      ENABLE_HOST_ORGS && org.canHost
        ? earningsAggregate.map((e) => ({
            status: e.status,
            count: e._count._all,
            orgSharePaise: sumPaise(e._sum.orgSharePaise),
            refundedPaise: sumPaise(e._sum.refundedAmountPaise),
          }))
        : null,
  };
}

/**
 * #1527 — money in the analytics payload follows the matrix: without
 * `billing.read` (SUPPORT) every paise figure goes; without `payouts.read`
 * (MANAGER, decision 1) the host-earnings split goes. Applied before the
 * payload leaves the server (API response and SSR seeds alike).
 */
export function orgAnalyticsForRole(
  payload: OrgAnalyticsPayload,
  role: MemberRole,
): OrgAnalyticsPayload {
  if (!hasOrgPermission(role, "billing.read")) {
    return {
      ...payload,
      capabilities: { ...payload.capabilities, walletBalance: null },
      // #1527 review — pendingOveragePaise is a paise figure too; keep the
      // non-money activation signals a SUPPORT viewer still needs.
      activation: { ...payload.activation, pendingOveragePaise: 0 },
      monthlySeries: (payload.monthlySeries ?? []).map((pt) => ({
        ...pt,
        spendPaise: 0,
        overagePaise: 0,
      })),
      programBreakdown: (payload.programBreakdown ?? []).map((row) => ({
        ...row,
        utilizedPaise: 0,
      })),
      wallet: null,
      invoices: null,
      subscription: null,
      reimbursements: null,
      earnings: null,
    };
  }
  if (!hasOrgPermission(role, "payouts.read")) {
    return { ...payload, earnings: null };
  }
  return payload;
}
