/**
 * Daily Razorpay settlement reconciliation (ticker, 06:30–12:30 UTC window).
 *
 * Each slice reads one page of the settlement recon report for yesterday's or
 * the day before's IST date, stores the lines, matches each to our money row,
 * books a missing capture fee under `gatewayfee:<pay_id>`, and once a day is
 * fully read posts one `settlement:<setl_id>` journal moving its net from
 * GATEWAY_CLEARING to CASH. Mismatches are recorded and reported, never edited.
 */
import { z } from "zod";
import type {
  GatewaySettlementLineStatus,
  GatewaySettlementMatchKind,
  Prisma,
} from "@prisma/client";
import prisma from "@/lib/prisma";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { startDeadline } from "@/lib/cron/run-deadline";
import {
  getRazorpayClient,
  withRazorpaySdkTimeout,
} from "@/lib/payments/core/razorpay";
import {
  gatewayFeeKey,
  postGatewayFee,
} from "@/lib/payments/ledger/gateway-fee";
import { gatewayCashAccount } from "@/lib/payments/ledger/gateway-account";
import { postLedgerTxn } from "@/lib/payments/ledger/post";
import { reportSentryMessage } from "@/lib/observability/report";
import { sumPaise } from "@/lib/payments/utils/money";

const RECONCILE_GATEWAY_SETTLEMENTS_JOB = "reconcile-gateway-settlements";

/** Razorpay's maximum `count` for the recon endpoint. */
const PAGE_SIZE = 1000;
const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
/** Yesterday first, then the day before for late settlements. */
const DAYS_BACK = [1, 2] as const;

const amountSchema = z.number().int();
const reconRowSchema = z
  .object({
    entity_id: z.string().min(1),
    type: z.string().min(1),
    amount: amountSchema,
    fee: amountSchema.nullable().optional(),
    tax: amountSchema.nullable().optional(),
    debit: amountSchema.nullable().optional(),
    credit: amountSchema.nullable().optional(),
    settlement_id: z.string().nullable().optional(),
    settlement_utr: z.string().nullable().optional(),
    settled_at: z.number().int().nullable().optional(),
    order_id: z.string().nullable().optional(),
    payment_id: z.string().nullable().optional(),
    dispute_id: z.string().nullable().optional(),
  })
  .passthrough();
type ReconRow = z.infer<typeof reconRowSchema>;

const reconPageSchema = z
  .object({ items: z.array(reconRowSchema).default([]) })
  .passthrough();

interface SettlementReconResult {
  success: true;
  skipped?: "NO_GATEWAY_CLIENT";
  fetched: number;
  inserted: number;
  feesPosted: number;
  settlementsPosted: number;
  /** True when both days are fully read and their settlement journals posted. */
  done: boolean;
  byStatus: Record<GatewaySettlementLineStatus, number>;
}

interface IstDay {
  year: number;
  month: number;
  day: number;
  start: Date;
  end: Date;
}

/** The IST calendar date `daysBack` days before `now`, with its UTC bounds. */
function istDay(now: Date, daysBack: number): IstDay {
  const ist = new Date(now.getTime() + IST_OFFSET_MS - daysBack * DAY_MS);
  const year = ist.getUTCFullYear();
  const month = ist.getUTCMonth() + 1;
  const day = ist.getUTCDate();
  const start = new Date(Date.UTC(year, month - 1, day) - IST_OFFSET_MS);
  return { year, month, day, start, end: new Date(start.getTime() + DAY_MS) };
}

interface LineMatch {
  matchedKind: GatewaySettlementMatchKind;
  matchedId: string | null;
  status: GatewaySettlementLineStatus;
  note: string | null;
}

interface PageLookups {
  payments: Map<string, { id: string; amount: number }>;
  topUps: Map<string, { id: string; amountPaise: number }>;
  invoices: Map<string, { id: string; bookedPaise: number | null }>;
  refunds: Map<string, { id: string; amountPaise: number }>;
  /** CONFIRMED top-ups by `pay_` id, for refunds that have no `Refund` row. */
  refundTopUps: Map<string, { id: string }>;
  /** Σ DEBIT of each `topup-refund:` / `invoice-refund:` journal, by key. */
  refundJournals: Map<string, number>;
  disputes: Map<string, { id: string; amountPaise: number }>;
  bookedFees: Map<string, number>;
}

/** Σ DEBIT of each journal, keyed by its idempotency key. */
async function debitTotalsByKey(keys: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (keys.length === 0) return out;
  const txns = await prisma.ledgerTransaction.findMany({
    where: { idempotencyKey: { in: keys } },
    select: {
      idempotencyKey: true,
      entries: { where: { direction: "DEBIT" }, select: { amountPaise: true } },
    },
  });
  for (const t of txns) {
    out.set(
      t.idempotencyKey,
      t.entries.reduce((s, e) => s + sumPaise(e.amountPaise), 0),
    );
  }
  return out;
}

const topUpRefundKey = (refundId: string) => `topup-refund:${refundId}`;
const invoiceRefundKey = (refundId: string) => `invoice-refund:${refundId}`;

async function loadPageLookups(rows: ReconRow[]): Promise<PageLookups> {
  const ids = (type: string) =>
    rows.filter((r) => r.type === type).map((r) => r.entity_id);
  const paymentIds = ids("payment");
  const refundIds = ids("refund");
  const refundPaymentIds = rows.flatMap((r) =>
    r.type === "refund" && r.payment_id ? [r.payment_id] : [],
  );
  const providerPaymentIds = [...paymentIds, ...refundPaymentIds];
  const disputeIds = rows
    .filter((r) => r.type === "adjustment" && r.dispute_id)
    .map((r) => r.dispute_id as string);

  const payments = await prisma.payment.findMany({
    where: { gatewayPaymentId: { in: paymentIds } },
    select: { id: true, gatewayPaymentId: true, amount: true },
  });
  const topUps = await prisma.walletTopUp.findMany({
    where: { providerPaymentId: { in: providerPaymentIds } },
    select: {
      id: true,
      providerPaymentId: true,
      amountPaise: true,
      status: true,
    },
  });
  const invoices = await prisma.organizationInvoice.findMany({
    where: { providerPaymentId: { in: providerPaymentIds } },
    select: { id: true, providerPaymentId: true },
  });
  const refunds = await prisma.refund.findMany({
    where: { refundId: { in: refundIds } },
    select: { id: true, refundId: true, amountPaise: true },
  });
  const disputes = await prisma.dispute.findMany({
    where: { disputeId: { in: disputeIds } },
    select: { id: true, disputeId: true, amountPaise: true },
  });
  const invoicePaid = await debitTotalsByKey(
    invoices.map((i) => `invoicepaid:${i.id}`),
  );
  const fees = await debitTotalsByKey(paymentIds.map(gatewayFeeKey));
  // Same order as the refund webhook: a CONFIRMED top-up wins over an invoice.
  const refundTopUps = new Map(
    topUps.flatMap((t) =>
      t.providerPaymentId && t.status === "CONFIRMED"
        ? [[t.providerPaymentId, { id: t.id }] as const]
        : [],
    ),
  );
  const invoicePayIds = new Set(invoices.map((i) => i.providerPaymentId));
  const refundJournals = await debitTotalsByKey(
    rows.flatMap((r) => {
      if (r.type !== "refund" || !r.payment_id) return [];
      if (refundTopUps.has(r.payment_id)) return [topUpRefundKey(r.entity_id)];
      return invoicePayIds.has(r.payment_id)
        ? [invoiceRefundKey(r.entity_id)]
        : [];
    }),
  );

  return {
    payments: new Map(
      payments.flatMap((p) =>
        p.gatewayPaymentId
          ? [[p.gatewayPaymentId, { id: p.id, amount: p.amount }] as const]
          : [],
      ),
    ),
    topUps: new Map(
      topUps.flatMap((t) =>
        t.providerPaymentId
          ? [
              [
                t.providerPaymentId,
                { id: t.id, amountPaise: t.amountPaise },
              ] as const,
            ]
          : [],
      ),
    ),
    invoices: new Map(
      invoices.flatMap((i) =>
        i.providerPaymentId
          ? [
              [
                i.providerPaymentId,
                {
                  id: i.id,
                  bookedPaise: invoicePaid.get(`invoicepaid:${i.id}`) ?? null,
                },
              ] as const,
            ]
          : [],
      ),
    ),
    refunds: new Map(
      refunds.map((r) => [
        r.refundId,
        { id: r.id, amountPaise: r.amountPaise },
      ]),
    ),
    refundTopUps,
    refundJournals,
    disputes: new Map(
      disputes.map((d) => [
        d.disputeId,
        { id: d.id, amountPaise: d.amountPaise },
      ]),
    ),
    bookedFees: new Map(
      paymentIds.flatMap((id) => {
        const booked = fees.get(gatewayFeeKey(id));
        return booked === undefined ? [] : [[id, booked] as const];
      }),
    ),
  };
}

function amountCheck(
  matchedKind: GatewaySettlementMatchKind,
  matchedId: string,
  linePaise: number,
  ourPaise: number | null,
): LineMatch {
  if (ourPaise === linePaise) {
    return { matchedKind, matchedId, status: "MATCHED", note: null };
  }
  return {
    matchedKind,
    matchedId,
    status: "AMOUNT_MISMATCH",
    note: `gateway ${linePaise} vs ours ${ourPaise ?? "unbooked"}`,
  };
}

/** Which of our rows a line is, and whether its amount agrees. Fee is checked separately. */
function matchLine(row: ReconRow, lookups: PageLookups): LineMatch {
  const unmatched: LineMatch = {
    matchedKind: "NONE",
    matchedId: null,
    status: "UNMATCHED",
    note: null,
  };
  if (row.type === "payment") {
    const payment = lookups.payments.get(row.entity_id);
    if (payment) {
      return amountCheck("PAYMENT", payment.id, row.amount, payment.amount);
    }
    const topUp = lookups.topUps.get(row.entity_id);
    if (topUp) {
      return amountCheck("TOPUP", topUp.id, row.amount, topUp.amountPaise);
    }
    const invoice = lookups.invoices.get(row.entity_id);
    if (invoice) {
      return amountCheck(
        "INVOICE",
        invoice.id,
        row.amount,
        invoice.bookedPaise,
      );
    }
    return unmatched;
  }
  if (row.type === "refund") {
    const refund = lookups.refunds.get(row.entity_id);
    if (refund) {
      return amountCheck("REFUND", refund.id, row.amount, refund.amountPaise);
    }
    // Top-up and org-invoice refunds have no `Refund` row; their journal is the record.
    if (!row.payment_id) return unmatched;
    const topUp = lookups.refundTopUps.get(row.payment_id);
    if (topUp) {
      return amountCheck(
        "TOPUP",
        topUp.id,
        row.amount,
        lookups.refundJournals.get(topUpRefundKey(row.entity_id)) ?? null,
      );
    }
    const invoice = lookups.invoices.get(row.payment_id);
    if (invoice) {
      return amountCheck(
        "INVOICE",
        invoice.id,
        row.amount,
        lookups.refundJournals.get(invoiceRefundKey(row.entity_id)) ?? null,
      );
    }
    return unmatched;
  }
  if (row.type === "adjustment" && row.dispute_id) {
    const dispute = lookups.disputes.get(row.dispute_id);
    return dispute
      ? amountCheck("DISPUTE", dispute.id, row.amount, dispute.amountPaise)
      : unmatched;
  }
  return unmatched;
}

function lineData(
  row: ReconRow,
  match: LineMatch,
): Prisma.GatewaySettlementLineCreateManyInput {
  return {
    provider: "RAZORPAY",
    entityId: row.entity_id,
    type: row.type,
    settlementId: row.settlement_id ?? null,
    settlementUtr: row.settlement_utr ?? null,
    settledAt:
      row.settled_at === null || row.settled_at === undefined
        ? null
        : new Date(row.settled_at * 1000),
    amountPaise: BigInt(row.amount),
    feePaise: BigInt(row.fee ?? 0),
    taxPaise: BigInt(row.tax ?? 0),
    debitPaise: BigInt(row.debit ?? 0),
    creditPaise: BigInt(row.credit ?? 0),
    orderId: row.order_id ?? null,
    paymentId: row.payment_id ?? null,
    disputeId: row.dispute_id ?? null,
    matchedKind: match.matchedKind,
    matchedId: match.matchedId,
    status: match.status,
    note: match.note,
  };
}

async function fetchReconPage(
  client: NonNullable<ReturnType<typeof getRazorpayClient>>,
  day: IstDay,
  skip: number,
): Promise<ReconRow[]> {
  const raw: unknown = await withRazorpaySdkTimeout("settlements.reports", () =>
    client.settlements.reports({
      year: day.year,
      month: day.month,
      day: day.day,
      count: PAGE_SIZE,
      skip,
    }),
  );
  return reconPageSchema.parse(raw).items;
}

/**
 * Stores the page's rows in order, booking a missing payment fee from the line.
 * Stops at the deadline with a stored prefix, so the next slice resumes at the right `skip`.
 */
async function storePage(
  rows: ReconRow[],
  isPastDeadline: () => boolean,
  result: SettlementReconResult,
): Promise<{ inserted: number; complete: boolean }> {
  const existing = await prisma.gatewaySettlementLine.findMany({
    where: {
      provider: "RAZORPAY",
      entityId: { in: rows.map((r) => r.entity_id) },
    },
    select: { entityId: true, type: true },
  });
  const seen = new Set(existing.map((e) => `${e.entityId}|${e.type}`));
  const lookups = await loadPageLookups(rows);
  const pending: Prisma.GatewaySettlementLineCreateManyInput[] = [];
  let complete = true;
  for (const row of rows) {
    if (seen.has(`${row.entity_id}|${row.type}`)) continue;
    let match = matchLine(row, lookups);
    if (row.type === "payment") {
      const linePaise = row.fee ?? 0;
      const booked = lookups.bookedFees.get(row.entity_id);
      if (booked === undefined && linePaise > 0) {
        if (isPastDeadline()) {
          complete = false;
          break;
        }
        await postGatewayFee(prisma, {
          gatewayPaymentId: row.entity_id,
          feePaise: linePaise,
          taxPaise: row.tax ?? 0,
        });
        result.feesPosted += 1;
      } else if (booked !== undefined && booked !== linePaise) {
        match = {
          ...match,
          status: match.status === "MATCHED" ? "FEE_MISMATCH" : match.status,
          note: [match.note, `fee gateway ${linePaise} vs booked ${booked}`]
            .filter(Boolean)
            .join("; "),
        };
      }
    }
    pending.push(lineData(row, match));
    result.byStatus[match.status] += 1;
  }
  if (pending.length === 0) return { inserted: 0, complete };
  const { count } = await prisma.gatewaySettlementLine.createMany({
    data: pending,
    skipDuplicates: true,
  });
  return { inserted: count, complete };
}

/** One `settlement:<id>` journal per settlement on a fully read day. */
async function postSettlementJournals(
  day: IstDay,
  result: SettlementReconResult,
): Promise<void> {
  const groups = await prisma.gatewaySettlementLine.groupBy({
    by: ["settlementId"],
    where: {
      provider: "RAZORPAY",
      settledAt: { gte: day.start, lt: day.end },
      settlementId: { not: null },
    },
    _sum: { creditPaise: true, debitPaise: true },
  });
  const keys = groups.flatMap((g) =>
    g.settlementId ? [`settlement:${g.settlementId}`] : [],
  );
  if (keys.length === 0) return;
  const posted = await prisma.ledgerTransaction.findMany({
    where: { idempotencyKey: { in: keys } },
    select: { idempotencyKey: true },
  });
  const postedKeys = new Set(posted.map((p) => p.idempotencyKey));
  for (const g of groups) {
    if (!g.settlementId) continue;
    const key = `settlement:${g.settlementId}`;
    if (postedKeys.has(key)) continue;
    const net = sumPaise(g._sum.creditPaise) - sumPaise(g._sum.debitPaise);
    if (net === 0) continue;
    const toCash = net > 0;
    await postLedgerTxn(prisma, {
      idempotencyKey: key,
      kind: "GATEWAY_SETTLEMENT",
      description: `Razorpay settlement ${g.settlementId}`,
      postings: [
        {
          account: toCash ? { kind: "CASH" } : gatewayCashAccount(),
          direction: "DEBIT",
          amountPaise: Math.abs(net),
        },
        {
          account: toCash ? gatewayCashAccount() : { kind: "CASH" },
          direction: "CREDIT",
          amountPaise: Math.abs(net),
        },
      ],
    });
    result.settlementsPosted += 1;
  }
}

async function reconcileGatewaySettlements(
  now: Date,
  startedAt: number,
): Promise<SettlementReconResult> {
  const result: SettlementReconResult = {
    success: true,
    fetched: 0,
    inserted: 0,
    feesPosted: 0,
    settlementsPosted: 0,
    done: false,
    byStatus: { MATCHED: 0, AMOUNT_MISMATCH: 0, FEE_MISMATCH: 0, UNMATCHED: 0 },
  };
  const client = getRazorpayClient();
  if (!client) return { ...result, skipped: "NO_GATEWAY_CLIENT", done: true };
  const isPastDeadline = startDeadline(startedAt);

  for (const daysBack of DAYS_BACK) {
    if (isPastDeadline()) return result;
    const day = istDay(now, daysBack);
    const stored = await prisma.gatewaySettlementLine.count({
      where: {
        provider: "RAZORPAY",
        settledAt: { gte: day.start, lt: day.end },
      },
    });
    const rows = await fetchReconPage(client, day, stored);
    result.fetched += rows.length;
    if (rows.length > 0) {
      const page = await storePage(rows, isPastDeadline, result);
      result.inserted += page.inserted;
      // One page per slice; only a page that adds nothing means this day is read.
      if (!page.complete || page.inserted > 0) return result;
    }
    await postSettlementJournals(day, result);
  }
  result.done = true;
  return result;
}

/** Reports once per run, and only when a line disagrees with our books. */
function reportMismatches(result: SettlementReconResult): void {
  const { AMOUNT_MISMATCH, FEE_MISMATCH, UNMATCHED } = result.byStatus;
  if (AMOUNT_MISMATCH + FEE_MISMATCH + UNMATCHED === 0) return;
  reportSentryMessage("Razorpay settlement lines disagree with the books", {
    subsystem: "payments",
    op: RECONCILE_GATEWAY_SETTLEMENTS_JOB,
    level: "warning",
    extra: { ...result.byStatus },
    fingerprint: [RECONCILE_GATEWAY_SETTLEMENTS_JOB, "mismatch"],
  });
}

/** `startedAt` is when the request reached the route, so the drain deadline counts the cold boot. */
export async function runReconcileGatewaySettlements(
  startedAt: number = Date.now(),
  now: Date = new Date(startedAt),
): Promise<SettlementReconResult> {
  const result = await withCronLock(
    "reconcile-gateway-settlements",
    { failMode: "closed" },
    () => reconcileGatewaySettlements(now, startedAt),
  );
  reportMismatches(result);
  return result;
}
