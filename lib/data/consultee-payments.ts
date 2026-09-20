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
 * consultee, the page runs `requirePersonalProfileAccess`. Cursor pagination
 * is post-MVP (#1675); the list is capped at the 250 newest rows.
 */

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

const HISTORY_CAP = 250;

async function findPayments(userId: string, consulteeId: string, scope: Scope) {
  return prisma.payment.findMany({
    // The org-scope filter (#674) and the ownership bind: rows of the user who
    // owns this profile. A CHARGE_MEMBER co-pay rides on its parent's line
    // (#775), so side-charges are not listed twice; a soft-deleted row is a
    // removed row (#781 §B), as the seat-payments read already treats it.
    where: {
      userId,
      user: { consulteeProfileId: consulteeId },
      parentPaymentId: null,
      deletedAt: null,
      ...scopeToWhereOrgId(scope),
    },
    select: {
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
    },
    orderBy: { createdAt: "desc" },
    take: HISTORY_CAP,
  });
}

type PaymentRecord = Awaited<ReturnType<typeof findPayments>>[number];
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

function toRow(p: PaymentRecord): ConsulteePaymentRow {
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
}): Promise<ConsulteePaymentsPayload> {
  const { consulteeId, userId, orgScope } = args;
  const [payments, credits, creditAgg, creditUsages] = await Promise.all([
    findPayments(userId, consulteeId, orgScope),
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
  ]);

  // Aggregations bypass the money result extensions and return raw BigInt
  // at runtime whatever the type says, so every sum goes through Number().
  const sum = (v: bigint | number | null | undefined) => Number(v ?? 0);
  return {
    payments: payments.map(toRow),
    credits,
    creditUsages,
    creditSummary: {
      total: sum(creditAgg._sum.amount),
      used: sum(creditAgg._sum.usedAmount),
      remaining: sum(creditAgg._sum.remainingAmount),
    },
  };
}
