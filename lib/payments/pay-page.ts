/**
 * #1775 P-1 — what `/checkout/pay/[paymentId]` shows.
 *
 * For Razorpay an approval or trial "pay-link" is the ORDER ID, so no surface
 * could open it. This read decides, for the payer only, whether the order can
 * be opened as-is, must be re-minted first (EXPIRED/FAILED or past its
 * window), is already paid, or is no longer payable. The re-mint reuses the
 * existing paths — `mintApprovalPaymentAfterCommit` for consultations and
 * subscriptions, `remintTrialPayLink` for trials — never a second writer.
 */

import {
  AppointmentStatus,
  PaymentGateway,
  PaymentStatus,
  TrialStatus,
} from "@prisma/client";

import prisma from "@/lib/prisma";
import { mintApprovalPaymentAfterCommit } from "@/lib/booking/approve-request";
import { remintTrialPayLink } from "@/lib/trials/pay-link";

export interface PayPageOrder {
  orderId: string;
  paymentId: string;
  amount: number;
  currency: string;
}

export interface PayPageSummary {
  amount: number;
  taxAmount: number;
  originalAmount: number;
  currency: string;
  description: string | null;
  expiresAt: Date | null;
}

export type PayPageState =
  | { kind: "not_found" }
  | { kind: "paid"; href: string }
  | { kind: "redirect"; href: string }
  | {
      kind: "open";
      order: PayPageOrder;
      summary: PayPageSummary;
      doneHref: string;
    }
  | { kind: "unpayable"; doneHref: string };

const PAY_PAGE_SELECT = {
  id: true,
  userId: true,
  deletedAt: true,
  paymentStatus: true,
  paymentGateway: true,
  paymentIntent: true,
  amount: true,
  originalAmount: true,
  taxAmount: true,
  currency: true,
  description: true,
  expiresAt: true,
  appointmentId: true,
  user: { select: { consulteeProfile: { select: { id: true } } } },
  appointment: {
    select: {
      consultation: {
        select: { id: true, status: true, pendingPaymentUrl: true },
      },
      subscription: {
        select: { id: true, status: true, pendingPaymentUrl: true },
      },
      trial: {
        select: {
          id: true,
          status: true,
          paymentId: true,
          pendingPaymentUrl: true,
          paymentDueAt: true,
          subscriptionPlanId: true,
          consulteeProfile: { select: { userId: true } },
          appointment: {
            select: {
              id: true,
              occurrences: {
                where: { deletedAt: null },
                orderBy: { startsAt: "asc" as const },
                take: 1,
                select: { startsAt: true, endsAt: true },
              },
            },
          },
        },
      },
    },
  },
} as const;

type PayPageRow = NonNullable<Awaited<ReturnType<typeof readPayPageRow>>>;

function readPayPageRow(paymentId: string) {
  return prisma.payment.findUnique({
    where: { id: paymentId },
    select: PAY_PAGE_SELECT,
  });
}

function detailHref(row: PayPageRow): string {
  const consulteeId = row.user.consulteeProfile?.id;
  return consulteeId && row.appointmentId
    ? `/dashboard/consultee/${consulteeId}/appointments/${row.appointmentId}`
    : "/dashboard";
}

function isLive(row: PayPageRow, now: Date): boolean {
  return (
    row.paymentStatus === PaymentStatus.PENDING &&
    (!row.expiresAt || row.expiresAt > now)
  );
}

/**
 * Re-mint a dead order through the request's own path. The stale link is
 * cleared by a CAS on the payable state first, because both mint paths treat
 * a stored link as "already live" and would hand the dead order back.
 */
async function remint(row: PayPageRow): Promise<boolean> {
  const { consultation, subscription, trial } = row.appointment ?? {};
  const payable = {
    status: AppointmentStatus.APPROVED_PENDING_PAYMENT,
  } as const;
  if (consultation) {
    await prisma.consultation.updateMany({
      where: { id: consultation.id, ...payable },
      data: { pendingPaymentUrl: null },
    });
    const out = await mintApprovalPaymentAfterCommit({
      kind: "consultation",
      id: consultation.id,
    });
    return out.status === "minted" || out.status === "already_live";
  }
  if (subscription) {
    await prisma.subscription.updateMany({
      where: { id: subscription.id, ...payable },
      data: { pendingPaymentUrl: null },
    });
    const out = await mintApprovalPaymentAfterCommit({
      kind: "subscription",
      id: subscription.id,
    });
    return out.status === "minted" || out.status === "already_live";
  }
  if (trial) {
    const cleared = await prisma.trial.updateMany({
      where: {
        id: trial.id,
        status: { in: [TrialStatus.AWAITING_PAYMENT, TrialStatus.PENDING] },
        paymentId: null,
      },
      data: { pendingPaymentUrl: null },
    });
    if (cleared.count !== 1) return false;
    const link = await remintTrialPayLink({
      ...trial,
      pendingPaymentUrl: null,
    });
    return link !== null;
  }
  return false;
}

/** The payer's newest live order on the same appointment, after a re-mint. */
async function findLiveOrder(row: PayPageRow, now: Date) {
  if (!row.appointmentId) return null;
  return prisma.payment.findFirst({
    where: {
      appointmentId: row.appointmentId,
      userId: row.userId,
      deletedAt: null,
      paymentStatus: PaymentStatus.PENDING,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
}

function openState(row: PayPageRow): PayPageState {
  return {
    kind: "open",
    order: {
      orderId: row.paymentIntent,
      paymentId: row.id,
      amount: row.amount,
      currency: row.currency,
    },
    summary: {
      amount: row.amount,
      taxAmount: row.taxAmount,
      originalAmount: row.originalAmount,
      currency: row.currency,
      description: row.description,
      expiresAt: row.expiresAt,
    },
    doneHref: detailHref(row),
  };
}

export async function resolvePayPage(
  paymentId: string,
  viewerUserId: string,
  now = new Date(),
): Promise<PayPageState> {
  const row = await readPayPageRow(paymentId);
  // 404, not 403: a payment id must not become an existence oracle.
  if (!row || row.deletedAt || row.userId !== viewerUserId) {
    return { kind: "not_found" };
  }
  if (row.paymentStatus === PaymentStatus.SUCCEEDED) {
    return { kind: "paid", href: detailHref(row) };
  }
  if (row.paymentGateway !== PaymentGateway.RAZORPAY) {
    // Another rail keeps its hosted link, exactly as before this page existed.
    const hosted =
      row.appointment?.consultation?.pendingPaymentUrl ??
      row.appointment?.subscription?.pendingPaymentUrl;
    return hosted && /^https?:\/\//.test(hosted)
      ? { kind: "redirect", href: hosted }
      : { kind: "unpayable", doneHref: detailHref(row) };
  }
  if (isLive(row, now)) return openState(row);

  // A newer live order on the same booking wins over re-minting this one.
  const newer = await findLiveOrder(row, now);
  if (newer) return { kind: "redirect", href: `/checkout/pay/${newer.id}` };
  if (!(await remint(row))) {
    return { kind: "unpayable", doneHref: detailHref(row) };
  }
  const live = await findLiveOrder(row, now);
  if (!live) return { kind: "unpayable", doneHref: detailHref(row) };
  if (live.id !== row.id) {
    return { kind: "redirect", href: `/checkout/pay/${live.id}` };
  }
  const fresh = await readPayPageRow(row.id);
  return fresh && isLive(fresh, now)
    ? openState(fresh)
    : { kind: "unpayable", doneHref: detailHref(row) };
}
