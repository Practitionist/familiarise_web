/**
 * The back-office "money in flight" read model.
 *
 * ONE place defines every number on the Money overview page: the window, the
 * `where` behind each metric, the arithmetic behind each metric, and the rows
 * a drill-through opens. The page and the API route both read this file, so a
 * card and the rows behind it can never be different populations.
 *
 * The rules this file obeys, and why:
 * - Every metric is computed from a NAMED `where` (`collectedPaymentWhere`,
 *   `refundedInWindowWhere`, `disputeOpenedWhere`, …). The drill-through list
 *   for a metric reads the same `where`, so the number and the rows are the
 *   same population. This extends the discipline the nav badges already use
 *   (`lib/backoffice/queue-predicates.ts`); it does not invent a second way.
 * - Every exclusion happens in the Prisma `where`, never in JS after the read.
 * - Money is BigInt paise in the database. The Prisma result extension
 *   (`lib/prisma-extensions.ts`) maps money columns to `number` at the client
 *   boundary, but aggregations (`_sum`) bypass that extension, so every
 *   aggregate goes through `sumPaise`.
 * - No React in this file. It is pure reads over Prisma.
 */

import type { Prisma } from "@prisma/client";

import prisma from "@/lib/prisma";
import { readRefundNeedsHuman } from "@/lib/backoffice/needs-human";
import { OPEN_DISPUTE_STATUSES } from "@/lib/backoffice/queue-predicates";
import { sumPaise } from "@/lib/payments/utils/money";
import {
  getIndianFinancialYear,
  getIndianFYQuarter,
} from "@/lib/payments/tax/tds-service";
import { reconcileFindingsSchema } from "@/schemas/money-overview";
import {
  DEFAULT_MONEY_OVERVIEW_DAYS,
  type MoneyOverviewDays,
} from "@/schemas/money-overview";

/** A half-open window: `start` inclusive, `end` exclusive. */
export interface MoneyWindow {
  start: Date;
  end: Date;
}

export interface MoneyPeriods {
  days: MoneyOverviewDays;
  current: MoneyWindow;
  prior: MoneyWindow;
}

function utcMidnight(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0),
  );
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d.getTime());
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

/**
 * The current window and the one before it.
 *
 * Both are the same length and both are aligned to UTC day boundaries (the
 * same day boundary the payout trend chart uses), so the prior period is
 * like-for-like. The current window ends at the end of today, so today's
 * (still running) figures sit in the last bucket; the prior window's last
 * bucket was a complete day when it was measured. The window is half-open —
 * `start` inclusive, `end` exclusive.
 */
export function moneyOverviewPeriods(
  days: MoneyOverviewDays = DEFAULT_MONEY_OVERVIEW_DAYS,
  now: Date = new Date(),
): MoneyPeriods {
  const today = utcMidnight(now);
  const currentStart = addDays(today, -(days - 1));
  const priorStart = addDays(currentStart, -days);
  return {
    days,
    current: { start: currentStart, end: addDays(today, 1) },
    prior: { start: priorStart, end: currentStart },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The named `where`s. Every metric and every drill-through list below reads
// one of these, so a card can never count a different set than its rows.
// ─────────────────────────────────────────────────────────────────────────────

/** Two-party disputes that are still live (a reply or a ruling is owed). */
export const OPEN_BUYER_DISPUTE_STATUSES = [
  "OPEN",
  "RESPONDED",
  "ESCALATED",
  "UNDER_REVIEW",
] as const;

/** Money actually collected: a captured payment that is not soft-deleted. */
export function collectedPaymentWhere(
  window: MoneyWindow,
): Prisma.PaymentWhereInput {
  return {
    paymentStatus: "SUCCEEDED",
    deletedAt: null,
    createdAt: { gte: window.start, lt: window.end },
  };
}

/**
 * Refunds that actually left the till in the window, against a live payment.
 * Activity basis: the refund's own date is in the window, so the ratio reads
 * "money refunded this period ÷ money collected this period" and is not
 * biased by how long ago each payment was made.
 *
 * `reason` narrows the read to one reason code — `""` is the code for a
 * refund with no reason recorded, so it filters on NULL rather than being
 * treated as "no filter".
 */
export function refundedInWindowWhere(
  window: MoneyWindow,
  reason?: string | null,
): Prisma.RefundWhereInput {
  return {
    status: "SUCCEEDED",
    deletedAt: null,
    createdAt: { gte: window.start, lt: window.end },
    payment: { is: { paymentStatus: "SUCCEEDED", deletedAt: null } },
    ...(reason === undefined || reason === null
      ? {}
      : { reason: reason === "" ? null : reason }),
  };
}

/** Gateway chargebacks opened in the window — dated by when they were raised. */
export function disputeOpenedWhere(
  window: MoneyWindow,
): Prisma.DisputeWhereInput {
  return { createdAt: { gte: window.start, lt: window.end } };
}

/** Two-party buyer disputes opened in the window. */
export function buyerDisputeOpenedWhere(
  window: MoneyWindow,
): Prisma.PurchaseDisputeWhereInput {
  return { createdAt: { gte: window.start, lt: window.end } };
}

/** Payouts raised in the window (both rails share the same shape). */
export function payoutCreatedWhere(
  window: MoneyWindow,
): Prisma.ConsultantPayoutWhereInput {
  return { createdAt: { gte: window.start, lt: window.end } };
}

export function orgPayoutCreatedWhere(
  window: MoneyWindow,
): Prisma.OrganizationPayoutWhereInput {
  return { createdAt: { gte: window.start, lt: window.end } };
}

/**
 * Gateway chargebacks still in proceedings. The status set is the one the
 * nav badge already counts (`lib/backoffice/queue-predicates.ts`), so the
 * dispute tab, the badge and this page all count the same rows.
 */
export function openGatewayDisputeWhere(): Prisma.DisputeWhereInput {
  return { status: { in: OPEN_DISPUTE_STATUSES } };
}

/** Two-party buyer disputes still live: a reply or a ruling is owed. */
export function openBuyerDisputeWhere(): Prisma.PurchaseDisputeWhereInput {
  return { status: { in: [...OPEN_BUYER_DISPUTE_STATUSES] } };
}

/** Earnings that are ready to be paid out but have not been. */
export function readyEarningsWhere(): Prisma.ConsultantEarningsWhereInput {
  return { status: "READY" };
}

export function readyOrgEarningsWhere(): Prisma.OrganizationEarningsWhereInput {
  return { status: "READY" };
}

// ─────────────────────────────────────────────────────────────────────────────
// The per-payment arithmetic. One place, shared by the cards, the daily
// series and the drill-through rows, so the three can never disagree.
// ─────────────────────────────────────────────────────────────────────────────

/** The money columns one payment contributes to the metrics. */
export interface PaymentMoneyRow {
  amount: number;
  originalAmount: number;
  taxAmount: number;
  platformFeeBps: number | null;
}

/**
 * The platform's fee on one sale: the rate stamped on the payment, applied to
 * the gross (list) price. The stamp is what the settlement actually charged,
 * so it is the only honest source for "what did we keep on this sale".
 * A payment with no stamp contributes nothing — the count of those is shown
 * beside the metric rather than quietly estimated away.
 */
export function platformFeePaise(row: PaymentMoneyRow): number {
  if (row.platformFeeBps === null) return 0;
  return Math.floor((row.originalAmount * row.platformFeeBps) / 10_000);
}

/**
 * The price reduction given on one sale: the gap between the gross price plus
 * tax and what the buyer was charged. It is the discount code plus the
 * welcome discount, net of any referral credit that was spent.
 */
export function discountGivenPaise(row: PaymentMoneyRow): number {
  return Math.max(0, row.originalAmount + row.taxAmount - row.amount);
}

/**
 * The platform's fee given back by a refund, pro-rata at the stamped rate.
 */
export function refundedFeePaise(
  row: PaymentMoneyRow,
  refundedPaise: number,
): number {
  if (row.platformFeeBps === null) return 0;
  return Math.floor((refundedPaise * row.platformFeeBps) / 10_000);
}

/**
 * The platform's retained money on one sale: its fee, less the discount the
 * platform funded, less the fee a refund on that sale gave back.
 *
 * This is the platform's take, so "take rate" (this ÷ GMV) is the share of
 * every collected rupee the platform keeps. GMV is tax-inclusive and
 * already net of discounts, which is why the discount is subtracted here and
 * not from GMV.
 */
export function netRevenuePaise(
  row: PaymentMoneyRow,
  refundedPaise = 0,
): number {
  return (
    platformFeePaise(row) -
    discountGivenPaise(row) -
    refundedFeePaise(row, refundedPaise)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The payload shape.
// ─────────────────────────────────────────────────────────────────────────────

/** A metric with its prior-period comparison. */
export interface MoneyMetric {
  current: number;
  prior: number;
  /** `current − prior`. For a ratio this is a difference in percentage points. */
  delta: number;
  /** null when the prior value is 0 — a percentage change off zero is noise. */
  deltaPct: number | null;
  /** How the UI should read `current` and `delta`. */
  unit: "paise" | "ratio";
}

function metric(
  current: number,
  prior: number,
  unit: "paise" | "ratio",
): MoneyMetric {
  return {
    current,
    prior,
    delta: current - prior,
    deltaPct: prior === 0 ? null : (current - prior) / prior,
    unit,
  };
}

/** One day of the GMV / net-revenue series, with the prior period alongside. */
export interface MoneyTrendPoint {
  day: string;
  label: string;
  gmvPaise: number;
  netRevenuePaise: number;
  priorGmvPaise: number;
  priorNetRevenuePaise: number;
}

/** One band of the dispute-aging ladder. */
export interface DisputeAgingBucket {
  key: "due-0-2" | "due-3-5" | "due-6-10" | "due-10-plus";
  label: string;
  count: number;
  amountPaise: number;
  /** Rows whose deadline has already passed. */
  overdue: number;
}

export interface DisputeAging {
  buckets: DisputeAgingBucket[];
  openCount: number;
  openAmountPaise: number;
  /** Open rows with no deadline on file — they cannot be aged. */
  noDeadlineCount: number;
}

/** One band of the payout-latency histogram. */
export interface PayoutLatencyBucket {
  key: "under-1d" | "1-2d" | "3-5d" | "6-10d" | "over-10d";
  label: string;
  count: number;
  /** The same band in the prior window — the comparison baseline. */
  priorCount: number;
}

/** One rail of the payout panel (consultant payouts, organisation payouts). */
export interface PayoutRailStats {
  rail: "consultant" | "organization";
  created: number;
  completed: number;
  failed: number;
  cancelled: number;
  inFlight: number;
  completionRate: number;
}

export interface PayoutLatency {
  buckets: PayoutLatencyBucket[];
  rails: PayoutRailStats[];
  created: number;
  completed: number;
  failed: number;
  cancelled: number;
  inFlight: number;
  completionRate: number;
  /** Median hours from raised to processed, over completed payouts. */
  medianLatencyHours: number | null;
}

/** One rung of the T+N liability ladder. */
export interface LiabilityBucket {
  key: "t0" | "t1" | "t7" | "later";
  label: string;
  amountPaise: number;
  count: number;
}

export interface LiabilityLadder {
  buckets: LiabilityBucket[];
  /** Consultant earnings ready but not yet in a payout. */
  consultantTotalPaise: number;
  /** Organisation earnings ready but not yet in a payout. */
  organizationTotalPaise: number;
  /** Org wallet balances held — money we owe on demand, not a scheduled payout. */
  walletBalancePaise: number;
  /** READY rows with no hold date: payable now. */
  dueNowCount: number;
}

/** A statutory liability with its next due date. */
export interface StatutoryCountdown {
  label: string;
  amountPaise: number;
  count: number;
  /** ISO date of the next deadline. */
  dueAt: string;
  /** Whole days from now until the deadline; negative once it has passed. */
  daysUntilDue: number;
  /** What the deadline is. */
  dueLabel: string;
}

/** One break the ledger reconciler found. */
export interface ReconcileFinding {
  kind: string;
  scope: string;
  expectedPaise: number | null;
  actualPaise: number | null;
  deltaPaise: number | null;
  detail: string | null;
}

export interface ReconcileBreaks {
  lastRunAt: string | null;
  ok: boolean;
  durationMs: number | null;
  scope: string | null;
  findings: ReconcileFinding[];
  /** Runs in the last 30 days, and how many of them were not clean. */
  recentRuns: number;
  recentFailures: number;
}

/** The "money a person still has to handle" line. */
export interface NeedsHumanMoney {
  count: number;
  amountPaise: number;
}

/** Money that is exposed if the open disputes go against us. */
export interface MoneyAtRisk {
  gatewayCount: number;
  gatewayAmountPaise: number;
  buyerCount: number;
  buyerAmountPaise: number;
  totalAmountPaise: number;
}

/** One refund reason code. */
export interface RefundReasonSlice {
  /** The stored reason code. "" is the code for "no reason recorded". */
  reason: string;
  /** What to print for that code. */
  label: string;
  count: number;
  amountPaise: number;
  /** Share of the refunded amount, 0..1. */
  share: number;
  /** Share of the refund count, 0..1. */
  countShare: number;
  /** The same code in the prior window — the comparison baseline. */
  priorCount: number;
  priorAmountPaise: number;
}

export interface MoneyOverviewPayload {
  period: {
    days: MoneyOverviewDays;
    current: { start: string; end: string; label: string };
    prior: { start: string; end: string; label: string };
    /** The comparison baseline every chart on the page is drawn against. */
    baselineLabel: string;
  };
  stats: {
    gmv: MoneyMetric;
    netRevenue: MoneyMetric;
    takeRate: MoneyMetric;
    refundRate: MoneyMetric;
    disputeRate: MoneyMetric;
  };
  /** The gross-up of the two money metrics, for the GMV vs net-revenue chart. */
  grossUp: {
    gmvPaise: number;
    netRevenuePaise: number;
    platformFeePaise: number;
    discountPaise: number;
    refundedFeePaise: number;
    /** Collected payments that carry no stamped fee rate. */
    paymentsWithoutFeeRate: number;
  };
  series: MoneyTrendPoint[];
  disputeAging: DisputeAging;
  payoutLatency: PayoutLatency;
  liabilityLadder: LiabilityLadder;
  liabilities: {
    tds: StatutoryCountdown;
    gst: StatutoryCountdown;
  };
  reconciliation: ReconcileBreaks;
  needsHuman: NeedsHumanMoney;
  atRisk: MoneyAtRisk;
  refundReasons: RefundReasonSlice[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Reads.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The money columns the totals and the daily series are built from. Kept
 * narrow on purpose: the relation load for `user` costs a second query, and
 * the series does not need a name.
 */
const PAYMENT_MONEY_SELECT = {
  id: true,
  createdAt: true,
  amount: true,
  originalAmount: true,
  taxAmount: true,
  platformFeeBps: true,
} as const;

/**
 * The one payment read this file makes. Its return type is what the money
 * columns are typed by: the result extension turns BigInt paise into
 * `number` on the client's rows, and only the client's own type carries that
 * (a bare `Prisma.PaymentGetPayload` would still say `bigint`).
 */
function readPaymentMoneyRows(window: MoneyWindow) {
  return prisma.payment.findMany({
    where: collectedPaymentWhere(window),
    select: PAYMENT_MONEY_SELECT,
    orderBy: { createdAt: "asc" },
  });
}

type PaymentMoneyRowSelected = Awaited<
  ReturnType<typeof readPaymentMoneyRows>
>[number];

interface WindowMoney {
  gmvPaise: number;
  netRevenuePaise: number;
  platformFeePaise: number;
  discountPaise: number;
  refundedFeePaise: number;
  paymentsWithoutFeeRate: number;
  paymentCount: number;
}

function emptyWindowMoney(): WindowMoney {
  return {
    gmvPaise: 0,
    netRevenuePaise: 0,
    platformFeePaise: 0,
    discountPaise: 0,
    refundedFeePaise: 0,
    paymentsWithoutFeeRate: 0,
    paymentCount: 0,
  };
}

/**
 * The money totals for one window, read from the narrow payment rows the
 * series is built from — one fetch, one definition, so the cards and the
 * chart can never tell different stories.
 */
function summariseWindow(
  payments: PaymentMoneyRowSelected[],
  refundedByPayment: Map<string, number>,
): WindowMoney {
  const out = emptyWindowMoney();
  for (const p of payments) {
    const row: PaymentMoneyRow = p;
    const refunded = refundedByPayment.get(p.id) ?? 0;
    out.gmvPaise += p.amount;
    out.platformFeePaise += platformFeePaise(row);
    out.discountPaise += discountGivenPaise(row);
    out.refundedFeePaise += refundedFeePaise(row, refunded);
    out.netRevenuePaise += netRevenuePaise(row, refunded);
    out.paymentCount += 1;
    if (p.platformFeeBps === null) out.paymentsWithoutFeeRate += 1;
  }
  return out;
}

const REFUND_SELECT = {
  id: true,
  paymentId: true,
  amountPaise: true,
  reason: true,
  createdAt: true,
  payment: {
    select: {
      id: true,
      amount: true,
      originalAmount: true,
      taxAmount: true,
      platformFeeBps: true,
    },
  },
} as const;

/** The one refund read this file makes. */
function readRefundRows(window: MoneyWindow, reason?: string | null) {
  return prisma.refund.findMany({
    where: refundedInWindowWhere(window, reason),
    select: REFUND_SELECT,
    orderBy: { createdAt: "desc" },
  });
}

type RefundRow = Awaited<ReturnType<typeof readRefundRows>>[number];

async function readRefunds(
  window: MoneyWindow,
  reason?: string | null,
): Promise<RefundRow[]> {
  return readRefundRows(window, reason);
}

function refundedByPayment(refunds: RefundRow[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of refunds) {
    map.set(r.paymentId, (map.get(r.paymentId) ?? 0) + r.amountPaise);
  }
  return map;
}

// ── Daily series ────────────────────────────────────────────────────────────

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function dayLabel(d: Date): string {
  return d.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

interface DailySeries {
  days: string[];
  labels: string[];
  gmv: number[];
  netRevenue: number[];
}

function buildDailySeries(
  window: MoneyWindow,
  payments: PaymentMoneyRowSelected[],
  refunds: RefundRow[],
  days: number,
): DailySeries {
  const start = utcMidnight(window.start);
  const buckets: DailySeries = {
    days: [],
    labels: [],
    gmv: [],
    netRevenue: [],
  };
  for (let i = 0; i < days; i++) {
    const d = addDays(start, i);
    buckets.days.push(dayKey(d));
    buckets.labels.push(dayLabel(d));
    buckets.gmv.push(0);
    buckets.netRevenue.push(0);
  }
  const index = new Map(buckets.days.map((k, i) => [k, i]));
  const refundMap = refundedByPayment(refunds);
  for (const p of payments) {
    const i = index.get(dayKey(p.createdAt));
    if (i === undefined) continue;
    const refunded = refundMap.get(p.id) ?? 0;
    buckets.gmv[i] += p.amount;
    buckets.netRevenue[i] += netRevenuePaise(p, refunded);
  }
  return buckets;
}

// ── Dispute aging ───────────────────────────────────────────────────────────

function agingBucketFor(daysLeft: number): DisputeAgingBucket["key"] {
  if (daysLeft <= 2) return "due-0-2";
  if (daysLeft <= 5) return "due-3-5";
  if (daysLeft <= 10) return "due-6-10";
  return "due-10-plus";
}

function emptyAgingBuckets(): DisputeAgingBucket[] {
  return [
    {
      key: "due-0-2",
      label: "0–2 days left",
      count: 0,
      amountPaise: 0,
      overdue: 0,
    },
    {
      key: "due-3-5",
      label: "3–5 days left",
      count: 0,
      amountPaise: 0,
      overdue: 0,
    },
    {
      key: "due-6-10",
      label: "6–10 days left",
      count: 0,
      amountPaise: 0,
      overdue: 0,
    },
    {
      key: "due-10-plus",
      label: "More than 10 days left",
      count: 0,
      amountPaise: 0,
      overdue: 0,
    },
  ];
}

async function readDisputeAging(now: Date): Promise<DisputeAging> {
  const buckets = emptyAgingBuckets();
  const byKey = new Map(buckets.map((b) => [b.key, b]));
  let openAmountPaise = 0;
  let noDeadlineCount = 0;

  const gateway = await prisma.dispute.findMany({
    where: openGatewayDisputeWhere(),
    select: { id: true, amountPaise: true, dueBy: true },
  });
  for (const d of gateway) {
    openAmountPaise += d.amountPaise;
    if (!d.dueBy) {
      noDeadlineCount += 1;
      continue;
    }
    const daysLeft = Math.floor(
      (d.dueBy.getTime() - now.getTime()) / 86_400_000,
    );
    const bucket = byKey.get(agingBucketFor(daysLeft));
    if (!bucket) continue;
    bucket.count += 1;
    bucket.amountPaise += d.amountPaise;
    if (daysLeft < 0) bucket.overdue += 1;
  }

  const buyer = await prisma.purchaseDispute.findMany({
    where: openBuyerDisputeWhere(),
    select: { id: true, amountAtStakePaise: true, respondentDueAt: true },
  });
  for (const d of buyer) {
    openAmountPaise += d.amountAtStakePaise;
    if (!d.respondentDueAt) {
      noDeadlineCount += 1;
      continue;
    }
    const daysLeft = Math.floor(
      (d.respondentDueAt.getTime() - now.getTime()) / 86_400_000,
    );
    const bucket = byKey.get(agingBucketFor(daysLeft));
    if (!bucket) continue;
    bucket.count += 1;
    bucket.amountPaise += d.amountAtStakePaise;
    if (daysLeft < 0) bucket.overdue += 1;
  }

  return {
    buckets,
    openCount: gateway.length + buyer.length,
    openAmountPaise,
    noDeadlineCount,
  };
}

// ── Payout success + latency ────────────────────────────────────────────────

const LATENCY_BUCKETS = [
  { key: "under-1d", label: "Under 24 hours", maxHours: 24 },
  { key: "1-2d", label: "1–2 days", maxHours: 48 },
  { key: "3-5d", label: "3–5 days", maxHours: 120 },
  { key: "6-10d", label: "6–10 days", maxHours: 240 },
  { key: "over-10d", label: "More than 10 days", maxHours: Infinity },
] as const;

function latencyBucketFor(hours: number): PayoutLatencyBucket["key"] {
  for (const b of LATENCY_BUCKETS) {
    if (hours < b.maxHours) return b.key;
  }
  return "over-10d";
}

function emptyLatencyBuckets(): PayoutLatencyBucket[] {
  return LATENCY_BUCKETS.map((b) => ({
    key: b.key,
    label: b.label,
    count: 0,
    priorCount: 0,
  }));
}

interface PayoutRow {
  id: string;
  status: string;
  createdAt: Date;
  processedAt: Date | null;
  amountPaise: number;
}

function railStats(
  rail: "consultant" | "organization",
  rows: PayoutRow[],
): PayoutRailStats {
  let completed = 0;
  let failed = 0;
  let cancelled = 0;
  let inFlight = 0;
  for (const r of rows) {
    if (r.status === "COMPLETED") completed += 1;
    else if (r.status === "FAILED" || r.status === "REVERSED") failed += 1;
    else if (r.status === "CANCELLED") cancelled += 1;
    else inFlight += 1;
  }
  return {
    rail,
    created: rows.length,
    completed,
    failed,
    cancelled,
    inFlight,
    completionRate: rows.length === 0 ? 0 : completed / rows.length,
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

// ── Liability ladder ────────────────────────────────────────────────────────

function ladderBucketFor(
  holdUntil: Date | null,
  now: Date,
): LiabilityBucket["key"] {
  if (!holdUntil) return "t0";
  const today = utcMidnight(now).getTime();
  const tomorrow = today + 86_400_000;
  const sevenDays = today + 7 * 86_400_000;
  const at = holdUntil.getTime();
  if (at < tomorrow) return "t0";
  if (at < tomorrow + 86_400_000) return "t1";
  if (at <= sevenDays) return "t7";
  return "later";
}

/** The short form of a ladder rung, for a table cell. */
const LADDER_STATUS_LABEL: Record<LiabilityBucket["key"], string> = {
  t0: "T+0",
  t1: "T+1",
  t7: "T+7",
  later: "Later",
};

function emptyLadderBuckets(): LiabilityBucket[] {
  return [
    {
      key: "t0",
      label: "T+0 · payable today",
      amountPaise: 0,
      count: 0,
    },
    {
      key: "t1",
      label: "T+1 · payable tomorrow",
      amountPaise: 0,
      count: 0,
    },
    {
      key: "t7",
      label: "T+7 · payable within 7 days",
      amountPaise: 0,
      count: 0,
    },
    {
      key: "later",
      label: "Later than 7 days",
      amountPaise: 0,
      count: 0,
    },
  ];
}

async function readLiabilityLadder(now: Date): Promise<LiabilityLadder> {
  const buckets = emptyLadderBuckets();
  const byKey = new Map(buckets.map((b) => [b.key, b]));

  const consultantRows = await prisma.consultantEarnings.findMany({
    where: readyEarningsWhere(),
    select: {
      id: true,
      consultantSharePaise: true,
      refundedShareAmount: true,
      holdUntil: true,
    },
  });
  let consultantTotalPaise = 0;
  let dueNowCount = 0;
  for (const e of consultantRows) {
    const owed = Math.max(0, e.consultantSharePaise - e.refundedShareAmount);
    if (owed === 0) continue;
    consultantTotalPaise += owed;
    const key = ladderBucketFor(e.holdUntil, now);
    if (key === "t0") dueNowCount += 1;
    const bucket = byKey.get(key);
    if (!bucket) continue;
    bucket.amountPaise += owed;
    bucket.count += 1;
  }

  const orgRows = await prisma.organizationEarnings.findMany({
    where: readyOrgEarningsWhere(),
    select: {
      id: true,
      orgSharePaise: true,
      refundedAmountPaise: true,
      holdUntil: true,
    },
  });
  let organizationTotalPaise = 0;
  for (const e of orgRows) {
    const owed = Math.max(0, e.orgSharePaise - e.refundedAmountPaise);
    if (owed === 0) continue;
    organizationTotalPaise += owed;
    const key = ladderBucketFor(e.holdUntil, now);
    if (key === "t0") dueNowCount += 1;
    const bucket = byKey.get(key);
    if (!bucket) continue;
    bucket.amountPaise += owed;
    bucket.count += 1;
  }

  const wallet = await prisma.billingAccount.aggregate({
    _sum: { walletBalance: true },
  });

  return {
    buckets,
    consultantTotalPaise,
    organizationTotalPaise,
    walletBalancePaise: sumPaise(wallet._sum.walletBalance),
    dueNowCount,
  };
}

// ── Statutory countdowns (TDS, GST) ─────────────────────────────────────────

/** IST calendar parts — the fiscal calendar is an Indian legal construct. */
function istParts(d: Date): {
  year: number;
  month: number;
  day: number;
} {
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  return {
    year: ist.getUTCFullYear(),
    month: ist.getUTCMonth(),
    day: ist.getUTCDate(),
  };
}

/** 00:00 IST on the given IST calendar day, as an instant. */
function istMidnight(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month, day, 0, 0, 0) - 5.5 * 60 * 60 * 1000);
}

function daysBetween(now: Date, dueAt: Date): number {
  return Math.ceil((dueAt.getTime() - now.getTime()) / 86_400_000);
}

/**
 * TDS withheld in the current financial QUARTER and not yet reported on
 * Form 26Q. `TDSRecord.quarter` is the reporting quarter (1=Apr-Jun …
 * 4=Jan-Mar), so the query has to name it: filtering on the financial year
 * alone would fold the other three quarters' deductions into this card.
 * Quarterly TDS is payable by the 7th of the month after the quarter closes,
 * except Q4, whose March deductions are due on 30 April of the same
 * financial year.
 */
async function readTdsCountdown(now: Date): Promise<StatutoryCountdown> {
  const financialYear = getIndianFinancialYear(now);
  const quarter = getIndianFYQuarter(now);
  const rows = await prisma.tDSRecord.findMany({
    where: { financialYear, quarter },
    select: { id: true, tdsDeducted: true, reportedInForm26Q: true },
  });
  let amountPaise = 0;
  let unfiled = 0;
  for (const r of rows) {
    amountPaise += r.tdsDeducted;
    if (!r.reportedInForm26Q) unfiled += 1;
  }
  // Quarter end → the payment deadline, IST midnight.
  // Q1 Apr-Jun → 7 Jul, Q2 Jul-Sep → 7 Oct, Q3 Oct-Dec → 7 Jan (next year),
  // Q4 Jan-Mar → 30 Apr of the same financial year.
  const ist = istParts(now);
  const dueMonth =
    quarter === 1 ? 6 : quarter === 2 ? 9 : quarter === 3 ? 0 : 3;
  const dueYear = quarter === 3 ? ist.year + 1 : ist.year;
  const dueDay = quarter === 4 ? 30 : 7;
  const dueAt = istMidnight(dueYear, dueMonth, dueDay);
  return {
    label: `TDS withheld · FY ${financialYear} Q${quarter}`,
    amountPaise,
    count: unfiled,
    dueAt: dueAt.toISOString(),
    daysUntilDue: daysBetween(now, dueAt),
    dueLabel:
      quarter === 4
        ? "Payment deadline — 30 April"
        : "Payment deadline — 7th of the month after this quarter",
  };
}

/**
 * GST collected on invoices issued this month. GSTR-1 (the outward-supplies
 * return) is due on the 11th of the following month.
 */
async function readGstCountdown(now: Date): Promise<StatutoryCountdown> {
  const ist = istParts(now);
  const monthStart = istMidnight(ist.year, ist.month, 1);
  const nextMonth = ist.month === 11 ? 0 : ist.month + 1;
  const nextYear = ist.month === 11 ? ist.year + 1 : ist.year;
  const nextMonthStart = istMidnight(nextYear, nextMonth, 1);
  const dueAt = istMidnight(nextYear, nextMonth, 11);

  const [consumer, org] = await Promise.all([
    prisma.consumerInvoice.findMany({
      where: { issuedAt: { gte: monthStart, lt: nextMonthStart } },
      select: { id: true, cgstPaise: true, sgstPaise: true, igstPaise: true },
    }),
    prisma.organizationInvoice.findMany({
      where: {
        issuedAt: { gte: monthStart, lt: nextMonthStart },
        status: { in: ["ISSUED", "PAID", "OVERDUE"] },
      },
      select: { id: true, cgstPaise: true, sgstPaise: true, igstPaise: true },
    }),
  ]);
  let amountPaise = 0;
  const count = consumer.length + org.length;
  for (const i of consumer) {
    amountPaise += i.cgstPaise + i.sgstPaise + i.igstPaise;
  }
  for (const i of org) {
    amountPaise += i.cgstPaise + i.sgstPaise + i.igstPaise;
  }
  return {
    label: "GST collected · this month",
    amountPaise,
    count,
    dueAt: dueAt.toISOString(),
    daysUntilDue: daysBetween(now, dueAt),
    dueLabel: "GSTR-1 filing deadline — 11th of next month",
  };
}

// ── Reconciliation breaks ───────────────────────────────────────────────────

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asText(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  return null;
}

/**
 * One break out of the reconciler's `findings` array. The column is free-form
 * JSON written by the reconciler, so every field is read defensively and the
 * whole array is Zod-parsed before it is shown.
 */
function readFinding(finding: Record<string, unknown>): ReconcileFinding {
  const kind = asText(finding.kind) ?? "UNKNOWN";
  const scope =
    asText(finding.orgId) ?? asText(finding.accountId) ?? "Platform-wide";
  const details = finding.details;
  return {
    kind,
    scope,
    expectedPaise: asNumber(finding.expectedPaise),
    actualPaise: asNumber(finding.actualPaise),
    deltaPaise: asNumber(finding.deltaPaise),
    detail:
      typeof details === "string"
        ? details
        : details === undefined || details === null
          ? null
          : JSON.stringify(details),
  };
}

async function readReconciliation(now: Date): Promise<ReconcileBreaks> {
  const latest = await prisma.ledgerReconciliationReport.findFirst({
    orderBy: { runAt: "desc" },
    select: {
      runAt: true,
      ok: true,
      durationMs: true,
      scope: true,
      findings: true,
    },
  });
  const recent = await prisma.ledgerReconciliationReport.findMany({
    where: {
      runAt: { gte: new Date(now.getTime() - 30 * 86_400_000) },
    },
    select: { ok: true },
  });
  // The column is free-form JSON written by the reconciler — parse it, never
  // cast it.
  const parsed = reconcileFindingsSchema.safeParse(latest?.findings);
  const rawFindings: Record<string, unknown>[] = parsed.success
    ? parsed.data
    : [];
  return {
    lastRunAt: latest?.runAt.toISOString() ?? null,
    ok: latest?.ok ?? true,
    durationMs: latest?.durationMs ?? null,
    scope: latest?.scope ?? null,
    findings: rawFindings.map(readFinding),
    recentRuns: recent.length,
    recentFailures: recent.filter((r) => !r.ok).length,
  };
}

// ── Refund reasons ──────────────────────────────────────────────────────────

function buildRefundReasons(
  refunds: RefundRow[],
  priorRefunds: RefundRow[],
): RefundReasonSlice[] {
  const groups = new Map<string, { count: number; amountPaise: number }>();
  const tally = (rows: RefundRow[]) => {
    const out = new Map<string, { count: number; amountPaise: number }>();
    for (const r of rows) {
      // The stored reason IS the code, so the groups are the stored values and
      // the drill-through can ask for one of them by name.
      const key = r.reason ?? "";
      const g = out.get(key) ?? { count: 0, amountPaise: 0 };
      g.count += 1;
      g.amountPaise += r.amountPaise;
      out.set(key, g);
    }
    return out;
  };
  for (const [key, g] of tally(refunds)) groups.set(key, g);
  const prior = tally(priorRefunds);

  const totalAmount = refunds.reduce((s, r) => s + r.amountPaise, 0);
  const totalCount = refunds.length;
  return [...groups.entries()]
    .map(([reason, g]) => ({
      reason,
      label: reason || "No reason recorded",
      count: g.count,
      amountPaise: g.amountPaise,
      share: totalAmount === 0 ? 0 : g.amountPaise / totalAmount,
      countShare: totalCount === 0 ? 0 : g.count / totalCount,
      priorCount: prior.get(reason)?.count ?? 0,
      priorAmountPaise: prior.get(reason)?.amountPaise ?? 0,
    }))
    .sort(
      (a, b) =>
        b.amountPaise - a.amountPaise || a.reason.localeCompare(b.reason),
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// The read.
// ─────────────────────────────────────────────────────────────────────────────

/** The days a window covers, as "first day → last day". */
function windowLabel(w: MoneyWindow): string {
  const lastDay = new Date(w.end.getTime() - 1);
  return `${w.start.toISOString().slice(0, 10)} → ${lastDay.toISOString().slice(0, 10)}`;
}

async function readWindowMoney(
  window: MoneyWindow,
  days: number,
): Promise<{
  summary: WindowMoney;
  refunds: RefundRow[];
  series: DailySeries;
}> {
  const [payments, refunds] = await Promise.all([
    readPaymentMoneyRows(window),
    readRefunds(window),
  ]);
  const summary = summariseWindow(payments, refundedByPayment(refunds));
  return {
    summary,
    refunds,
    series: buildDailySeries(window, payments, refunds, days),
  };
}

export async function readMoneyOverview(
  options: {
    days?: MoneyOverviewDays;
    now?: Date;
  } = {},
): Promise<MoneyOverviewPayload> {
  const now = options.now ?? new Date();
  const days = options.days ?? DEFAULT_MONEY_OVERVIEW_DAYS;
  const periods = moneyOverviewPeriods(days, now);

  const [current, prior] = await Promise.all([
    readWindowMoney(periods.current, days),
    readWindowMoney(periods.prior, days),
  ]);

  const series: MoneyTrendPoint[] = current.series.days.map((day, i) => ({
    day,
    label: current.series.labels[i],
    gmvPaise: current.series.gmv[i],
    netRevenuePaise: current.series.netRevenue[i],
    priorGmvPaise: prior.series.gmv[i] ?? 0,
    priorNetRevenuePaise: prior.series.netRevenue[i] ?? 0,
  }));

  // Disputes opened in each window — the networks' "dispute activity" basis:
  // the numerator is dated by when the dispute was raised, not by the charge.
  const [gatewayOpened, buyerOpened, gatewayPrior, buyerPrior] =
    await Promise.all([
      prisma.dispute.count({ where: disputeOpenedWhere(periods.current) }),
      prisma.purchaseDispute.count({
        where: buyerDisputeOpenedWhere(periods.current),
      }),
      prisma.dispute.count({ where: disputeOpenedWhere(periods.prior) }),
      prisma.purchaseDispute.count({
        where: buyerDisputeOpenedWhere(periods.prior),
      }),
    ]);

  const [
    disputeAging,
    liabilityLadder,
    tds,
    gst,
    reconciliation,
    needsHumanItems,
  ] = await Promise.all([
    readDisputeAging(now),
    readLiabilityLadder(now),
    readTdsCountdown(now),
    readGstCountdown(now),
    readReconciliation(now),
    readRefundNeedsHuman(),
  ]);

  // Payout success + latency, both rails, both windows.
  const [consultantPayouts, orgPayouts, consultantPrior, orgPrior] =
    await Promise.all([
      prisma.consultantPayout.findMany({
        where: payoutCreatedWhere(periods.current),
        select: {
          id: true,
          status: true,
          createdAt: true,
          processedAt: true,
          amount: true,
        },
      }),
      prisma.organizationPayout.findMany({
        where: orgPayoutCreatedWhere(periods.current),
        select: {
          id: true,
          status: true,
          createdAt: true,
          processedAt: true,
          amountPaise: true,
        },
      }),
      prisma.consultantPayout.findMany({
        where: payoutCreatedWhere(periods.prior),
        select: {
          id: true,
          status: true,
          createdAt: true,
          processedAt: true,
          amount: true,
        },
      }),
      prisma.organizationPayout.findMany({
        where: orgPayoutCreatedWhere(periods.prior),
        select: {
          id: true,
          status: true,
          createdAt: true,
          processedAt: true,
          amountPaise: true,
        },
      }),
    ]);

  const currentPayouts: PayoutRow[] = [
    ...consultantPayouts.map((p) => ({
      id: p.id,
      status: p.status,
      createdAt: p.createdAt,
      processedAt: p.processedAt,
      amountPaise: p.amount,
    })),
    ...orgPayouts.map((p) => ({
      id: p.id,
      status: p.status,
      createdAt: p.createdAt,
      processedAt: p.processedAt,
      amountPaise: p.amountPaise,
    })),
  ];
  const priorPayouts: PayoutRow[] = [
    ...consultantPrior.map((p) => ({
      id: p.id,
      status: p.status,
      createdAt: p.createdAt,
      processedAt: p.processedAt,
      amountPaise: p.amount,
    })),
    ...orgPrior.map((p) => ({
      id: p.id,
      status: p.status,
      createdAt: p.createdAt,
      processedAt: p.processedAt,
      amountPaise: p.amountPaise,
    })),
  ];

  const latencyBuckets = emptyLatencyBuckets();
  const latencyByKey = new Map(latencyBuckets.map((b) => [b.key, b]));
  const latencies: number[] = [];
  for (const p of currentPayouts) {
    if (p.status !== "COMPLETED" || !p.processedAt) continue;
    const hours = (p.processedAt.getTime() - p.createdAt.getTime()) / 3_600_000;
    latencies.push(hours);
    const bucket = latencyByKey.get(latencyBucketFor(hours));
    if (bucket) bucket.count += 1;
  }
  for (const p of priorPayouts) {
    if (p.status !== "COMPLETED" || !p.processedAt) continue;
    const hours = (p.processedAt.getTime() - p.createdAt.getTime()) / 3_600_000;
    const bucket = latencyByKey.get(latencyBucketFor(hours));
    if (bucket) bucket.priorCount += 1;
  }

  const rails: PayoutRailStats[] = [
    railStats(
      "consultant",
      consultantPayouts.map((p) => ({
        id: p.id,
        status: p.status,
        createdAt: p.createdAt,
        processedAt: p.processedAt,
        amountPaise: p.amount,
      })),
    ),
    railStats(
      "organization",
      orgPayouts.map((p) => ({
        id: p.id,
        status: p.status,
        createdAt: p.createdAt,
        processedAt: p.processedAt,
        amountPaise: p.amountPaise,
      })),
    ),
  ];
  const totalCreated = currentPayouts.length;
  const totalCompleted = currentPayouts.filter(
    (p) => p.status === "COMPLETED",
  ).length;
  const totalFailed = currentPayouts.filter(
    (p) => p.status === "FAILED" || p.status === "REVERSED",
  ).length;
  const totalCancelled = currentPayouts.filter(
    (p) => p.status === "CANCELLED",
  ).length;

  // Money at risk: what is exposed if every open dispute goes against us.
  // No loss probability is asserted — the exposed amount is shown as exposed.
  const gatewayOpen = await prisma.dispute.findMany({
    where: openGatewayDisputeWhere(),
    select: { amountPaise: true },
  });
  const buyerOpen = await prisma.purchaseDispute.findMany({
    where: openBuyerDisputeWhere(),
    select: { amountAtStakePaise: true },
  });
  const gatewayAmountPaise = gatewayOpen.reduce((s, d) => s + d.amountPaise, 0);
  const buyerAmountPaise = buyerOpen.reduce(
    (s, d) => s + d.amountAtStakePaise,
    0,
  );

  const needsHumanAmountPaise = needsHumanItems.reduce(
    (s, i) => s + (i.unitPaise ?? 0),
    0,
  );

  const gmv = metric(current.summary.gmvPaise, prior.summary.gmvPaise, "paise");
  const netRevenue = metric(
    current.summary.netRevenuePaise,
    prior.summary.netRevenuePaise,
    "paise",
  );
  const takeRate = metric(
    current.summary.gmvPaise === 0
      ? 0
      : current.summary.netRevenuePaise / current.summary.gmvPaise,
    prior.summary.gmvPaise === 0
      ? 0
      : prior.summary.netRevenuePaise / prior.summary.gmvPaise,
    "ratio",
  );
  const refundedCurrent = current.refunds.reduce(
    (s, r) => s + r.amountPaise,
    0,
  );
  const refundedPrior = prior.refunds.reduce((s, r) => s + r.amountPaise, 0);
  const refundRate = metric(
    current.summary.gmvPaise === 0
      ? 0
      : refundedCurrent / current.summary.gmvPaise,
    prior.summary.gmvPaise === 0 ? 0 : refundedPrior / prior.summary.gmvPaise,
    "ratio",
  );
  const disputesCurrent = gatewayOpened + buyerOpened;
  const disputesPrior = gatewayPrior + buyerPrior;
  const disputeRate = metric(
    current.summary.paymentCount === 0
      ? 0
      : disputesCurrent / current.summary.paymentCount,
    prior.summary.paymentCount === 0
      ? 0
      : disputesPrior / prior.summary.paymentCount,
    "ratio",
  );

  return {
    period: {
      days,
      current: {
        start: periods.current.start.toISOString(),
        end: periods.current.end.toISOString(),
        label: windowLabel(periods.current),
      },
      prior: {
        start: periods.prior.start.toISOString(),
        end: periods.prior.end.toISOString(),
        label: windowLabel(periods.prior),
      },
      baselineLabel: `Previous ${days} days`,
    },
    stats: { gmv, netRevenue, takeRate, refundRate, disputeRate },
    grossUp: {
      gmvPaise: current.summary.gmvPaise,
      netRevenuePaise: current.summary.netRevenuePaise,
      platformFeePaise: current.summary.platformFeePaise,
      discountPaise: current.summary.discountPaise,
      refundedFeePaise: current.summary.refundedFeePaise,
      paymentsWithoutFeeRate: current.summary.paymentsWithoutFeeRate,
    },
    series,
    disputeAging,
    payoutLatency: {
      buckets: latencyBuckets,
      rails,
      created: totalCreated,
      completed: totalCompleted,
      failed: totalFailed,
      cancelled: totalCancelled,
      inFlight: totalCreated - totalCompleted - totalFailed - totalCancelled,
      completionRate: totalCreated === 0 ? 0 : totalCompleted / totalCreated,
      medianLatencyHours: median(latencies),
    },
    liabilityLadder,
    liabilities: { tds, gst },
    reconciliation,
    needsHuman: {
      count: needsHumanItems.length,
      amountPaise: needsHumanAmountPaise,
    },
    atRisk: {
      gatewayCount: gatewayOpen.length,
      gatewayAmountPaise,
      buyerCount: buyerOpen.length,
      buyerAmountPaise,
      totalAmountPaise: gatewayAmountPaise + buyerAmountPaise,
    },
    refundReasons: buildRefundReasons(current.refunds, prior.refunds),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The drill-through: the rows behind a number.
//
// Every drill reads the SAME named `where` as the metric it explains, so the
// number and the list can never be different populations.
// ─────────────────────────────────────────────────────────────────────────────

export const MONEY_DRILL_KEYS = [
  "gmv",
  "net-revenue",
  "refund-rate",
  "dispute-rate",
  "refund-reason",
  "dispute-aging",
  "payout-latency",
  "liability-ladder",
  "at-risk",
  "needs-human",
] as const;

export type MoneyDrillKey = (typeof MONEY_DRILL_KEYS)[number];

export function isMoneyDrillKey(value: unknown): value is MoneyDrillKey {
  return (
    typeof value === "string" &&
    (MONEY_DRILL_KEYS as readonly string[]).includes(value)
  );
}

/** One row of a drill-through list. */
export interface MoneyDrillRow {
  id: string;
  /** The primary text — what the row is. */
  label: string;
  /** The secondary text — the facts behind it. */
  detail: string;
  /** The money the row carries, when it carries money. */
  amountPaise: number | null;
  /** A status or severity word; the UI never colours a row without one. */
  status: string | null;
  /** ISO timestamp of the event the row is about. */
  at: string | null;
}

export interface MoneyDrill {
  key: MoneyDrillKey;
  title: string;
  description: string;
  rows: MoneyDrillRow[];
  /** True when the list was cut short at the row cap. */
  truncated: boolean;
}

/** How many rows a drill-through shows before it says it cut the list. */
const DRILL_ROW_CAP = 50;

function capRows(rows: MoneyDrillRow[]): {
  rows: MoneyDrillRow[];
  truncated: boolean;
} {
  return {
    rows: rows.slice(0, DRILL_ROW_CAP),
    truncated: rows.length > DRILL_ROW_CAP,
  };
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function shortDate(d: Date | null): string {
  return d ? d.toISOString().slice(0, 10) : "—";
}

async function drillPayments(
  window: MoneyWindow,
  withMoney: boolean,
): Promise<{ rows: MoneyDrillRow[]; truncated: boolean }> {
  // The drill reads the same `where` as the metric, with the columns a row
  // needs to be recognisable.
  const payments = await prisma.payment.findMany({
    where: collectedPaymentWhere(window),
    select: {
      ...PAYMENT_MONEY_SELECT,
      paymentIntent: true,
      user: { select: { name: true, email: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  const rows = payments.map((p) => {
    const row: PaymentMoneyRow = p;
    return {
      id: p.id,
      label: `${p.paymentIntent.slice(0, 18)} · ${p.user.email}`,
      detail: withMoney
        ? `fee ${platformFeePaise(row)} paise · discount ${discountGivenPaise(row)} paise · net ${netRevenuePaise(row)} paise`
        : `gross ${p.originalAmount} paise · tax ${p.taxAmount} paise`,
      amountPaise: p.amount,
      status: p.platformFeeBps === null ? "No fee rate" : "Succeeded",
      at: p.createdAt.toISOString(),
    } satisfies MoneyDrillRow;
  });
  return capRows(rows);
}

async function drillRefunds(
  window: MoneyWindow,
  reason: string | null,
): Promise<{ rows: MoneyDrillRow[]; truncated: boolean }> {
  const refunds = await readRefunds(window, reason);
  const rows = refunds.map((r) => ({
    id: r.id,
    label: r.reason ?? "No reason recorded",
    detail: `payment ${shortId(r.paymentId)}`,
    amountPaise: r.amountPaise,
    status: "Succeeded",
    at: r.createdAt.toISOString(),
  }));
  return capRows(rows);
}

async function drillDisputesOpened(
  window: MoneyWindow,
): Promise<{ rows: MoneyDrillRow[]; truncated: boolean }> {
  const [gateway, buyer] = await Promise.all([
    prisma.dispute.findMany({
      where: disputeOpenedWhere(window),
      select: {
        id: true,
        disputeId: true,
        amountPaise: true,
        status: true,
        reason: true,
        createdAt: true,
      },
    }),
    prisma.purchaseDispute.findMany({
      where: buyerDisputeOpenedWhere(window),
      select: {
        id: true,
        referenceNumber: true,
        amountAtStakePaise: true,
        status: true,
        reason: true,
        createdAt: true,
      },
    }),
  ]);
  const rows: MoneyDrillRow[] = [
    ...gateway.map((d) => ({
      id: d.id,
      label: `${d.disputeId} · ${d.reason}`,
      detail: "Gateway chargeback",
      amountPaise: d.amountPaise,
      status: d.status,
      at: d.createdAt.toISOString(),
    })),
    ...buyer.map((d) => ({
      id: d.id,
      label: `${d.referenceNumber} · ${d.reason}`,
      detail: "Buyer dispute",
      amountPaise: d.amountAtStakePaise,
      status: d.status,
      at: d.createdAt.toISOString(),
    })),
  ].sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
  return capRows(rows);
}

async function drillOpenDisputes(): Promise<{
  rows: MoneyDrillRow[];
  truncated: boolean;
}> {
  const [gateway, buyer] = await Promise.all([
    prisma.dispute.findMany({
      where: openGatewayDisputeWhere(),
      select: {
        id: true,
        disputeId: true,
        amountPaise: true,
        status: true,
        reason: true,
        dueBy: true,
        createdAt: true,
      },
    }),
    prisma.purchaseDispute.findMany({
      where: openBuyerDisputeWhere(),
      select: {
        id: true,
        referenceNumber: true,
        amountAtStakePaise: true,
        status: true,
        reason: true,
        respondentDueAt: true,
        createdAt: true,
      },
    }),
  ]);
  const rows: MoneyDrillRow[] = [
    ...gateway.map((d) => ({
      id: d.id,
      label: `${d.disputeId} · ${d.reason}`,
      detail: `Gateway chargeback · deadline ${shortDate(d.dueBy)}`,
      amountPaise: d.amountPaise,
      status: d.status,
      at: d.createdAt.toISOString(),
    })),
    ...buyer.map((d) => ({
      id: d.id,
      label: `${d.referenceNumber} · ${d.reason}`,
      detail: `Buyer dispute · deadline ${shortDate(d.respondentDueAt)}`,
      amountPaise: d.amountAtStakePaise,
      status: d.status,
      at: d.createdAt.toISOString(),
    })),
  ];
  return capRows(rows);
}

async function drillPayouts(
  window: MoneyWindow,
): Promise<{ rows: MoneyDrillRow[]; truncated: boolean }> {
  const [consultant, org] = await Promise.all([
    prisma.consultantPayout.findMany({
      where: payoutCreatedWhere(window),
      select: {
        id: true,
        status: true,
        amount: true,
        createdAt: true,
        processedAt: true,
        failureReason: true,
      },
    }),
    prisma.organizationPayout.findMany({
      where: orgPayoutCreatedWhere(window),
      select: {
        id: true,
        status: true,
        amountPaise: true,
        createdAt: true,
        processedAt: true,
        failureReason: true,
      },
    }),
  ]);
  const rows: MoneyDrillRow[] = [
    ...consultant.map((p) => ({
      id: p.id,
      label: `Expert payout ${shortId(p.id)}`,
      detail: `raised ${shortDate(p.createdAt)}${
        p.processedAt ? ` · paid ${shortDate(p.processedAt)}` : ""
      }${p.failureReason ? ` · ${p.failureReason}` : ""}`,
      amountPaise: p.amount,
      status: p.status,
      at: p.createdAt.toISOString(),
    })),
    ...org.map((p) => ({
      id: p.id,
      label: `Organisation payout ${shortId(p.id)}`,
      detail: `raised ${shortDate(p.createdAt)}${
        p.processedAt ? ` · paid ${shortDate(p.processedAt)}` : ""
      }${p.failureReason ? ` · ${p.failureReason}` : ""}`,
      amountPaise: p.amountPaise,
      status: p.status,
      at: p.createdAt.toISOString(),
    })),
  ].sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
  return capRows(rows);
}

async function drillLiability(now: Date): Promise<{
  rows: MoneyDrillRow[];
  truncated: boolean;
}> {
  const [consultant, org] = await Promise.all([
    prisma.consultantEarnings.findMany({
      where: readyEarningsWhere(),
      select: {
        id: true,
        consultantSharePaise: true,
        refundedShareAmount: true,
        holdUntil: true,
        paymentId: true,
      },
    }),
    prisma.organizationEarnings.findMany({
      where: readyOrgEarningsWhere(),
      select: {
        id: true,
        orgSharePaise: true,
        refundedAmountPaise: true,
        holdUntil: true,
        paymentId: true,
      },
    }),
  ]);
  const rows: MoneyDrillRow[] = [
    ...consultant.map((e) => ({
      id: e.id,
      label: `Expert earnings ${shortId(e.id)}`,
      detail: `payment ${shortId(e.paymentId)} · hold ends ${shortDate(e.holdUntil)}`,
      amountPaise: Math.max(0, e.consultantSharePaise - e.refundedShareAmount),
      status: e.holdUntil
        ? LADDER_STATUS_LABEL[ladderBucketFor(e.holdUntil, now)]
        : "T+0",
      at: e.holdUntil ? e.holdUntil.toISOString() : null,
    })),
    ...org.map((e) => ({
      id: e.id,
      label: `Organisation earnings ${shortId(e.id)}`,
      detail: `payment ${shortId(e.paymentId)} · hold ends ${shortDate(e.holdUntil)}`,
      amountPaise: Math.max(0, e.orgSharePaise - e.refundedAmountPaise),
      status: e.holdUntil
        ? LADDER_STATUS_LABEL[ladderBucketFor(e.holdUntil, now)]
        : "T+0",
      at: e.holdUntil ? e.holdUntil.toISOString() : null,
    })),
  ].sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
  return capRows(rows);
}

/**
 * The rows behind one number on the page. `reason` narrows the refund-reason
 * drill to one code.
 */
export async function readMoneyDrill(input: {
  key: MoneyDrillKey;
  days?: MoneyOverviewDays;
  reason?: string | null;
  now?: Date;
}): Promise<MoneyDrill> {
  const now = input.now ?? new Date();
  const days = input.days ?? DEFAULT_MONEY_OVERVIEW_DAYS;
  const periods = moneyOverviewPeriods(days, now);
  const window = periods.current;

  switch (input.key) {
    case "gmv": {
      const { rows, truncated } = await drillPayments(window, false);
      return {
        key: input.key,
        title: "Payments collected in this period",
        description:
          "Every captured payment in the window, with the gross and tax it was charged.",
        rows,
        truncated,
      };
    }
    case "net-revenue": {
      const { rows, truncated } = await drillPayments(window, true);
      return {
        key: input.key,
        title: "What the platform kept, payment by payment",
        description:
          "Each payment's fee, the discount the platform funded, and the net it left behind.",
        rows,
        truncated,
      };
    }
    case "refund-rate":
    case "refund-reason": {
      // "" is the code for a refund with no reason recorded.
      const reason =
        input.key === "refund-reason" ? (input.reason ?? "") : null;
      const { rows, truncated } = await drillRefunds(window, reason);
      return {
        key: input.key,
        title: reason ? `Refunds — ${reason}` : "Refunds issued in this period",
        description:
          "Every refund that left the till in the window, with the reason it was raised.",
        rows,
        truncated,
      };
    }
    case "dispute-rate": {
      const { rows, truncated } = await drillDisputesOpened(window);
      return {
        key: input.key,
        title: "Disputes opened in this period",
        description:
          "Gateway chargebacks and buyer disputes, dated by when they were raised.",
        rows,
        truncated,
      };
    }
    case "dispute-aging":
    case "at-risk": {
      const { rows, truncated } = await drillOpenDisputes();
      return {
        key: input.key,
        title: "Open disputes",
        description:
          "Chargebacks and buyer disputes still in proceedings, with their deadlines.",
        rows,
        truncated,
      };
    }
    case "payout-latency": {
      const { rows, truncated } = await drillPayouts(window);
      return {
        key: input.key,
        title: "Payouts raised in this period",
        description:
          "Every payout raised in the window, when it was raised and when it was paid.",
        rows,
        truncated,
      };
    }
    case "liability-ladder": {
      const { rows, truncated } = await drillLiability(now);
      return {
        key: input.key,
        title: "Earnings ready to be paid out",
        description:
          "Collected money that is ready but has not been paid, and when its hold ends.",
        rows,
        truncated,
      };
    }
    case "needs-human": {
      const items = await readRefundNeedsHuman();
      const { rows, truncated } = capRows(
        items.map((i) => ({
          id: i.id,
          label: i.message,
          detail: i.kind === "credit" ? "Credit to settle" : "Held paid seat",
          amountPaise: i.unitPaise,
          status: "Needs a human",
          at: i.createdAt.toISOString(),
        })),
      );
      return {
        key: input.key,
        title: "Money a person still has to handle",
        description:
          "Refund-adjacent money the automatic sweeps could not settle on their own.",
        rows,
        truncated,
      };
    }
    default:
      return {
        key: input.key,
        title: "Unknown drill-through",
        description: "That drill-through does not exist.",
        rows: [],
        truncated: false,
      };
  }
}
