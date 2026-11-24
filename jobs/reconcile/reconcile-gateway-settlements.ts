/**
 * Daily Razorpay settlement reconciliation (ticker, 06:30–12:30 UTC window).
 *
 * Each run walks the settlement recon report forward one IST day at a time,
 * from the day after its checkpoint to yesterday, reading every day from the
 * first page to a short page. It stores the valid lines, matches each to our
 * money row, books a missing capture fee under `gatewayfee:<pay_id>`,
 * re-matches lines still unresolved, and posts one `settlement:<setl_id>`
 * journal (GATEWAY_CLEARING to CASH) only when the stored lines add up to the
 * settlement entity's amount. A posted journal is never edited; a difference is
 * reported.
 */
import { z } from "zod";
import type {
  GatewaySettlementLineStatus,
  GatewaySettlementMatchKind,
  Prisma,
} from "@prisma/client";
import prisma from "@/lib/prisma";
import { readJobCheckpoint, withCronLock } from "@/lib/cron/with-cron-lock";
import type { ConfigSkip } from "@/lib/cron/config-skip";
import { InvalidDateParamError } from "@/lib/cron/date-param";
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
import { reportStandingFinding } from "@/lib/observability/standing-finding";
import { sumPaise } from "@/lib/payments/utils/money";

const RECONCILE_GATEWAY_SETTLEMENTS_JOB = "reconcile-gateway-settlements";

/** Razorpay's maximum `count` for the recon endpoint. */
const PAGE_SIZE = 1000;
const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
/** Days of the report one run reads; a longer gap is closed over the next runs. */
const MAX_DAYS_PER_RUN = 10;
/** Pages one day may take; a larger day stops the walk and shows as days behind. */
const MAX_PAGES_PER_DAY = 20;
/** Settlements settled longer ago than this are compared and posted only while their days are being read. */
const SETTLEMENT_LOOKBACK_DAYS = 60;
/** Settlement entities one run fetches. */
const MAX_SETTLEMENTS_PER_RUN = 50;
/** Unresolved lines one run re-matches. */
const REMATCH_BATCH = 200;
const UNRESOLVED_STATUSES: GatewaySettlementLineStatus[] = [
  "UNMATCHED",
  "AMOUNT_MISMATCH",
  "FEE_MISMATCH",
];

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

/** Rows are validated one at a time, so one bad row never rejects its page. */
const reconPageSchema = z
  .object({ items: z.array(z.unknown()).default([]) })
  .passthrough();

const settlementEntitySchema = z
  .object({ id: z.string(), amount: z.number().int() })
  .passthrough();

const dayKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

interface SettlementReconResult {
  success: true;
  skipped?: ConfigSkip;
  fetched: number;
  inserted: number;
  feesPosted: number;
  settlementsPosted: number;
  /** Report rows that failed validation and were not stored. */
  rejectedRows: number;
  /** Stored lines whose match changed on this pass. */
  rematched: number;
  /** Settlements not booked because their lines do not add up to the settlement amount. */
  settlementsHeld: number;
  /** Posted settlement journals that differ from their stored lines. */
  postedMismatches: number;
  /** IST days up to yesterday still unread after this run. */
  daysBehind: number;
  /** True when every day up to yesterday is read and no settlement was left unexamined. */
  done: boolean;
  /** The last IST day read in full (YYYY-MM-DD); absent on a manual run of one date. */
  checkpoint?: string;
  byStatus: Record<GatewaySettlementLineStatus, number>;
}

interface HeldSettlement {
  settlementId: string;
  linesNetPaise: number;
  /** Null when the settlement entity could not be read. */
  settlementAmountPaise: number | null;
}

interface PostedMismatch {
  settlementId: string;
  postedPaise: number;
  linesNetPaise: number;
}

interface SettlementFindings {
  held: HeldSettlement[];
  postedMismatches: PostedMismatch[];
}

interface IstDay {
  year: number;
  month: number;
  day: number;
  start: Date;
  end: Date;
}

/** The IST calendar day that starts at `start`, with its UTC bounds. */
function istDayFrom(start: Date): IstDay {
  const ist = new Date(start.getTime() + IST_OFFSET_MS);
  return {
    year: ist.getUTCFullYear(),
    month: ist.getUTCMonth() + 1,
    day: ist.getUTCDate(),
    start,
    end: new Date(start.getTime() + DAY_MS),
  };
}

/** The IST calendar day that contains `instant`. */
function istDayOf(instant: Date): IstDay {
  const shifted = instant.getTime() + IST_OFFSET_MS;
  return istDayFrom(
    new Date(Math.floor(shifted / DAY_MS) * DAY_MS - IST_OFFSET_MS),
  );
}

const dayKey = (day: IstDay): string =>
  `${day.year}-${String(day.month).padStart(2, "0")}-${String(day.day).padStart(2, "0")}`;

/** The IST day a `YYYY-MM-DD` key names, or null when it is not a calendar date. */
function dayFromKey(key: string): IstDay | null {
  if (!dayKeySchema.safeParse(key).success) return null;
  const [year, month, date] = key.split("-").map(Number);
  const day = istDayFrom(
    new Date(Date.UTC(year, month - 1, date) - IST_OFFSET_MS),
  );
  return dayKey(day) === key ? day : null;
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

type RazorpayClient = NonNullable<ReturnType<typeof getRazorpayClient>>;

/** One page of a day's report: its valid rows, and how many rows came and were rejected. */
async function fetchReconPage(
  client: RazorpayClient,
  day: IstDay,
  skip: number,
): Promise<{ rows: ReconRow[]; fetched: number; rejected: number }> {
  const raw: unknown = await withRazorpaySdkTimeout("settlements.reports", () =>
    client.settlements.reports({
      year: day.year,
      month: day.month,
      day: day.day,
      count: PAGE_SIZE,
      skip,
    }),
  );
  const items = reconPageSchema.parse(raw).items;
  const rows: ReconRow[] = [];
  for (const item of items) {
    const row = reconRowSchema.safeParse(item);
    if (row.success) rows.push(row.data);
  }
  return { rows, fetched: items.length, rejected: items.length - rows.length };
}

/** A payment line whose fee differs from the fee already booked for it. */
function feeChecked(
  row: ReconRow,
  match: LineMatch,
  booked: number | undefined,
): LineMatch {
  const linePaise = row.fee ?? 0;
  if (row.type !== "payment" || booked === undefined || booked === linePaise) {
    return match;
  }
  return {
    ...match,
    status: match.status === "MATCHED" ? "FEE_MISMATCH" : match.status,
    note: [match.note, `fee gateway ${linePaise} vs booked ${booked}`]
      .filter(Boolean)
      .join("; "),
  };
}

/**
 * Stores the page's rows in order, booking a missing payment fee from the line.
 * Stops at the deadline with a stored prefix; the day is then read again from its first page.
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
    const booked = lookups.bookedFees.get(row.entity_id);
    if (row.type === "payment" && booked === undefined && (row.fee ?? 0) > 0) {
      if (isPastDeadline()) {
        complete = false;
        break;
      }
      await postGatewayFee(prisma, {
        gatewayPaymentId: row.entity_id,
        feePaise: row.fee ?? 0,
        taxPaise: row.tax ?? 0,
      });
      result.feesPosted += 1;
    }
    const match = feeChecked(row, matchLine(row, lookups), booked);
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

/** Reads one day from its first page to a short page; false when the deadline or the page bound cut it short. */
async function readDay(
  client: RazorpayClient,
  day: IstDay,
  isPastDeadline: () => boolean,
  result: SettlementReconResult,
): Promise<boolean> {
  for (let page = 0; page < MAX_PAGES_PER_DAY; page++) {
    if (isPastDeadline()) return false;
    const { rows, fetched, rejected } = await fetchReconPage(
      client,
      day,
      page * PAGE_SIZE,
    );
    result.fetched += fetched;
    result.rejectedRows += rejected;
    if (rows.length > 0) {
      const stored = await storePage(rows, isPastDeadline, result);
      result.inserted += stored.inserted;
      if (!stored.complete) return false;
    }
    if (fetched < PAGE_SIZE) return true;
  }
  return false;
}

/**
 * The first day to read, and the last day already read in full. The walk
 * starts the day after the checkpoint (without one, on the day of the last
 * stored line) and never later than the day before yesterday, so late rows of
 * the last two days are still picked up.
 */
async function firstDayToRead(
  yesterday: IstDay,
): Promise<{ first: IstDay; readThrough: IstDay | null }> {
  const dayBefore = istDayFrom(new Date(yesterday.start.getTime() - DAY_MS));
  const stored = await readJobCheckpoint(RECONCILE_GATEWAY_SETTLEMENTS_JOB);
  const readThrough = stored ? dayFromKey(stored) : null;
  let anchor = readThrough ? istDayFrom(readThrough.end) : null;
  if (!anchor) {
    const last = await prisma.gatewaySettlementLine.findFirst({
      where: { provider: "RAZORPAY", settledAt: { not: null } },
      orderBy: { settledAt: "desc" },
      select: { settledAt: true },
    });
    anchor = last?.settledAt ? istDayOf(last.settledAt) : null;
  }
  return {
    first: anchor && anchor.start < dayBefore.start ? anchor : dayBefore,
    readThrough,
  };
}

/** Matches again a bounded, rotating batch of lines that no earlier pass resolved. */
async function rematchUnresolved(
  now: Date,
  result: SettlementReconResult,
): Promise<void> {
  const where = {
    provider: "RAZORPAY" as const,
    status: { in: UNRESOLVED_STATUSES },
  };
  const total = await prisma.gatewaySettlementLine.count({ where });
  if (total === 0) return;
  const lines = await prisma.gatewaySettlementLine.findMany({
    where,
    orderBy: [{ fetchedAt: "asc" }, { id: "asc" }],
    // Hour by hour the window moves on, so a backlog larger than one batch is still covered.
    skip:
      total > REMATCH_BATCH
        ? (Math.floor(now.getTime() / 3_600_000) * REMATCH_BATCH) % total
        : 0,
    take: REMATCH_BATCH,
    select: {
      id: true,
      entityId: true,
      type: true,
      amountPaise: true,
      feePaise: true,
      paymentId: true,
      disputeId: true,
      matchedKind: true,
      matchedId: true,
      status: true,
      note: true,
    },
  });
  const rows: ReconRow[] = lines.map((line) => ({
    entity_id: line.entityId,
    type: line.type,
    amount: sumPaise(line.amountPaise),
    fee: sumPaise(line.feePaise),
    payment_id: line.paymentId,
    dispute_id: line.disputeId,
  }));
  const lookups = await loadPageLookups(rows);
  for (const [index, line] of lines.entries()) {
    const row = rows[index];
    const next = feeChecked(
      row,
      matchLine(row, lookups),
      lookups.bookedFees.get(row.entity_id),
    );
    if (
      next.status === line.status &&
      next.matchedKind === line.matchedKind &&
      next.matchedId === line.matchedId &&
      next.note === line.note
    ) {
      continue;
    }
    const moved = await prisma.gatewaySettlementLine.updateMany({
      where: { id: line.id, status: line.status },
      data: {
        matchedKind: next.matchedKind,
        matchedId: next.matchedId,
        status: next.status,
        note: next.note,
      },
    });
    result.rematched += moved.count;
  }
}

/** The settlement entity's amount in paise, or null when it cannot be read. */
async function fetchSettlementAmount(
  client: RazorpayClient,
  settlementId: string,
): Promise<number | null> {
  try {
    const raw: unknown = await withRazorpaySdkTimeout("settlements.fetch", () =>
      client.settlements.fetch(settlementId),
    );
    const entity = settlementEntitySchema.safeParse(raw);
    return entity.success && entity.data.id === settlementId
      ? entity.data.amount
      : null;
  } catch (error) {
    console.warn(
      `Could not read settlement ${settlementId}:`,
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

/**
 * Posts one `settlement:<id>` journal for each settlement in the window whose
 * stored lines add up to the settlement entity's amount; any other settlement
 * is held. A journal already posted is only compared with its lines.
 * Returns false when settlements were left unexamined.
 */
async function postSettlementJournals(
  client: RazorpayClient,
  window: { gte: Date; lt: Date },
  isPastDeadline: () => boolean,
  result: SettlementReconResult,
  findings: SettlementFindings,
): Promise<boolean> {
  const groups = await prisma.gatewaySettlementLine.groupBy({
    by: ["settlementId"],
    where: {
      provider: "RAZORPAY",
      settledAt: window,
      settlementId: { not: null },
    },
    _sum: { creditPaise: true, debitPaise: true },
  });
  const nets = groups.flatMap((g) =>
    g.settlementId
      ? [
          {
            settlementId: g.settlementId,
            net: sumPaise(g._sum.creditPaise) - sumPaise(g._sum.debitPaise),
          },
        ]
      : [],
  );
  if (nets.length === 0) return true;
  const posted = await debitTotalsByKey(
    nets.map((n) => `settlement:${n.settlementId}`),
  );
  let fetched = 0;
  for (const { settlementId, net } of nets) {
    const key = `settlement:${settlementId}`;
    const postedPaise = posted.get(key);
    if (postedPaise !== undefined) {
      if (postedPaise !== Math.abs(net)) {
        findings.postedMismatches.push({
          settlementId,
          postedPaise,
          linesNetPaise: net,
        });
      }
      continue;
    }
    if (net === 0) continue;
    if (fetched >= MAX_SETTLEMENTS_PER_RUN || isPastDeadline()) return false;
    fetched += 1;
    const settlementAmountPaise = await fetchSettlementAmount(
      client,
      settlementId,
    );
    if (settlementAmountPaise !== net) {
      findings.held.push({
        settlementId,
        linesNetPaise: net,
        settlementAmountPaise,
      });
      continue;
    }
    const toCash = net > 0;
    await postLedgerTxn(prisma, {
      idempotencyKey: key,
      kind: "GATEWAY_SETTLEMENT",
      description: `Razorpay settlement ${settlementId}`,
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
  return true;
}

async function reconcileGatewaySettlements(
  now: Date,
  startedAt: number,
  manualDay: IstDay | null,
): Promise<{ result: SettlementReconResult; findings: SettlementFindings }> {
  const result: SettlementReconResult = {
    success: true,
    fetched: 0,
    inserted: 0,
    feesPosted: 0,
    settlementsPosted: 0,
    rejectedRows: 0,
    rematched: 0,
    settlementsHeld: 0,
    postedMismatches: 0,
    daysBehind: 0,
    done: false,
    byStatus: { MATCHED: 0, AMOUNT_MISMATCH: 0, FEE_MISMATCH: 0, UNMATCHED: 0 },
  };
  const findings: SettlementFindings = { held: [], postedMismatches: [] };
  const client = getRazorpayClient();
  if (!client) {
    return {
      result: {
        ...result,
        skipped: "RAZORPAY_KEY_ID or RAZORPAY_SECRET not configured",
        done: true,
      },
      findings,
    };
  }
  const isPastDeadline = startDeadline(startedAt);
  const yesterday = istDayOf(new Date(now.getTime() - DAY_MS));

  const days: IstDay[] = [];
  let readThrough: IstDay | null = null;
  if (manualDay) {
    days.push(manualDay);
  } else {
    const start = await firstDayToRead(yesterday);
    readThrough = start.readThrough;
    for (
      let day = start.first;
      day.start <= yesterday.start && days.length < MAX_DAYS_PER_RUN;
      day = istDayFrom(day.end)
    ) {
      days.push(day);
    }
  }

  let lastRead: IstDay | null = null;
  for (const day of days) {
    if (!(await readDay(client, day, isPastDeadline, result))) break;
    lastRead = day;
  }

  let window: { gte: Date; lt: Date } | null = null;
  if (manualDay) {
    if (lastRead) window = { gte: manualDay.start, lt: manualDay.end };
    result.done = lastRead !== null;
  } else {
    if (lastRead && (!readThrough || lastRead.start > readThrough.start)) {
      readThrough = lastRead;
    }
    if (readThrough) {
      result.checkpoint = dayKey(readThrough);
      // The lookback, widened to the days this run read when it is catching up further back.
      window = {
        gte: new Date(
          Math.min(
            now.getTime() - SETTLEMENT_LOOKBACK_DAYS * DAY_MS,
            days[0].start.getTime(),
          ),
        ),
        lt: readThrough.end,
      };
    }
    const firstUnread = readThrough ? readThrough.end : days[0].start;
    result.daysBehind = Math.max(
      0,
      Math.round((yesterday.end.getTime() - firstUnread.getTime()) / DAY_MS),
    );
    result.done = result.daysBehind === 0;
  }

  if (isPastDeadline()) return { result: { ...result, done: false }, findings };
  await rematchUnresolved(now, result);
  if (window) {
    const examined = await postSettlementJournals(
      client,
      window,
      isPastDeadline,
      result,
      findings,
    );
    if (!examined) result.done = false;
  }
  result.settlementsHeld = findings.held.length;
  result.postedMismatches = findings.postedMismatches.length;
  return { result, findings };
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

/** Once per run: rejected rows, settlements held back, and posted journals that differ from their lines. */
async function reportSettlementFindings(
  result: SettlementReconResult,
  findings: SettlementFindings,
): Promise<void> {
  if (result.rejectedRows > 0) {
    reportSentryMessage(
      `Razorpay settlement report: ${result.rejectedRows} row(s) failed validation and were not stored`,
      {
        subsystem: "payments",
        op: RECONCILE_GATEWAY_SETTLEMENTS_JOB,
        level: "error",
        extra: { rejectedRows: result.rejectedRows },
        fingerprint: [RECONCILE_GATEWAY_SETTLEMENTS_JOB, "rejected-rows"],
      },
    );
  }
  if (findings.held.length > 0) {
    const message = `${findings.held.length} Razorpay settlement(s) not booked: the stored lines do not add up to the settlement amount`;
    await reportStandingFinding(
      {
        key: `${RECONCILE_GATEWAY_SETTLEMENTS_JOB}:held`,
        ids: findings.held.map((h) => h.settlementId),
        message,
      },
      () =>
        reportSentryMessage(message, {
          subsystem: "payments",
          op: RECONCILE_GATEWAY_SETTLEMENTS_JOB,
          level: "warning",
          extra: { held: findings.held.slice(0, 20) },
          fingerprint: [RECONCILE_GATEWAY_SETTLEMENTS_JOB, "held"],
        }),
    );
  }
  if (findings.postedMismatches.length > 0) {
    const message = `${findings.postedMismatches.length} posted Razorpay settlement journal(s) differ from their stored lines; the ledger is immutable, so correct by a hand journal`;
    await reportStandingFinding(
      {
        key: `${RECONCILE_GATEWAY_SETTLEMENTS_JOB}:posted-differs`,
        ids: findings.postedMismatches.map((m) => m.settlementId),
        message,
      },
      () =>
        reportSentryMessage(message, {
          subsystem: "payments",
          op: RECONCILE_GATEWAY_SETTLEMENTS_JOB,
          level: "error",
          extra: { posted: findings.postedMismatches.slice(0, 20) },
          fingerprint: [RECONCILE_GATEWAY_SETTLEMENTS_JOB, "posted-differs"],
        }),
    );
  }
}

/**
 * `startedAt` is when the request reached the route, so the drain deadline
 * counts the cold boot. `date` (YYYY-MM-DD, an IST day before today) reads that
 * one day and leaves the walk's checkpoint alone.
 */
export async function runReconcileGatewaySettlements(
  startedAt: number = Date.now(),
  now: Date = new Date(startedAt),
  options: { date?: string } = {},
): Promise<SettlementReconResult> {
  let manualDay: IstDay | null = null;
  if (options.date !== undefined) {
    manualDay = dayFromKey(options.date);
    if (!manualDay || manualDay.end.getTime() > istDayOf(now).start.getTime()) {
      throw new InvalidDateParamError();
    }
  }
  let findings: SettlementFindings = { held: [], postedMismatches: [] };
  // The lock records the checkpoint from the result it is handed.
  const result = await withCronLock(
    "reconcile-gateway-settlements",
    { failMode: "closed" },
    async () => {
      const run = await reconcileGatewaySettlements(now, startedAt, manualDay);
      findings = run.findings;
      return run.result;
    },
  );
  reportMismatches(result);
  await reportSettlementFindings(result, findings);
  return result;
}
