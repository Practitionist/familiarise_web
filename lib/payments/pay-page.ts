/**
 * #1775 P-1 — what `/checkout/pay/[paymentId]` shows.
 *
 * For Razorpay an approval or trial "pay-link" is the ORDER ID, so no surface
 * could open it. This read decides, for the payer only, whether the order can
 * be opened as-is, must be re-minted first (EXPIRED/FAILED or past its
 * window), is already paid, or is no longer payable. The re-mint reuses the
 * existing paths — `mintApprovalPaymentAfterCommit` for consultations,
 * `remintTrialPayLink` for trials — never a second writer.
 */

import {
  AppointmentStatus,
  PaymentGateway,
  PaymentStatus,
  TrialStatus,
} from "@prisma/client";

import prisma from "@/lib/prisma";
import { mintApprovalPaymentAfterCommit } from "@/lib/booking/approve-request";
import {
  PRE_MINT_INTENT_PREFIX,
  isPreMintIntent,
} from "@/lib/payments/pre-mint-intent";
import { remintTrialPayLink } from "@/lib/trials/pay-link";
import { goHref } from "@/lib/dashboard/go";
import { consumerStateCodeSchema } from "@/schemas/checkout";
import {
  isPublicExpertProfile,
  publicProfileFacts,
} from "@/lib/profiles/public-profile";

export interface PayPageOrder {
  orderId: string;
  paymentId: string;
  amount: number;
  currency: string;
  /** Mirrors Payment.paymentStatus so the sheet can refuse a stale order. */
  status: string;
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
      needsBuyerState: boolean;
      /** Pre-fills the state picker; mirrors the checkout tax context. */
      taxContext: { billingStateCode: string | null; isInternational: boolean };
    }
  | { kind: "unpayable"; doneHref: string; message: string };

/** Why an order cannot be paid, as the payer reads it; never the expert's standing. */
export const UNPAYABLE_MESSAGE =
  "This booking can no longer be paid for here. It may have been cancelled, or its payment window may have closed. You can request it again from the expert's page.";
export const EXPERT_UNAVAILABLE_MESSAGE =
  "This expert isn't taking bookings right now. No payment was taken.";

const EXPERT_FACTS = {
  select: { consultantProfile: { select: publicProfileFacts } },
} as const;

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
  buyerCountry: true,
  consumerStateCode: true,
  appointmentId: true,
  user: {
    select: {
      consulteeProfile: { select: { id: true, billingStateCode: true } },
    },
  },
  appointment: {
    select: {
      consultation: {
        select: {
          id: true,
          status: true,
          pendingPaymentUrl: true,
          consultationPlan: EXPERT_FACTS,
        },
      },
      subscription: {
        select: {
          id: true,
          status: true,
          pendingPaymentUrl: true,
          subscriptionPlan: EXPERT_FACTS,
        },
      },
      trial: {
        select: {
          id: true,
          status: true,
          paymentId: true,
          pendingPaymentUrl: true,
          paymentDueAt: true,
          subscriptionPlanId: true,
          subscriptionPlan: EXPERT_FACTS,
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

/** A domestic open order with no buyer state must collect one before it is paid (CGST Rule 46(f)). */
export function payNeedsBuyerState(row: {
  paymentStatus: PaymentStatus;
  buyerCountry: string | null;
  consumerStateCode: string | null;
}): boolean {
  return (
    row.paymentStatus === PaymentStatus.PENDING &&
    (row.buyerCountry ?? "IN") === "IN" &&
    row.consumerStateCode === null
  );
}

type PayPageRow = NonNullable<Awaited<ReturnType<typeof readPayPageRow>>>;

function readPayPageRow(paymentId: string) {
  return prisma.payment.findUnique({
    where: { id: paymentId },
    select: PAY_PAGE_SELECT,
  });
}

function detailHref(row: PayPageRow): string {
  const consulteeId = row.user.consulteeProfile?.id;
  // #1527 — a payer without a consultee profile is an edge case (defensive,
  // not the normal path); auto still resolves the viewer's own side.
  return consulteeId && row.appointmentId
    ? `/dashboard/consultee/${consulteeId}/appointments/${row.appointmentId}`
    : goHref("auto", "payments");
}

/** The unpayable answer; an expert who takes no bookings is named as such, with no way back offered. */
function unpayable(row: PayPageRow): PayPageState {
  const booking = row.appointment;
  const expert =
    booking?.consultation?.consultationPlan.consultantProfile ??
    booking?.subscription?.subscriptionPlan.consultantProfile ??
    booking?.trial?.subscriptionPlan.consultantProfile ??
    null;
  return {
    kind: "unpayable",
    doneHref: detailHref(row),
    message:
      expert && !isPublicExpertProfile(expert)
        ? EXPERT_UNAVAILABLE_MESSAGE
        : UNPAYABLE_MESSAGE,
  };
}

function isLive(row: PayPageRow, now: Date): boolean {
  return (
    row.paymentStatus === PaymentStatus.PENDING &&
    (!row.expiresAt || row.expiresAt > now) &&
    !isPreMintIntent(row.paymentIntent)
  );
}

/**
 * Re-mint a dead order through the request's own path. The stale link is
 * cleared by a CAS on the payable state first, because both mint paths treat
 * a stored link as "already live" and would hand the dead order back.
 */
async function remint(row: PayPageRow): Promise<boolean> {
  const { consultation, trial } = row.appointment ?? {};
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
  if (trial) {
    const cleared = await prisma.trial.updateMany({
      where: {
        id: trial.id,
        status: TrialStatus.AWAITING_PAYMENT,
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
      // A row whose order is not minted yet has nothing to open.
      NOT: { paymentIntent: { startsWith: PRE_MINT_INTENT_PREFIX } },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
}

function openState(row: PayPageRow): PayPageState {
  const savedState = consumerStateCodeSchema.safeParse(
    row.user.consulteeProfile?.billingStateCode,
  );
  return {
    kind: "open",
    order: {
      orderId: row.paymentIntent,
      paymentId: row.id,
      amount: row.amount,
      currency: row.currency,
      status: row.paymentStatus,
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
    needsBuyerState: payNeedsBuyerState(row),
    taxContext: {
      billingStateCode: savedState.success ? savedState.data : null,
      isInternational: (row.buyerCountry ?? "IN") !== "IN",
    },
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
      : unpayable(row);
  }
  if (isLive(row, now)) return openState(row);

  // A newer live order on the same booking wins over re-minting this one.
  const newer = await findLiveOrder(row, now);
  if (newer) return { kind: "redirect", href: `/checkout/pay/${newer.id}` };
  if (!(await remint(row))) return unpayable(row);
  const live = await findLiveOrder(row, now);
  if (!live) return unpayable(row);
  if (live.id !== row.id) {
    return { kind: "redirect", href: `/checkout/pay/${live.id}` };
  }
  const fresh = await readPayPageRow(row.id);
  return fresh && isLive(fresh, now) ? openState(fresh) : unpayable(row);
}
