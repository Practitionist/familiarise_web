/**
 * #1675 / #1527 W2 — the consultee's own payment history: the one read the
 * RSC page seeds react-query with and the API route answers with, so the
 * first paint and every refetch carry the same rows through the same
 * buyer-safe select. Each row also carries the input `derivePaymentPresentation`
 * (lib/dashboard/money-state.ts) reads, built the way the detail page builds
 * its own (lib/appointments/presentation-input.ts), so the list and the detail
 * page cannot disagree about a payment.
 *
 * Auth stays with the caller: the route checks the session against the URL's
 * consultee, the page runs `requirePersonalProfileAccess`. #1527 — the history
 * is paged (offset, one page at a time) instead of silently capped at 250 rows.
 */

import type { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { scopeToWhereOrgId, type Scope } from "@/lib/api/scope/parse";
import { refundedPaise } from "@/lib/appointments/seat-payments";
import { isSponsoredPayment } from "@/lib/appointments/payment-display";
import { lifecycleOf, planOf } from "@/lib/appointments/presentation-input";
import {
  requestHoldDeadline,
  type PaymentInput,
  type PaymentRowInput,
} from "@/lib/dashboard/money-state";
import {
  BUYER_PAYMENT_DISPLAY_SELECT,
  DISCOUNT_CODE_SUMMARY_SELECT,
} from "@/lib/data/payments-select";

/** A Date on the server seed, an ISO string after a JSON refetch. */
type Stamp = Date | string;

export interface ConsulteePaymentRefund {
  id: string;
  amountPaise: number;
  status: string;
  reason: string | null;
  createdAt: Stamp;
}

export interface ConsulteePaymentRow {
  id: string;
  amount: number;
  originalAmount: number;
  taxAmount: number;
  currency: string;
  /** The raw `PaymentStatus`; the words a row shows come from the presentation. */
  status: string;
  paymentMethod: string;
  paymentGateway: string;
  appointmentType: string | null;
  appointmentId: string | null;
  /** #1675 — the buyer already has a support thread on this booking. */
  hasSupportThread: boolean;
  planTitle: string;
  consultantName: string;
  organizationId: string | null;
  discount: { code: string; type: string; value: number } | null;
  refunds: ConsulteePaymentRefund[];
  /** Paise returned so far, counting only refunds that went through. */
  refundedPaise: number;
  /** #1365 — the statutory tax invoice, when one was issued for this payment. */
  consumerInvoice: {
    id: string;
    invoiceNumber: string;
    issuedAt: Stamp;
  } | null;
  receiptUrl: string | null;
  expiresAt: Stamp | null;
  createdAt: Stamp;
  presentation: PaymentRowInput;
}

export interface ConsulteeCreditRow {
  id: string;
  amount: number;
  source: string;
  usedAmount: number;
  remainingAmount: number;
  expiresAt: Stamp | null;
  createdAt: Stamp;
}

export interface ConsulteeCreditUsageRow {
  id: string;
  amount: number;
  createdAt: Stamp;
  credit: { source: string };
  payment: {
    id: string;
    amount: number;
    currency: string;
    createdAt: Stamp;
  } | null;
}

export interface ConsulteePaymentsPayload {
  payments: ConsulteePaymentRow[];
  /** Rows matching the filters across every page. */
  total: number;
  page: number;
  pageSize: number;
  credits: ConsulteeCreditRow[];
  creditUsages: ConsulteeCreditUsageRow[];
  creditSummary: { total: number; used: number; remaining: number };
}

const planSelect = {
  select: {
    title: true,
    price: true,
    priceCurrency: true,
    consultantProfile: {
      select: { user: { select: { name: true } } },
    },
  },
} as const;

/** Credits keep their cap; only the payment history pages (#1527). */
const HISTORY_CAP = 250;
export const PAYMENTS_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/**
 * History chips (#1527). The personal pin leaves no sponsored rows, so the
 * old "Sponsored" chip is gone. Each chip is the WHERE twin of the money
 * states it stood for client-side: paid = PAID/DISPUTED, refunded =
 * REFUNDED/PARTIALLY_REFUNDED/REFUND_PENDING, failed = a charge that never
 * landed.
 */
export const PAYMENT_HISTORY_FILTERS = ["paid", "refunded", "failed"] as const;
export type PaymentHistoryFilter = (typeof PAYMENT_HISTORY_FILTERS)[number];

export const PAYMENT_HISTORY_RANGES = ["30d", "90d", "year"] as const;
export type PaymentHistoryRange = (typeof PAYMENT_HISTORY_RANGES)[number];

export interface PaymentHistoryQuery {
  page?: number;
  pageSize?: number;
  status?: PaymentHistoryFilter | null;
  range?: PaymentHistoryRange | null;
}

const LIVE_REFUND = {
  some: { deletedAt: null, status: { in: ["SUCCEEDED", "PENDING"] } },
} as const satisfies Prisma.RefundListRelationFilter;

function statusWhere(
  status: PaymentHistoryFilter | null | undefined,
): Prisma.PaymentWhereInput {
  switch (status) {
    case "paid":
      return {
        paymentStatus: "SUCCEEDED",
        refunds: { none: LIVE_REFUND.some },
      };
    case "refunded":
      return { paymentStatus: "SUCCEEDED", refunds: LIVE_REFUND };
    case "failed":
      return { paymentStatus: { in: ["FAILED", "EXPIRED"] } };
    default:
      return {};
  }
}

function rangeStart(
  range: PaymentHistoryRange | null | undefined,
  now: Date,
): Date | null {
  const day = 24 * 60 * 60 * 1000;
  if (range === "30d") return new Date(now.getTime() - 30 * day);
  if (range === "90d") return new Date(now.getTime() - 90 * day);
  if (range === "year") return new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  return null;
}

/** Clamp caller-supplied paging to sane bounds; bad input falls back to page 1. */
export function normalizeHistoryQuery(query: PaymentHistoryQuery = {}) {
  const whole = (n: number | undefined, fallback: number) =>
    Number.isFinite(n) && (n as number) >= 1
      ? Math.trunc(n as number)
      : fallback;
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    whole(query.pageSize, PAYMENTS_PAGE_SIZE),
  );
  const page = whole(query.page, 1);
  const status = PAYMENT_HISTORY_FILTERS.includes(
    query.status as PaymentHistoryFilter,
  )
    ? (query.status as PaymentHistoryFilter)
    : null;
  const range = PAYMENT_HISTORY_RANGES.includes(
    query.range as PaymentHistoryRange,
  )
    ? (query.range as PaymentHistoryRange)
    : null;
  return { page, pageSize, status, range };
}

function historyWhere(
  userId: string,
  consulteeId: string,
  scope: Scope,
  query: ReturnType<typeof normalizeHistoryQuery>,
  now: Date,
): Prisma.PaymentWhereInput {
  const since = rangeStart(query.range, now);
  // The org-scope filter (#674) and the ownership bind: rows of the user who
  // owns this profile. A CHARGE_MEMBER co-pay rides on its parent's line
  // (#775), so side-charges are not listed twice; a soft-deleted row is a
  // removed row (#781 §B), as the seat-payments read already treats it.
  return {
    userId,
    user: { consulteeProfileId: consulteeId },
    parentPaymentId: null,
    deletedAt: null,
    ...scopeToWhereOrgId(scope),
    ...statusWhere(query.status),
    ...(since && { createdAt: { gte: since } }),
  };
}

/**
 * One buyer-safe payment row as the history and the payment detail page both
 * read it (#1527 — the detail page reuses it so the two cannot drift).
 */
export function paymentRowSelect(userId: string) {
  return {
    ...BUYER_PAYMENT_DISPLAY_SELECT,
    organizationId: true,
    organization: { select: { name: true } },
    discountCode: { select: DISCOUNT_CODE_SUMMARY_SELECT },
    // #775 — the CHARGE_MEMBER co-pay a sponsored member paid themselves.
    childPayments: {
      where: { deletedAt: null, userId },
      select: BUYER_PAYMENT_DISPLAY_SELECT,
    },
    appointment: {
      select: {
        id: true,
        appointmentType: true,
        // #1675 — the buyer's own support thread on this booking, when one
        // exists, is where a failed refund's "Contact support" goes.
        supportThreads: { where: { userId }, select: { id: true }, take: 1 },
        consultation: {
          select: {
            status: true,
            requestedAt: true,
            consultationPlan: planSelect,
          },
        },
        subscription: {
          select: {
            status: true,
            requestedAt: true,
            // #1766 — the frozen entitlement drives the plan-size copy.
            sessionsTotal: true,
            subscriptionPlan: {
              select: { ...planSelect.select, totalSessions: true },
            },
          },
        },
        webinar: { select: { status: true, webinarPlan: planSelect } },
        class: { select: { status: true, classPlan: planSelect } },
        trial: {
          select: {
            status: true,
            requestedAt: true,
            paymentDueAt: true,
            subscriptionPlan: {
              select: { ...planSelect.select, trialPriceInPaise: true },
            },
          },
        },
        // #1760 — the EXPIRED edge tells a lapsed pay link from an
        // unanswered request.
        statusHistory: {
          where: { toStatus: "EXPIRED" },
          select: { fromStatus: true, toStatus: true },
        },
      },
    },
  } satisfies Prisma.PaymentSelect;
}

async function findPayments(
  where: Prisma.PaymentWhereInput,
  userId: string,
  skip: number,
  take: number,
) {
  return prisma.payment.findMany({
    where,
    select: paymentRowSelect(userId),
    orderBy: { createdAt: "desc" },
    skip,
    take,
  });
}

export type PaymentRecord = Awaited<ReturnType<typeof findPayments>>[number];
type Lifecycle = NonNullable<PaymentRecord["appointment"]>;

function toPaymentInput(
  p: PaymentRecord | PaymentRecord["childPayments"][number],
): PaymentInput {
  return {
    id: p.id,
    paymentStatus: p.paymentStatus,
    paymentMethod: p.paymentMethod,
    paymentGateway: p.paymentGateway,
    receiptUrl: p.receiptUrl,
    consumerInvoice: p.consumerInvoice,
    legs: p.legs,
    refunds: p.refunds,
    amount: p.amount,
    taxAmount: p.taxAmount,
    currency: p.currency,
    createdAt: p.createdAt,
    expiresAt: p.expiresAt,
  };
}

function planRow(a: Lifecycle | null) {
  return (
    a?.consultation?.consultationPlan ??
    a?.subscription?.subscriptionPlan ??
    a?.trial?.subscriptionPlan ??
    a?.webinar?.webinarPlan ??
    a?.class?.classPlan ??
    null
  );
}

export function toRow(p: PaymentRecord): ConsulteePaymentRow {
  const a = p.appointment;
  const request = a ? lifecycleOf(a) : null;
  const plan = planRow(a);
  const consultantName =
    plan?.consultantProfile?.user?.name ?? "The consultant";
  // The pay link's own clock while one is live; else the request hold's.
  const holdExpiresAt =
    (p.paymentStatus === "PENDING" ? p.expiresAt : null) ??
    a?.trial?.paymentDueAt ??
    (request?.status === "PENDING"
      ? requestHoldDeadline(request.kind, request.requestedAt)
      : null);
  const presentation: PaymentRowInput = {
    appointmentType: a?.appointmentType ?? "CONSULTATION",
    request,
    payments: [toPaymentInput(p)],
    refunds: p.refunds,
    disputes: p.disputes,
    childPayments: p.childPayments.map(toPaymentInput),
    sponsorOrgName: isSponsoredPayment(p)
      ? (p.organization?.name ?? null)
      : null,
    holdExpiresAt,
    history: a?.statusHistory ?? [],
    plan: a ? planOf(a) : null,
    names: { payer: "you", consultant: consultantName },
  };
  return {
    id: p.id,
    amount: p.amount,
    originalAmount: p.originalAmount,
    taxAmount: p.taxAmount,
    currency: p.currency,
    status: p.paymentStatus,
    paymentMethod: p.paymentMethod,
    paymentGateway: p.paymentGateway,
    appointmentType: a?.appointmentType ?? null,
    appointmentId: a?.id ?? null,
    hasSupportThread: (a?.supportThreads.length ?? 0) > 0,
    planTitle: plan?.title ?? "Payment",
    consultantName,
    organizationId: p.organizationId,
    discount: p.discountCode
      ? {
          code: p.discountCode.code,
          type: p.discountCode.discountType,
          value: p.discountCode.discountValue,
        }
      : null,
    refunds: p.refunds,
    refundedPaise: refundedPaise(p),
    consumerInvoice: p.consumerInvoice,
    receiptUrl: p.receiptUrl,
    expiresAt: p.expiresAt,
    createdAt: p.createdAt,
    presentation,
  };
}

export async function readConsulteePayments(args: {
  consulteeId: string;
  /** The profile owner's user id, resolved by the caller's guard. */
  userId: string;
  orgScope: Scope;
  query?: PaymentHistoryQuery;
  now?: Date;
}): Promise<ConsulteePaymentsPayload> {
  const { consulteeId, userId, orgScope } = args;
  const query = normalizeHistoryQuery(args.query);
  const where = historyWhere(
    userId,
    consulteeId,
    orgScope,
    query,
    args.now ?? new Date(),
  );
  const [payments, total, credits, creditAgg, creditUsages] = await Promise.all(
    [
      findPayments(
        where,
        userId,
        (query.page - 1) * query.pageSize,
        query.pageSize,
      ),
      prisma.payment.count({ where }),
      prisma.referralCredit.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: HISTORY_CAP,
      }),
      // Balances come from the UNCAPPED table: the display list is capped and a
      // sum over it would underreport past 250 credits (PR #1247 review).
      prisma.referralCredit.aggregate({
        where: { userId },
        _sum: { amount: true, usedAmount: true, remainingAmount: true },
      }),
      prisma.referralCreditUsage.findMany({
        where: { credit: { userId } },
        include: {
          credit: { select: { source: true } },
          payment: {
            select: { id: true, amount: true, currency: true, createdAt: true },
          },
        },
        orderBy: { createdAt: "desc" },
        take: HISTORY_CAP,
      }),
    ],
  );

  // Aggregations bypass the money result extensions and return raw BigInt
  // at runtime whatever the type says, so every sum goes through Number().
  const sum = (v: bigint | number | null | undefined) => Number(v ?? 0);
  return {
    payments: payments.map(toRow),
    total,
    page: query.page,
    pageSize: query.pageSize,
    credits,
    creditUsages,
    creditSummary: {
      total: sum(creditAgg._sum.amount),
      used: sum(creditAgg._sum.usedAmount),
      remaining: sum(creditAgg._sum.remainingAmount),
    },
  };
}

/** The start of the current calendar month in India (the history's clock). */
export function istMonthStart(now: Date): Date {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  return new Date(
    Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1) - IST_OFFSET_MS,
  );
}

export interface ConsulteeMoneySummary {
  /** Net of refunds that went through; one entry per currency, never converted. */
  spentThisMonth: { currency: string; paise: number }[];
  creditBalancePaise: number;
}

/**
 * #1527 — Home's "This month" facts: what the learner spent this month and
 * the credit balance, without shipping a page of history to get two numbers.
 * Same ownership bind and personal pin as the history.
 */
export async function readConsulteeMoneySummary(args: {
  consulteeId: string;
  userId: string;
  now?: Date;
}): Promise<ConsulteeMoneySummary> {
  const { consulteeId, userId } = args;
  const since = istMonthStart(args.now ?? new Date());
  const [paid, creditAgg] = await Promise.all([
    prisma.payment.findMany({
      where: {
        userId,
        user: { consulteeProfileId: consulteeId },
        parentPaymentId: null,
        deletedAt: null,
        paymentStatus: "SUCCEEDED",
        createdAt: { gte: since },
        ...scopeToWhereOrgId({ kind: "personal" }),
      },
      select: {
        amount: true,
        currency: true,
        refunds: {
          where: { deletedAt: null, status: "SUCCEEDED" },
          select: { amountPaise: true, status: true },
        },
      },
    }),
    prisma.referralCredit.aggregate({
      where: { userId },
      _sum: { remainingAmount: true },
    }),
  ]);
  const byCurrency = new Map<string, number>();
  for (const p of paid) {
    const currency = p.currency || "INR";
    const net = Number(p.amount) - refundedPaise(p);
    byCurrency.set(currency, (byCurrency.get(currency) ?? 0) + net);
  }
  return {
    spentThisMonth: [...byCurrency.entries()].map(([currency, paise]) => ({
      currency,
      paise,
    })),
    creditBalancePaise: Number(creditAgg._sum.remainingAmount ?? 0),
  };
}

export interface ConsulteeFailedRefund {
  /** The top-level charge whose detail page tells the refund's story. */
  paymentId: string;
  amountPaise: number;
  currency: string;
}

/** A failed refund stays in "Needs you" this long, unless staff re-issue it sooner. */
const FAILED_REFUND_VISIBLE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * #1527 — recent FAILED refunds on the learner's own personal charges, for
 * the Home inbox. A FAILED row is terminal (staff re-issue a new refund by
 * hand), so one is dropped once a later refund on the same charge is live.
 */
export async function readConsulteeFailedRefunds(
  userId: string,
  now: Date = new Date(),
): Promise<ConsulteeFailedRefund[]> {
  const rows = await prisma.refund.findMany({
    where: {
      status: "FAILED",
      deletedAt: null,
      createdAt: { gte: new Date(now.getTime() - FAILED_REFUND_VISIBLE_MS) },
      payment: { userId, deletedAt: null, organizationId: null },
    },
    select: {
      amountPaise: true,
      currency: true,
      createdAt: true,
      payment: {
        select: {
          id: true,
          parentPaymentId: true,
          refunds: {
            where: {
              deletedAt: null,
              status: { in: ["SUCCEEDED", "PENDING"] },
            },
            select: { createdAt: true },
          },
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  return rows
    .filter((r) => !r.payment.refunds.some((l) => l.createdAt > r.createdAt))
    .map((r) => ({
      paymentId: r.payment.parentPaymentId ?? r.payment.id,
      amountPaise: Number(r.amountPaise),
      currency: r.currency,
    }));
}
