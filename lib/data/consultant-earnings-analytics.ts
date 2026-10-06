import "server-only";

import { format, startOfMonth, subMonths } from "date-fns";
import type { EarningStatus } from "@prisma/client";
import prisma from "@/lib/prisma";
import {
  getConsultantEarningsSummary,
  getConsultantEarnings,
  checkPayoutEligibility,
} from "@/lib/payments/payouts";
import {
  getConsultantPayouts,
  type ConsultantPayoutRow,
} from "@/lib/payments/payouts/payout-service";
import { isSponsoredPayment } from "@/lib/appointments/payment-display";
import {
  payoutNet,
  sanitizePayoutFailure,
  sumEarningBuckets,
  type BucketSums,
} from "@/lib/dashboard/earnings-state";
import { sumPaise } from "@/lib/payments/utils/money";
import { clawbackRecoveredByPayout } from "@/lib/payments/payouts/clawback-recovery";

export interface MonthlyEarning {
  /** Calendar month bucket, "YYYY-MM". */
  month: string;
  /** Sum of consultantSharePaise accrued in the month. */
  totalPaise: number;
  /** Number of earning records (≈ paid sessions) in the month. */
  count: number;
}

/**
 * Trailing per-month earnings buckets for the consultant analytics chart.
 * Aggregates ALL rows in the window (not the paginated history slice —
 * a `limit`-truncated reduce would undercount every month but the newest).
 * Empty months are zero-filled so the chart never has gaps.
 *
 * `organizationId` is an OPTIONAL view-scope filter (#org-appts #1024):
 * omitted (`undefined`) = no filter, identical to pre-#1024 behavior, for
 * any caller outside the earnings-view path. `null` scopes to personal
 * (B2C) earnings; a string scopes to that org's earnings.
 */
export async function getConsultantMonthlyEarnings(
  consultantProfileId: string,
  months = 6,
  organizationId?: string | null,
): Promise<MonthlyEarning[]> {
  // One clock read for the whole computation — repeated new Date() calls
  // could straddle a month rollover and misalign the buckets vs the query
  // window.
  const now = new Date();
  const since = startOfMonth(subMonths(now, months - 1));
  const rows = await prisma.consultantEarnings.findMany({
    where: {
      consultantProfileId,
      createdAt: { gte: since },
      ...(organizationId !== undefined ? { payment: { organizationId } } : {}),
    },
    select: { createdAt: true, consultantSharePaise: true },
  });

  const buckets = new Map<string, { totalPaise: number; count: number }>();
  for (let i = months - 1; i >= 0; i--) {
    buckets.set(format(subMonths(now, i), "yyyy-MM"), {
      totalPaise: 0,
      count: 0,
    });
  }
  for (const row of rows) {
    const bucket = buckets.get(format(row.createdAt, "yyyy-MM"));
    if (!bucket) continue;
    // consultantSharePaise is BigInt — convert before JSON serialization.
    // BigInt fallback keeps the ?? branch type-consistent (0n literal needs
    // ES2020 target, which this tsconfig doesn't set).
    bucket.totalPaise += Number(row.consultantSharePaise ?? BigInt(0));
    bucket.count += 1;
  }

  return Array.from(buckets, ([month, v]) => ({ month, ...v }));
}

export interface ConsultantEarningsPayloadOptions {
  status?: EarningStatus;
  limit?: number;
  offset?: number;
  includeMonthly?: boolean;
  /**
   * #org-appts (#1024) — VIEW scope. `null` (default, including when the
   * key is omitted entirely) = personal/B2C-only, matching the personal
   * dashboard's Earnings view. A string scopes to that org's earnings.
   * `undefined` means "no filter" (admin `?orgScope=all`) — passed
   * explicitly, since an omitted key defaults to personal instead.
   */
  organizationId?: string | null;
}

type EarningRecord = Awaited<
  ReturnType<typeof getConsultantEarnings>
>["earnings"][number];

/** One earning as the page reads it: the row, its plan title and its sponsor. */
export type ConsultantEarningRow = Omit<EarningRecord, "payment"> & {
  title: string | null;
  sponsorOrgName: string | null;
  payment: Omit<
    EarningRecord["payment"],
    "attributionSource" | "platformFeeBps"
  > & {
    attributionSource?: EarningRecord["payment"]["attributionSource"];
    platformFeeBps?: EarningRecord["payment"]["platformFeeBps"];
  };
};

export interface ConsultantFeeWaiverStatus {
  sessionsRemaining: number;
  totalSessionsGranted: number;
  expiresAt: Date;
}

export interface ConsultantTdsRecordRow {
  id: string;
  financialYear: string;
  quarter: number;
  cumulativeAmountCredited: number;
  tdsDeducted: number;
  tdsRateBps: number;
  tdsSection: string | null;
  payoutId: string | null;
  isReversal: boolean;
  reportedInForm26Q: boolean;
  form26QFilingDate: Date | null;
  challanNumber: string | null;
  certificateNumber: string | null;
  ackNumber: string | null;
  createdAt: Date;
}

export interface AttributionBreakdown {
  ownLinkPaise: number;
  marketplacePaise: number;
  ownLinkCount: number;
  marketplaceCount: number;
  feeWaivedCount: number;
}

export interface RepeatLearnerStats {
  repeatLearners: number;
  totalLearners: number;
  repeatLearnerRate: number | null;
}

export type { ConsultantPayoutRow };

export type ConsultantEarningsPayload = Awaited<
  ReturnType<typeof buildConsultantEarningsPayload>
>;

function planTitle(a: EarningRecord["payment"]["appointment"]): string | null {
  return (
    a?.consultation?.consultationPlan.title ??
    a?.subscription?.subscriptionPlan.title ??
    a?.trial?.subscriptionPlan.title ??
    a?.webinar?.webinarPlan.title ??
    a?.class?.classPlan.title ??
    null
  );
}

function toEarningRow(e: EarningRecord): ConsultantEarningRow {
  return {
    ...e,
    title: planTitle(e.payment.appointment),
    sponsorOrgName: isSponsoredPayment(e.payment)
      ? (e.payment.organization?.name ?? null)
      : null,
  };
}

/** The raw gateway text can embed provider ids; only plain words leave the server. */
function toPayoutRow(
  p: ConsultantPayoutRow,
  recoveredPaise: number,
): ConsultantPayoutRow & { recoveredPaise: number } {
  return {
    ...p,
    recoveredPaise,
    failureReason: p.failureReason
      ? sanitizePayoutFailure(p.failureReason)
      : null,
  };
}

async function readActiveFeeWaiver(
  consultantProfileId: string,
): Promise<ConsultantFeeWaiverStatus | null> {
  const now = new Date();
  const [waivers, config] = await Promise.all([
    prisma.consultantFeeWaiver?.findMany?.({
      where: {
        consultantProfileId,
        sessionsRemaining: { gt: 0 },
        expiresAt: { gt: now },
      },
      orderBy: { expiresAt: "asc" },
      select: { sessionsRemaining: true, expiresAt: true },
    }) ?? Promise.resolve([]),
    prisma.referralProgramConfig?.findUnique?.({
      where: { id: "singleton" },
      select: { expertWaiverSessions: true },
    }) ?? Promise.resolve(null),
  ]);
  if (!waivers || waivers.length === 0) return null;
  const sessionsRemaining = waivers.reduce(
    (sum, w) => sum + w.sessionsRemaining,
    0,
  );
  const perGrant = config?.expertWaiverSessions ?? 3;
  return {
    sessionsRemaining,
    totalSessionsGranted: Math.max(
      sessionsRemaining,
      waivers.length * perGrant,
    ),
    expiresAt: waivers[0].expiresAt,
  };
}

async function readConsultantTdsRecords(
  consultantProfileId: string,
): Promise<ConsultantTdsRecordRow[]> {
  const rows =
    (await prisma.tDSRecord?.findMany?.({
      where: { consultantProfileId },
      orderBy: [
        { financialYear: "desc" },
        { quarter: "desc" },
        { createdAt: "desc" },
      ],
      select: {
        id: true,
        financialYear: true,
        quarter: true,
        cumulativeAmountCredited: true,
        tdsDeducted: true,
        tdsRateBps: true,
        tdsSection: true,
        payoutId: true,
        isReversal: true,
        reportedInForm26Q: true,
        form26QFilingDate: true,
        challanNumber: true,
        certificateNumber: true,
        ackNumber: true,
        createdAt: true,
      },
    })) ?? [];
  return rows.map((r) => ({
    ...r,
    cumulativeAmountCredited: sumPaise(r.cumulativeAmountCredited),
    tdsDeducted: sumPaise(r.tdsDeducted),
  }));
}

async function readAttributionAndRepeatStats(
  consultantProfileId: string,
  organizationId: string | null | undefined,
): Promise<{
  attributionBreakdown: AttributionBreakdown;
  repeatLearnerStats: RepeatLearnerStats;
}> {
  const rows =
    (await prisma.consultantEarnings?.findMany?.({
      where: {
        consultantProfileId,
        status: { not: "REFUNDED" },
        ...(organizationId !== undefined
          ? { payment: { organizationId } }
          : {}),
      },
      select: {
        consultantSharePaise: true,
        refundedShareAmount: true,
        platformFeePaise: true,
        grossAmount: true,
        payment: {
          select: {
            userId: true,
            attributionSource: true,
            platformFeeBps: true,
            organizationId: true,
          },
        },
      },
    })) ?? [];

  let ownLinkPaise = 0;
  let marketplacePaise = 0;
  let ownLinkCount = 0;
  let marketplaceCount = 0;
  let feeWaivedCount = 0;
  const sessionsByLearner = new Map<string, number>();

  for (const row of rows) {
    const netShare = Math.max(
      0,
      sumPaise(row.consultantSharePaise) - sumPaise(row.refundedShareAmount),
    );
    const isB2C = !row.payment.organizationId;
    if (row.payment.attributionSource === "OWN_LINK") {
      ownLinkPaise += netShare;
      ownLinkCount += 1;
    } else if (isB2C) {
      marketplacePaise += netShare;
      marketplaceCount += 1;
    }
    if (
      isB2C &&
      sumPaise(row.grossAmount) > 0 &&
      (row.payment.platformFeeBps === 0 || sumPaise(row.platformFeePaise) === 0)
    ) {
      feeWaivedCount += 1;
    }
    if (row.payment.userId) {
      sessionsByLearner.set(
        row.payment.userId,
        (sessionsByLearner.get(row.payment.userId) ?? 0) + 1,
      );
    }
  }

  const totalLearners = sessionsByLearner.size;
  let repeatLearners = 0;
  for (const count of sessionsByLearner.values()) {
    if (count >= 2) repeatLearners += 1;
  }

  return {
    attributionBreakdown: {
      ownLinkPaise,
      marketplacePaise,
      ownLinkCount,
      marketplaceCount,
      feeWaivedCount,
    },
    repeatLearnerStats: {
      repeatLearners,
      totalLearners,
      repeatLearnerRate:
        totalLearners > 0
          ? Math.round((repeatLearners / totalLearners) * 100)
          : null,
    },
  };
}

/**
 * #1675 PR-Y — the three tile sums over the WHOLE account, not the fetched
 * page: one grouped read per status feeds Y-1's arithmetic, so the tiles and
 * the row badges share one bucket map. Paid out is the shared instrument
 * (payouts batch across scopes), so it is never org-scoped.
 */
async function getConsultantBucketTotals(
  consultantProfileId: string,
  organizationId: string | null | undefined,
): Promise<BucketSums> {
  const [byStatus, paid] = await Promise.all([
    prisma.consultantEarnings.groupBy({
      by: ["status"],
      where: {
        consultantProfileId,
        ...(organizationId !== undefined
          ? { payment: { organizationId } }
          : {}),
      },
      _sum: { consultantSharePaise: true, refundedShareAmount: true },
    }),
    // Not `_sum: { netAmount }`: a payout completed after a failed attempt can
    // carry netAmount null (payout-service nulls it on failure/reversal), and
    // the row shows amount − tdsDeducted for it, so the tile must too. Payout
    // counts are small (one batch a week at most), so the rows are reduced here.
    prisma.consultantPayout.findMany({
      where: { consultantProfileId, status: "COMPLETED" },
      select: { id: true, amount: true, tdsDeducted: true, netAmount: true },
    }),
  ]);
  const recovered = await clawbackRecoveredByPayout(
    prisma,
    paid.map((p) => p.id),
  );
  const sums = sumEarningBuckets(
    byStatus.map((g) => ({
      status: g.status,
      holdUntil: null,
      consultantSharePaise: sumPaise(g._sum.consultantSharePaise),
      refundedShareAmount: sumPaise(g._sum.refundedShareAmount),
    })),
    [],
  );
  const paidOut = paid.reduce(
    (acc, p) =>
      acc +
      payoutNet({
        amount: sumPaise(p.amount),
        tdsDeducted: sumPaise(p.tdsDeducted),
        netAmount: p.netAmount === null ? null : sumPaise(p.netAmount),
        recoveredPaise: recovered.get(p.id) ?? 0,
      }),
    0,
  );
  return { ...sums, paidOut };
}

/**
 * Single assembler for the GET /api/consultant/earnings response body,
 * shared by the route handler and the analytics page's SSR prefetch so the
 * dehydrated cache and the client refetch can never drift apart.
 */
export async function buildConsultantEarningsPayload(
  consultantProfileId: string,
  options: ConsultantEarningsPayloadOptions = {},
) {
  const { status, limit = 20, offset = 0, includeMonthly = false } = options;
  // Explicit key check (not a destructuring default): an admin's
  // `?orgScope=all` resolves to organizationId === undefined (no filter),
  // which a destructuring default would silently collapse back to `null`
  // (personal). Omitting the key entirely still defaults to personal —
  // #org-appts (#1024): VIEW splits by org-ness; payout eligibility stays
  // whole (shared instrument), so it's never scoped below.
  const organizationId: string | null | undefined =
    "organizationId" in options ? options.organizationId : null;

  const [summary, eligibility, history, monthlyEarnings, totals] =
    await Promise.all([
      getConsultantEarningsSummary(consultantProfileId, organizationId),
      // #org-appts (#1024) — VIEW splits by org-ness; payout eligibility
      // stays whole (shared instrument).
      checkPayoutEligibility(consultantProfileId),
      getConsultantEarnings(consultantProfileId, {
        status,
        limit,
        offset,
        organizationId,
      }),
      includeMonthly
        ? getConsultantMonthlyEarnings(consultantProfileId, 6, organizationId)
        : Promise.resolve(undefined),
      getConsultantBucketTotals(consultantProfileId, organizationId),
    ]);

  // #1675 PR-Y — the Paid-out bucket. A plain read after the fan-out, not
  // inside it: PG_POOL_MAX=1 makes one more parallel read a wait, not a win.
  const payouts = await getConsultantPayouts(consultantProfileId);
  const recovered = await clawbackRecoveredByPayout(
    prisma,
    payouts.map((p) => p.id),
  );
  const feeWaiver = await readActiveFeeWaiver(consultantProfileId);
  const tdsRecords = await readConsultantTdsRecords(consultantProfileId);
  const { attributionBreakdown, repeatLearnerStats } =
    await readAttributionAndRepeatStats(consultantProfileId, organizationId);

  return {
    summary,
    eligibility,
    earnings: history.earnings.map(toEarningRow),
    payouts: payouts.map((p) => toPayoutRow(p, recovered.get(p.id) ?? 0)),
    totals,
    feeWaiver,
    tdsRecords,
    attributionBreakdown,
    repeatLearnerStats,
    pagination: {
      total: history.total,
      limit,
      offset,
      hasMore: history.hasMore,
    },
    ...(monthlyEarnings ? { monthlyEarnings } : {}),
  };
}
