import { EarningStatus, PayoutStatus, Prisma } from "@prisma/client";
import type { PrismaLike } from "@/lib/prisma";
import { ENABLE_TDS_194O_GROSS } from "@/lib/feature-flags";
import { recordSystemEventSafe } from "@/lib/enterprise/system-events";
import type { ResolvedTdsRate } from "@/lib/compliance/tds";
import {
  resolve194OTaxablePaise,
  settle194OWithholding,
} from "@/lib/compliance/tds-194o";
import {
  getFYDateRange,
  TDS_THRESHOLD_PAISE,
} from "@/lib/payments/tax/tds-service";
import { prorate, sumPaise } from "@/lib/payments/utils/money";
import { computeResidentPayoutTds } from "./shared-lifecycle";

/** Payouts whose staged TDS counts toward the expert's history. */
const LIVE_PAYOUT_STATUSES = [PayoutStatus.PROCESSING, PayoutStatus.COMPLETED];

export type ConsultantTdsInput = {
  consultantProfileId: string;
  /** Excluded from every read so the payout never counts its own gross or TDS; null for a preview. */
  payoutId: string | null;
  netSharePaise: number;
  grossThisPayoutPaise: number;
  /** The most this payout can withhold: its amount less clawback recovery. */
  capacityPaise: number;
  financialYear: string;
  /** FY sum of COMPLETED net-share payouts; read only by the LEGACY engine. */
  cumulativeBeforePayout: number;
  taxInfo: {
    taxEntityType?: string | null;
    panEncrypted?: Uint8Array | string | null;
    panVerified: boolean;
  } | null;
  resolvedRate: ResolvedTdsRate;
  /** False after losing the one-catch-up-per-FY race; the payout then pays on its own gross. */
  allowCatchUp: boolean;
};

export type ConsultantTdsPlan = {
  withholdPaise: number;
  creditPaise: number;
  carryPaise: number;
  catchUpFy: string | null;
  rateAppliedBps: number;
  tdsSection: string;
  taxablePaise: number;
  reason: string;
};

/** Gross of a set of earnings after pro-rated refunds; `fallbackPaise` when no gross is recorded. */
export async function earningsGrossPaise(
  db: PrismaLike,
  where: Prisma.ConsultantEarningsWhereInput,
  fallbackPaise: number,
): Promise<number> {
  const agg = await db.consultantEarnings.aggregate({
    where,
    _sum: {
      grossAmount: true,
      consultantSharePaise: true,
      refundedShareAmount: true,
    },
  });
  const raw = sumPaise(agg._sum.grossAmount);
  if (raw <= 0) return fallbackPaise;
  return subtractProportionalGrossRefund(
    raw,
    sumPaise(agg._sum.consultantSharePaise),
    sumPaise(agg._sum.refundedShareAmount),
  );
}

function subtractProportionalGrossRefund(
  grossPaise: number,
  sharePaise: number,
  refundedSharePaise: number,
): number {
  if (grossPaise <= 0 || refundedSharePaise <= 0) {
    return Math.max(0, grossPaise);
  }
  if (sharePaise > 0) {
    const proportionalGrossRefund = prorate(
      grossPaise,
      refundedSharePaise,
      sharePaise,
      "round",
    );
    return Math.max(0, grossPaise - proportionalGrossRefund);
  }
  return Math.max(0, grossPaise - refundedSharePaise);
}

// A PAN counts as on file for 194-O only once it is verified; an unverified PAN takes the no-PAN rate.
function consultantPanOnFile(taxInfo: ConsultantTdsInput["taxInfo"]): boolean {
  return !!taxInfo?.panEncrypted && taxInfo.panVerified === true;
}

/**
 * Plans a consultant payout's TDS: the threshold due from the engine, plus any
 * carry owed by earlier payouts, settled against what this payout can absorb.
 */
export async function planConsultantPayoutTds(
  db: PrismaLike,
  input: ConsultantTdsInput,
): Promise<ConsultantTdsPlan> {
  const pan = consultantPanOnFile(input.taxInfo);
  const tdsOn = (paise: number) =>
    computeResidentPayoutTds(paise, pan, input.resolvedRate).tdsAmountPaise;
  const own = computeResidentPayoutTds(
    input.grossThisPayoutPaise,
    pan,
    input.resolvedRate,
  );

  const history = await loadTdsHistory(db, input);
  const due = await resolveDueTds(db, input, tdsOn, history.assignedPaise);
  const settled = settle194OWithholding({
    dueTdsPaise: due.dueTdsPaise,
    carryInPaise: history.carryInPaise,
    capacityPaise: input.capacityPaise,
  });
  const withholds = settled.withholdPaise > 0 || settled.creditPaise > 0;
  return {
    ...settled,
    catchUpFy: due.catchUp ? input.financialYear : null,
    rateAppliedBps: withholds ? own.rateAppliedBps : 0,
    tdsSection: own.tdsSection,
    taxablePaise: due.taxablePaise,
    reason: due.reason,
  };
}

async function resolveDueTds(
  db: PrismaLike,
  input: ConsultantTdsInput,
  tdsOn: (paise: number) => number,
  loadAssignedPaise: () => Promise<number>,
): Promise<{
  dueTdsPaise: number;
  taxablePaise: number;
  catchUp: boolean;
  reason: string;
}> {
  if ((process.env.TDS_ENGINE ?? "194O") === "LEGACY") {
    const before = input.cumulativeBeforePayout;
    const after = before + input.netSharePaise;
    const taxablePaise =
      after <= TDS_THRESHOLD_PAISE
        ? 0
        : before >= TDS_THRESHOLD_PAISE
          ? input.netSharePaise
          : after - TDS_THRESHOLD_PAISE;
    return {
      dueTdsPaise: tdsOn(taxablePaise),
      taxablePaise,
      catchUp: false,
      reason: `LEGACY ₹50K FY threshold (cumulative=${after} paise)`,
    };
  }

  const resolved = resolve194OTaxablePaise({
    grossBeforePaise: await priorFyGrossPaise(db, input),
    grossThisPayoutPaise: input.grossThisPayoutPaise,
    entityType: input.taxInfo?.taxEntityType ?? null,
    panOnFile: consultantPanOnFile(input.taxInfo),
  });

  if (!ENABLE_TDS_194O_GROSS || process.env.ENABLE_TDS_194O_GROSS === "false") {
    if (input.payoutId && resolved.taxablePaise !== input.netSharePaise) {
      await recordSystemEventSafe({
        category: "PAYOUT",
        severity: "INFO",
        message: `TDS_194O_GROSS_SHADOW_DIFF: payout ${input.payoutId} grossTaxablePaise=${resolved.taxablePaise} differs from netSharePaise=${input.netSharePaise}`,
        context: {
          payoutId: input.payoutId,
          consultantProfileId: input.consultantProfileId,
          grossTaxablePaise: resolved.taxablePaise,
          netSharePaise: input.netSharePaise,
          reason: resolved.reason,
        },
      });
    }
    return {
      dueTdsPaise: tdsOn(input.netSharePaise),
      taxablePaise: input.netSharePaise,
      catchUp: false,
      reason: "194-O shadow mode — withheld on the net share",
    };
  }

  if (!resolved.yearToDate) {
    return {
      dueTdsPaise: tdsOn(resolved.taxablePaise),
      taxablePaise: resolved.taxablePaise,
      catchUp: false,
      reason: resolved.reason,
    };
  }

  const requiredPaise = tdsOn(resolved.taxablePaise);
  const assignedPaise = await loadAssignedPaise();
  const catchUp = requiredPaise > 0 && assignedPaise <= 0;
  if (catchUp && !input.allowCatchUp) {
    return {
      dueTdsPaise: Math.min(
        requiredPaise - assignedPaise,
        tdsOn(input.grossThisPayoutPaise),
      ),
      taxablePaise: input.grossThisPayoutPaise,
      catchUp: false,
      reason: `${resolved.reason}; FY catch-up already taken by another payout`,
    };
  }
  return {
    dueTdsPaise: requiredPaise - assignedPaise,
    taxablePaise: resolved.taxablePaise,
    catchUp,
    reason: catchUp
      ? `${resolved.reason}; FY catch-up on the year-to-date gross`
      : `${resolved.reason}; net of TDS already assigned this FY (${assignedPaise} paise)`,
  };
}

/** FY gross before this payout, attributed by each payout's TDS stamp; unstamped legacy payouts fall back to paidAt. */
async function priorFyGrossPaise(
  db: PrismaLike,
  input: ConsultantTdsInput,
): Promise<number> {
  const fyRange = getFYDateRange(input.financialYear);
  return earningsGrossPaise(
    db,
    {
      consultantProfileId: input.consultantProfileId,
      ...(input.payoutId ? { payoutId: { not: input.payoutId } } : {}),
      OR: [
        {
          status: { in: [EarningStatus.PAID, EarningStatus.BATCHED] },
          payout: {
            status: { in: LIVE_PAYOUT_STATUSES },
            tdsFinancialYear: input.financialYear,
          },
        },
        {
          status: EarningStatus.PAID,
          paidAt: { gte: fyRange.start, lt: fyRange.end },
          payout: { tdsFinancialYear: null },
        },
      ],
    },
    0,
  );
}

/**
 * Reads the expert's other live payouts once: the TDS still carried forward
 * (any FY), and a loader for the TDS already assigned to this FY at the
 * with-PAN rate (withheld + carried − credited − refund-reversed).
 */
async function loadTdsHistory(
  db: PrismaLike,
  input: ConsultantTdsInput,
): Promise<{ carryInPaise: number; assignedPaise: () => Promise<number> }> {
  const otherLive = {
    consultantProfileId: input.consultantProfileId,
    status: { in: LIVE_PAYOUT_STATUSES },
    ...(input.payoutId ? { id: { not: input.payoutId } } : {}),
  } satisfies Prisma.ConsultantPayoutWhereInput;
  const rows = await db.consultantPayout.groupBy({
    by: ["tdsFinancialYear", "tdsRateAppliedBps"],
    where: otherLive,
    _sum: { tdsDeducted: true, tdsCarryPaise: true, tdsCreditPaise: true },
  });
  const noPanBps = input.resolvedRate.noPanRateBps;
  const fyRows = rows.filter(
    (r) =>
      r.tdsFinancialYear === input.financialYear &&
      r.tdsRateAppliedBps !== noPanBps,
  );
  const carryInPaise = rows.reduce(
    (sum, r) => sum + sumPaise(r._sum.tdsCarryPaise),
    0,
  );
  const fyAssignedPaise = fyRows.reduce(
    (sum, r) =>
      sum +
      sumPaise(r._sum.tdsDeducted) +
      sumPaise(r._sum.tdsCarryPaise) -
      sumPaise(r._sum.tdsCreditPaise),
    0,
  );
  const fyWithheldPaise = fyRows.reduce(
    (sum, r) => sum + sumPaise(r._sum.tdsDeducted),
    0,
  );

  return {
    carryInPaise,
    assignedPaise: async () => {
      if (fyWithheldPaise <= 0) return fyAssignedPaise;
      const reversals = await db.tDSRecord.aggregate({
        where: {
          isReversal: true,
          payout: {
            ...otherLive,
            tdsFinancialYear: input.financialYear,
            tdsCreditPaise: 0,
            OR: [
              { tdsRateAppliedBps: null },
              { tdsRateAppliedBps: { not: noPanBps } },
            ],
          },
        },
        _sum: { tdsDeducted: true },
      });
      return fyAssignedPaise + sumPaise(reversals._sum.tdsDeducted);
    },
  };
}
