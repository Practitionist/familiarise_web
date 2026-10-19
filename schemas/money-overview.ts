/**
 * schemas/money-overview.ts
 *
 * The wire contract for the back-office "money in flight" dashboard. The
 * client parses every response with these schemas, so a payload that drifts
 * from the read model fails loudly at the boundary instead of rendering
 * `undefined` into a rupee figure.
 *
 * The shapes mirror `lib/backoffice/money-overview.ts` one-for-one; that file
 * is the definition and this file is its contract.
 */

import { z } from "zod";

/**
 * The windows the operator can compare. They live here, not in the read
 * model, because the client component needs the list and the read model
 * pulls in Prisma — a client bundle must never reach for the database.
 */
export const MONEY_OVERVIEW_PERIODS = [7, 30, 90] as const;
export type MoneyOverviewDays = (typeof MONEY_OVERVIEW_PERIODS)[number];
export const DEFAULT_MONEY_OVERVIEW_DAYS: MoneyOverviewDays = 30;

export function isMoneyOverviewDays(
  value: unknown,
): value is MoneyOverviewDays {
  return (
    typeof value === "number" &&
    (MONEY_OVERVIEW_PERIODS as readonly number[]).includes(value)
  );
}

/** A metric with its prior-period comparison. */
export const moneyMetricSchema = z.object({
  current: z.number(),
  prior: z.number(),
  delta: z.number(),
  deltaPct: z.number().nullable(),
  unit: z.enum(["paise", "ratio"]),
});

/** One day of the GMV / net-revenue series, with the prior period alongside. */
export const moneyTrendPointSchema = z.object({
  day: z.string(),
  label: z.string(),
  gmvPaise: z.number(),
  netRevenuePaise: z.number(),
  priorGmvPaise: z.number(),
  priorNetRevenuePaise: z.number(),
});

export const disputeAgingBucketSchema = z.object({
  key: z.enum(["due-0-2", "due-3-5", "due-6-10", "due-10-plus"]),
  label: z.string(),
  count: z.number(),
  amountPaise: z.number(),
  overdue: z.number(),
});

export const disputeAgingSchema = z.object({
  buckets: z.array(disputeAgingBucketSchema),
  openCount: z.number(),
  openAmountPaise: z.number(),
  noDeadlineCount: z.number(),
});

export const payoutLatencyBucketSchema = z.object({
  key: z.enum(["under-1d", "1-2d", "3-5d", "6-10d", "over-10d"]),
  label: z.string(),
  count: z.number(),
  priorCount: z.number(),
});

export const payoutRailStatsSchema = z.object({
  rail: z.enum(["consultant", "organization"]),
  created: z.number(),
  completed: z.number(),
  failed: z.number(),
  cancelled: z.number(),
  inFlight: z.number(),
  completionRate: z.number(),
});

export const payoutLatencySchema = z.object({
  buckets: z.array(payoutLatencyBucketSchema),
  rails: z.array(payoutRailStatsSchema),
  created: z.number(),
  completed: z.number(),
  failed: z.number(),
  cancelled: z.number(),
  inFlight: z.number(),
  completionRate: z.number(),
  medianLatencyHours: z.number().nullable(),
});

export const liabilityBucketSchema = z.object({
  key: z.enum(["t0", "t1", "t7", "later"]),
  label: z.string(),
  amountPaise: z.number(),
  count: z.number(),
});

export const liabilityLadderSchema = z.object({
  buckets: z.array(liabilityBucketSchema),
  consultantTotalPaise: z.number(),
  organizationTotalPaise: z.number(),
  walletBalancePaise: z.number(),
  dueNowCount: z.number(),
});

export const statutoryCountdownSchema = z.object({
  label: z.string(),
  amountPaise: z.number(),
  count: z.number(),
  dueAt: z.string(),
  daysUntilDue: z.number(),
  dueLabel: z.string(),
});

export const reconcileFindingSchema = z.object({
  kind: z.string(),
  scope: z.string(),
  expectedPaise: z.number().nullable(),
  actualPaise: z.number().nullable(),
  deltaPaise: z.number().nullable(),
  detail: z.string().nullable(),
});

export const reconcileBreaksSchema = z.object({
  lastRunAt: z.string().nullable(),
  ok: z.boolean(),
  durationMs: z.number().nullable(),
  scope: z.string().nullable(),
  findings: z.array(reconcileFindingSchema),
  recentRuns: z.number(),
  recentFailures: z.number(),
});

export const needsHumanMoneySchema = z.object({
  count: z.number(),
  amountPaise: z.number(),
});

export const moneyAtRiskSchema = z.object({
  gatewayCount: z.number(),
  gatewayAmountPaise: z.number(),
  buyerCount: z.number(),
  buyerAmountPaise: z.number(),
  totalAmountPaise: z.number(),
});

export const refundReasonSliceSchema = z.object({
  reason: z.string(),
  label: z.string(),
  count: z.number(),
  amountPaise: z.number(),
  share: z.number(),
  countShare: z.number(),
  priorCount: z.number(),
  priorAmountPaise: z.number(),
});

export const moneyOverviewSchema = z.object({
  period: z.object({
    days: z.union([z.literal(7), z.literal(30), z.literal(90)]),
    current: z.object({
      start: z.string(),
      end: z.string(),
      label: z.string(),
    }),
    prior: z.object({
      start: z.string(),
      end: z.string(),
      label: z.string(),
    }),
    baselineLabel: z.string(),
  }),
  stats: z.object({
    gmv: moneyMetricSchema,
    netRevenue: moneyMetricSchema,
    takeRate: moneyMetricSchema,
    refundRate: moneyMetricSchema,
    disputeRate: moneyMetricSchema,
  }),
  grossUp: z.object({
    gmvPaise: z.number(),
    netRevenuePaise: z.number(),
    platformFeePaise: z.number(),
    discountPaise: z.number(),
    refundedFeePaise: z.number(),
    paymentsWithoutFeeRate: z.number(),
  }),
  series: z.array(moneyTrendPointSchema),
  disputeAging: disputeAgingSchema,
  payoutLatency: payoutLatencySchema,
  liabilityLadder: liabilityLadderSchema,
  liabilities: z.object({
    tds: statutoryCountdownSchema,
    gst: statutoryCountdownSchema,
  }),
  reconciliation: reconcileBreaksSchema,
  needsHuman: needsHumanMoneySchema,
  atRisk: moneyAtRiskSchema,
  refundReasons: z.array(refundReasonSliceSchema),
});

export const moneyDrillRowSchema = z.object({
  id: z.string(),
  label: z.string(),
  detail: z.string(),
  amountPaise: z.number().nullable(),
  status: z.string().nullable(),
  at: z.string().nullable(),
});

export const moneyDrillSchema = z.object({
  key: z.string(),
  title: z.string(),
  description: z.string(),
  rows: z.array(moneyDrillRowSchema),
  truncated: z.boolean(),
});

/** The API response: the overview, and the drill-through rows when asked for. */
export const moneyOverviewResponseSchema = z.object({
  overview: moneyOverviewSchema,
  drill: moneyDrillSchema.nullable(),
});

export type MoneyOverviewWire = z.infer<typeof moneyOverviewSchema>;
export type MoneyDrillWire = z.infer<typeof moneyDrillSchema>;
export type MoneyOverviewResponseWire = z.infer<
  typeof moneyOverviewResponseSchema
>;

/**
 * The reconciler's `findings` column is free-form JSON written by the
 * reconciler, so it is parsed rather than cast. Every field is optional
 * because a finding written by an older reconciler may not carry them all.
 */
export const reconcileFindingsSchema = z.array(
  z
    .object({
      kind: z.string().optional(),
      orgId: z.string().nullable().optional(),
      accountId: z.string().nullable().optional(),
      expectedPaise: z.number().nullable().optional(),
      actualPaise: z.number().nullable().optional(),
      deltaPaise: z.number().nullable().optional(),
      details: z.unknown().optional(),
    })
    .passthrough(),
);
