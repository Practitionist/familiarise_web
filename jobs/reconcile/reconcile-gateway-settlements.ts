/**
 * Daily Razorpay settlement reconciliation (ticker, 06:30–12:30 UTC window).
 *
 * Each run walks the settlement recon report forward one IST day at a time,
 * from the day after the last day read in full to yesterday, then reads the
 * last two days again. It stores the valid lines, matches each to our money
 * row, books a missing capture fee under `gatewayfee:<pay_id>`, re-matches
 * lines still unresolved, and posts one `settlement:<setl_id>` journal
 * (GATEWAY_CLEARING to CASH) only when the stored lines add up to the
 * settlement entity's amount. Every bound (pages, days, lines, settlement
 * reads) resumes from one continuation record kept as the job's checkpoint.
 * A posted journal is never edited; a difference is reported.
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
/** Pages of one day a run reads; a larger day resumes at the next page on the next run. */
const MAX_PAGES_PER_DAY = 20;
/** Dates whose report failed and which the walk passed over; one is retried each run. */
const MAX_FAILED_DAYS = 5;
/** One report page gets this long, so a date that times out cannot spend the run's whole time budget. */
const REPORT_TIMEOUT_MS = 8_000;
/** Settlements settled longer ago than this are examined only until a full pass has covered the days read. */
const SETTLEMENT_LOOKBACK_DAYS = 60;
/** Settlement entities one run fetches; the next run goes on after the last one. */
const MAX_SETTLEMENTS_PER_RUN = 50;
/** Unresolved lines one run re-matches; the next run goes on after the last one. */
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

/**
 * Where the next run resumes: the last day read in full, the page a capped day
 * stopped at, the last line re-matched, and the settlement examination pass.
 * `settle.from` is the earliest day read outside the lookback that no full pass
 * has covered yet; `stale` says such a day was read while a pass was under way.
 * `failedDays` are days at or before `read` whose report could not be read.
 */
const continuationSchema = z.object({
  read: dayKeySchema.nullable(),
  day: z
    .object({ key: dayKeySchema, skip: z.number().int().nonnegative() })
    .nullable(),
  rematchAfter: z.string().nullable(),
  settle: z.object({
    from: dayKeySchema.nullable(),
    after: z.string().nullable(),
    stale: z.boolean(),
  }),
  failedDays: z.array(dayKeySchema).max(MAX_FAILED_DAYS).default([]),
});
type Continuation = z.infer<typeof continuationSchema>;

const freshContinuation = (): Continuation => ({
  read: null,
  day: null,
  rematchAfter: null,
  settle: { from: null, after: null, stale: false },
  failedDays: [],
});

/** The stored continuation; a missing or unreadable one starts the walk from the stored lines. */
async function readContinuation(): Promise<Continuation> {
  const stored = await readJobCheckpoint(RECONCILE_GATEWAY_SETTLEMENTS_JOB);
  if (!stored) return freshContinuation();
  try {
    const parsed = continuationSchema.safeParse(JSON.parse(stored));
    return parsed.success ? parsed.data : freshContinuation();
  } catch {
    return freshContinuation();
  }
}

/**
 * A bound that stopped a report read or the settlement examination before its
 * end. `reached` is the report rows read for the day, or the settlement
 * entities examined in this run, with `after` the last one examined.
 */
interface StoppedShort {
  bound: "report-pages" | "settlement-reads" | "failed-days" | "deadline";
  stage: "report" | "settlements";
  /** The IST day being read or examined; absent for the scheduled settlement cohort. */
  date?: string;
  reached: number;
  after?: string | null;
}

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
  /** IST days whose report could not be read in this run or is still waiting for a retry. */
  failedDays: string[];
  /** Every bound that cut this run short; empty when each read and the examination reached its end. */
  stoppedShort: StoppedShort[];
  /** True when every day up to yesterday is read and no settlement was left unexamined. */
  done: boolean;
  /** The continuation record as JSON; absent on a manual run of one date. */
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

interface ReportFailure {
  date: string;
  message: string;
}

interface SettlementFindings {
  held: HeldSettlement[];
  postedMismatches: PostedMismatch[];
  reportFailures: ReportFailure[];
}

const noFindings = (): SettlementFindings => ({
  held: [],
  postedMismatches: [],
  reportFailures: [],
});

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
  const raw: unknown = await withRazorpaySdkTimeout(
    "settlements.reports",
    () =>
      client.settlements.reports({
        year: day.year,
        month: day.month,
        day: day.day,
        count: PAGE_SIZE,
        skip,
      }),
    REPORT_TIMEOUT_MS,
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

/**
 * Reads a day's pages from `skip` until a short page. A read cut by the
 * deadline or the page bound is noted on the result and says where the next
 * run resumes.
 */
async function readDay(
  client: RazorpayClient,
  day: IstDay,
  skip: number,
  isPastDeadline: () => boolean,
  result: SettlementReconResult,
): Promise<{ complete: boolean; nextSkip: number }> {
  let offset = skip;
  const cutBy = (bound: "report-pages" | "deadline") => {
    result.stoppedShort.push({
      bound,
      stage: "report",
      date: dayKey(day),
      reached: offset,
    });
    return { complete: false, nextSkip: offset };
  };
  for (let page = 0; page < MAX_PAGES_PER_DAY; page++) {
    if (isPastDeadline()) return cutBy("deadline");
    const { rows, fetched, rejected } = await fetchReconPage(
      client,
      day,
      offset,
    );
    result.fetched += fetched;
    result.rejectedRows += rejected;
    if (rows.length > 0) {
      const stored = await storePage(rows, isPastDeadline, result);
      result.inserted += stored.inserted;
      if (!stored.complete) return cutBy("deadline");
    }
    if (fetched < PAGE_SIZE) return { complete: true, nextSkip: 0 };
    offset += PAGE_SIZE;
  }
  return cutBy("report-pages");
}

/**
 * The first day not yet read: the day after the last day read in full, or with
 * no record the day of the last stored line, never later than the day before
 * yesterday.
 */
async function firstUnreadDay(
  read: IstDay | null,
  dayBefore: IstDay,
): Promise<IstDay> {
  if (read) return istDayFrom(read.end);
  const last = await prisma.gatewaySettlementLine.findFirst({
    where: { provider: "RAZORPAY", settledAt: { not: null } },
    orderBy: { settledAt: "desc" },
    select: { settledAt: true },
  });
  const anchor = last?.settledAt ? istDayOf(last.settledAt) : null;
  return anchor && anchor.start < dayBefore.start ? anchor : dayBefore;
}

const UNRESOLVED_LINE_SELECT = {
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
} as const;

/** The next batch of unresolved lines after `after`, in id order. */
function unresolvedLinesAfter(after: string | null) {
  return prisma.gatewaySettlementLine.findMany({
    where: {
      provider: "RAZORPAY",
      status: { in: UNRESOLVED_STATUSES },
      ...(after === null ? {} : { id: { gt: after } }),
    },
    orderBy: { id: "asc" },
    take: REMATCH_BATCH,
    select: UNRESOLVED_LINE_SELECT,
  });
}

/**
 * Matches again the next batch of lines no earlier pass resolved. Returns the
 * line to go on after, or null once the last batch was reached.
 */
async function rematchUnresolved(
  after: string | null,
  result: SettlementReconResult,
): Promise<string | null> {
  let lines = await unresolvedLinesAfter(after);
  if (lines.length === 0 && after !== null) {
    lines = await unresolvedLinesAfter(null);
  }
  if (lines.length === 0) return null;
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
  return lines.length < REMATCH_BATCH ? null : lines[lines.length - 1].id;
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
 * is held. Unposted settlements are examined in id order after `after`, a
 * bounded number a run. A journal already posted is only compared with its
 * lines. Returns whether the end of the order was reached, and otherwise the
 * settlement to go on after; a pass cut short is noted on the result under
 * `date`.
 */
async function postSettlementJournals(
  client: RazorpayClient,
  window: { gte: Date; lt: Date },
  after: string | null,
  isPastDeadline: () => boolean,
  result: SettlementReconResult,
  findings: SettlementFindings,
  date?: string,
): Promise<{ finished: boolean; after: string | null }> {
  const groups = await prisma.gatewaySettlementLine.groupBy({
    by: ["settlementId"],
    where: {
      provider: "RAZORPAY",
      settledAt: window,
      settlementId: { not: null },
    },
    _sum: { creditPaise: true, debitPaise: true },
  });
  const nets = groups
    .flatMap((g) =>
      g.settlementId
        ? [
            {
              settlementId: g.settlementId,
              net: sumPaise(g._sum.creditPaise) - sumPaise(g._sum.debitPaise),
            },
          ]
        : [],
    )
    // Code-unit order, so the cursor compares the same way in every run.
    .sort(
      (a, b) =>
        Number(a.settlementId > b.settlementId) -
        Number(a.settlementId < b.settlementId),
    );
  if (nets.length === 0) return { finished: true, after: null };
  const posted = await debitTotalsByKey(
    nets.map((n) => `settlement:${n.settlementId}`),
  );
  let fetched = 0;
  let last = after;
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
    if (after !== null && settlementId <= after) continue;
    const capped = fetched >= MAX_SETTLEMENTS_PER_RUN;
    if (capped || isPastDeadline()) {
      result.stoppedShort.push({
        bound: capped ? "settlement-reads" : "deadline",
        stage: "settlements",
        ...(date === undefined ? {} : { date }),
        reached: fetched,
        after: last,
      });
      return { finished: false, after: last };
    }
    fetched += 1;
    last = settlementId;
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
  return { finished: true, after: null };
}

function emptyResult(): SettlementReconResult {
  return {
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
    failedDays: [],
    stoppedShort: [],
    done: false,
    byStatus: { MATCHED: 0, AMOUNT_MISMATCH: 0, FEE_MISMATCH: 0, UNMATCHED: 0 },
  };
}

interface RunOutput {
  result: SettlementReconResult;
  findings: SettlementFindings;
}

/**
 * A manual run of one IST day: reads it from its first page and examines its
 * settlements from the first. It keeps no position, so a day past the page
 * bound or the settlement-read bound answers `done: false` with the bound and
 * how far it got, and repeating the run does not get further.
 */
async function reconcileOneDay(
  client: RazorpayClient,
  day: IstDay,
  isPastDeadline: () => boolean,
): Promise<RunOutput> {
  const result = emptyResult();
  const findings = noFindings();
  const read = await readDay(client, day, 0, isPastDeadline, result);
  if (read.complete && isPastDeadline()) {
    result.stoppedShort.push({
      bound: "deadline",
      stage: "settlements",
      date: dayKey(day),
      reached: 0,
    });
  }
  if (isPastDeadline()) return { result, findings };
  await rematchUnresolved(null, result);
  if (read.complete) {
    const examined = await postSettlementJournals(
      client,
      { gte: day.start, lt: day.end },
      null,
      isPastDeadline,
      result,
      findings,
      dayKey(day),
    );
    result.done = examined.finished;
  }
  result.settlementsHeld = findings.held.length;
  result.postedMismatches = findings.postedMismatches.length;
  return { result, findings };
}

/**
 * The scheduled walk: one earlier failed date, then unread days, then the last
 * two days again, then the later passes.
 */
async function reconcileFromContinuation(
  client: RazorpayClient,
  now: Date,
  isPastDeadline: () => boolean,
): Promise<RunOutput> {
  const result = emptyResult();
  const findings = noFindings();
  const state = await readContinuation();
  const yesterday = istDayOf(new Date(now.getTime() - DAY_MS));
  const dayBefore = istDayFrom(new Date(yesterday.start.getTime() - DAY_MS));
  const readBefore = state.read ? dayFromKey(state.read) : null;
  const firstUnread = await firstUnreadDay(readBefore, dayBefore);

  // A date whose report throws is noted and never ends the run.
  const readSafely = async (day: IstDay, skip: number) => {
    try {
      return await readDay(client, day, skip, isPastDeadline, result);
    } catch (error) {
      findings.reportFailures.push({
        date: dayKey(day),
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };
  const completed: IstDay[] = [];

  // One date that failed earlier is tried again first; if it fails again it goes to the back.
  const retryKey = state.failedDays[0];
  const retryDay = retryKey === undefined ? null : dayFromKey(retryKey);
  if (retryKey !== undefined) {
    state.failedDays = state.failedDays.slice(1);
    const outcome = retryDay ? await readSafely(retryDay, 0) : null;
    if (retryDay && outcome?.complete) completed.push(retryDay);
    else if (retryDay) state.failedDays.push(retryKey);
  }

  let read = readBefore;
  let cut = false;
  let passedOver = false;
  for (
    let day = firstUnread, count = 0;
    day.start <= yesterday.start && count < MAX_DAYS_PER_RUN;
    day = istDayFrom(day.end), count++
  ) {
    const skip = state.day?.key === dayKey(day) ? state.day.skip : 0;
    const outcome = await readSafely(day, skip);
    if (outcome === null) {
      // One failing date a run is passed over for a later retry; a second
      // one, or a full list, stops the walk at that date.
      const listFull = state.failedDays.length >= MAX_FAILED_DAYS;
      if (passedOver || listFull) {
        if (listFull) {
          result.stoppedShort.push({
            bound: "failed-days",
            stage: "report",
            date: dayKey(day),
            reached: state.failedDays.length,
          });
        }
        cut = true;
        break;
      }
      passedOver = true;
      state.failedDays.push(dayKey(day));
      read = day;
      state.read = dayKey(day);
      state.day = null;
      continue;
    }
    if (!outcome.complete) {
      state.day = { key: dayKey(day), skip: outcome.nextSkip };
      cut = true;
      break;
    }
    read = day;
    completed.push(day);
    state.read = dayKey(day);
    state.day = null;
  }

  const nextUnread = read ? read.end : firstUnread.start;
  result.daysBehind = Math.max(
    0,
    Math.round((yesterday.end.getTime() - nextUnread.getTime()) / DAY_MS),
  );

  // Late rows: the last two days are read again once nothing older is unread.
  if (!cut && result.daysBehind === 0 && readBefore) {
    for (const day of [dayBefore, yesterday]) {
      if (day.start > readBefore.start) continue;
      const again = await readSafely(day, 0);
      if (again && !again.complete) break;
    }
  }
  const firstCompleted = completed.reduce<IstDay | null>(
    (first, day) => (!first || day.start < first.start ? day : first),
    null,
  );

  // A day read outside the lookback stays in the cohort until a full pass covers it.
  const lookbackStart = now.getTime() - SETTLEMENT_LOOKBACK_DAYS * DAY_MS;
  if (firstCompleted && firstCompleted.start.getTime() < lookbackStart) {
    const from = state.settle.from ? dayFromKey(state.settle.from) : null;
    if (!from || firstCompleted.start < from.start) {
      state.settle.from = dayKey(firstCompleted);
    }
    if (state.settle.after !== null) state.settle.stale = true;
  }

  let examined = false;
  if (!isPastDeadline()) {
    state.rematchAfter = await rematchUnresolved(state.rematchAfter, result);
    if (read) {
      const from = state.settle.from ? dayFromKey(state.settle.from) : null;
      const pass = await postSettlementJournals(
        client,
        {
          gte: new Date(
            Math.min(lookbackStart, from?.start.getTime() ?? lookbackStart),
          ),
          lt: read.end,
        },
        state.settle.after,
        isPastDeadline,
        result,
        findings,
      );
      state.settle.after = pass.after;
      if (pass.finished) {
        // Days read while this pass was under way wait for the next one.
        if (state.settle.stale) state.settle.stale = false;
        else state.settle.from = null;
      }
      examined = pass.finished;
    } else {
      examined = true;
    }
  }

  result.failedDays = [
    ...new Set([
      ...state.failedDays,
      ...findings.reportFailures.map((failure) => failure.date),
    ]),
  ];
  result.done =
    result.daysBehind === 0 && examined && result.failedDays.length === 0;
  result.checkpoint = JSON.stringify(state);
  result.settlementsHeld = findings.held.length;
  result.postedMismatches = findings.postedMismatches.length;
  return { result, findings };
}

async function reconcileGatewaySettlements(
  now: Date,
  startedAt: number,
  manualDay: IstDay | null,
): Promise<RunOutput> {
  const client = getRazorpayClient();
  if (!client) {
    return {
      result: {
        ...emptyResult(),
        skipped: "RAZORPAY_KEY_ID or RAZORPAY_SECRET not configured",
        done: true,
      },
      findings: noFindings(),
    };
  }
  const isPastDeadline = startDeadline(startedAt);
  return manualDay
    ? reconcileOneDay(client, manualDay, isPastDeadline)
    : reconcileFromContinuation(client, now, isPastDeadline);
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

/** Once per run: rejected rows, bounds that cut the run, settlements held back, and posted journals that differ from their lines. */
async function reportSettlementFindings(
  result: SettlementReconResult,
  findings: SettlementFindings,
): Promise<void> {
  // The deadline is the run's time budget and resumes by itself; a count bound is recorded.
  const bounded = result.stoppedShort.filter((s) => s.bound !== "deadline");
  if (bounded.length > 0) {
    await reportStandingFinding({
      key: `${RECONCILE_GATEWAY_SETTLEMENTS_JOB}:stopped-short`,
      ids: bounded.map((s) => `${s.bound}:${s.date ?? "cohort"}`),
      message: `Razorpay settlement reconciliation stopped at a bound: ${bounded
        .map(
          (s) =>
            `${s.bound}${s.date ? ` on ${s.date}` : ""} after ${s.reached} ${s.stage === "report" ? "report rows" : "settlements"}`,
        )
        .join("; ")}`,
    });
  }
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
  if (findings.reportFailures.length > 0) {
    const message = `Razorpay settlement report could not be read for ${findings.reportFailures.length} date(s): ${findings.reportFailures
      .map((failure) => `${failure.date} (${failure.message})`)
      .join("; ")}; each stays in line for a retry`;
    await reportStandingFinding(
      {
        key: `${RECONCILE_GATEWAY_SETTLEMENTS_JOB}:report-failed`,
        ids: findings.reportFailures.map((failure) => failure.date),
        message,
      },
      () =>
        reportSentryMessage(message, {
          subsystem: "payments",
          op: RECONCILE_GATEWAY_SETTLEMENTS_JOB,
          level: "error",
          extra: { failures: findings.reportFailures },
          fingerprint: [RECONCILE_GATEWAY_SETTLEMENTS_JOB, "report-failed"],
        }),
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
 * one day from its first page and leaves the continuation record alone.
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
  let findings = noFindings();
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
