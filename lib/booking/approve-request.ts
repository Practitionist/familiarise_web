import * as Sentry from "@sentry/nextjs";
import {
  AppointmentStatus,
  PaymentGateway,
  PaymentStatus,
  type Prisma,
} from "@prisma/client";
import { addMonths } from "date-fns";
import prisma from "@/lib/prisma";
import { APPROVAL_PAYMENT_EXPIRATION_MS } from "@/lib/payments/constants";

/**
 * #1775 B-9 — approving a REQUEST-mode booking is one decision with two
 * landings: a request whose wrapper already carries a SUCCEEDED payment (or
 * a free plan) lands in APPROVED; one that does not lands in
 * APPROVED_PENDING_PAYMENT and mints the pay order AFTER the commit. Every
 * writer that approves (the detail PATCH routes, the allocate handler behind
 * "Use requested times" and the allocate page) reads these predicates and
 * calls `mintApprovalPaymentAfterCommit`, so no approval can ever confirm a
 * booking nobody paid for.
 *
 * The predicates ride in the CAS WHERE (doctrine rule 1), never in a read
 * ahead of it. `SETTLED_*` and `UNPAID_*` are the two arms of one decision;
 * the sweeps' lapse core reuses the `UNPAID_*` arm. Top-level imports stay
 * light on purpose: the scheduling engine imports this module.
 */
export const SETTLED_CONSULTATION: Prisma.ConsultationWhereInput = {
  OR: [
    {
      appointment: {
        payment: {
          some: { paymentStatus: PaymentStatus.SUCCEEDED, deletedAt: null },
        },
      },
    },
    { consultationPlan: { price: 0 } },
  ],
};
export const UNPAID_CONSULTATION = {
  appointment: {
    payment: { none: { paymentStatus: PaymentStatus.SUCCEEDED } },
  },
} as const;
export const SETTLED_SUBSCRIPTION: Prisma.SubscriptionWhereInput = {
  OR: [
    {
      appointment: {
        payment: {
          some: { paymentStatus: PaymentStatus.SUCCEEDED, deletedAt: null },
        },
      },
    },
    { subscriptionPlan: { price: 0 } },
  ],
};
// #1554 — a subscription may have no wrapper yet; then nothing is paid.
export const UNPAID_SUBSCRIPTION: { OR: Prisma.SubscriptionWhereInput[] } = {
  OR: [
    { appointment: null },
    {
      appointment: {
        payment: { none: { paymentStatus: PaymentStatus.SUCCEEDED } },
      },
    },
  ],
};

export type ApprovalOutcome = "approved" | "awaiting_payment";

export type MintApprovalOutcome =
  | {
      status: "minted";
      paymentUrl: string;
      paymentAmount: number;
      paymentCurrency: string;
    }
  /** The row already carries a live link: nothing minted, nothing mailed. */
  | { status: "already_live"; paymentUrl: string }
  /** The persist lost (lapsed, paid, or a sibling won) and no link is live. */
  | { status: "not_delivered" }
  /** The request behind a dead intent is gone (ApprovalWindowLapsedError). */
  | { status: "lapsed"; message: string }
  /** The gateway mint threw; the caller decides between 502 and a system error. */
  | { status: "mint_failed"; error: unknown };

const MINT_PARTY_SELECT = {
  requestedBy: {
    select: { user: { select: { id: true, name: true, email: true } } },
  },
  appointment: {
    select: {
      id: true,
      organizationId: true,
      occurrences: {
        where: { deletedAt: null },
        orderBy: { startsAt: "asc" as const },
        take: 1,
        select: { startsAt: true, endsAt: true },
      },
    },
  },
} as const;
const MINT_PLAN_SELECT = {
  select: {
    id: true,
    consultantProfile: { select: { user: { select: { name: true } } } },
  },
} as const;

async function readForMint(kind: "consultation" | "subscription", id: string) {
  if (kind === "consultation") {
    return prisma.consultation.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        pendingPaymentUrl: true,
        requestNotes: true,
        consultationPlan: MINT_PLAN_SELECT,
        ...MINT_PARTY_SELECT,
      },
    });
  }
  return prisma.subscription.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      pendingPaymentUrl: true,
      requestNotes: true,
      schedulingPeriodStartsAt: true,
      schedulingPeriodEndsAt: true,
      subscriptionPlan: {
        select: { ...MINT_PLAN_SELECT.select, durationInMonths: true },
      },
      ...MINT_PARTY_SELECT,
    },
  });
}

function report(error: unknown): void {
  Sentry.captureException(
    error instanceof Error ? error : new Error(String(error)),
    { tags: { subsystem: "bookings" } },
  );
}

/**
 * The detail PATCH's post-commit block, shared: mint under the mint lock
 * (`createApprovalPaymentIntent` reuses a live PENDING row, so a retry or a
 * re-allocation never mints a parallel order), CAS the link onto the row,
 * tombstone an orphaned order, and mail only a link that is live on the row
 * (#1583 A-P0-06). Never throws; every failure is an outcome. A row that is
 * no longer awaiting payment, or already carries a link, mints nothing.
 */
export async function mintApprovalPaymentAfterCommit(args: {
  kind: "consultation" | "subscription";
  id: string;
}): Promise<MintApprovalOutcome> {
  const row = await readForMint(args.kind, args.id);
  if (!row || row.status !== AppointmentStatus.APPROVED_PENDING_PAYMENT) {
    return { status: "not_delivered" };
  }
  if (row.pendingPaymentUrl) {
    return { status: "already_live", paymentUrl: row.pendingPaymentUrl };
  }

  // Loaded here, not at module scope: the payments barrel and the email
  // senders are heavy, and the scheduling engine imports this module.
  const [{ ApprovalWindowLapsedError, createApprovalPaymentIntent }, email] =
    await Promise.all([
      import("@/lib/payments/operations/approval-payment"),
      import("@/lib/email"),
    ]);
  const { reconcileOrphanedPayLink } =
    await import("@/lib/booking/pay-link-persist");

  const slot = row.appointment?.occurrences[0];
  const now = new Date();
  // The kind-specific half of the mint params: the consultation's held slot
  // times, or the subscription's scheduling period (already committed by the
  // approval; recomputing it would drift the gateway metadata off the row).
  const { plan, timing } =
    "consultationPlan" in row
      ? {
          plan: row.consultationPlan,
          timing: {
            consultationId: row.id,
            startsAt: slot?.startsAt.toISOString(),
            endsAt: slot?.endsAt?.toISOString(),
          },
        }
      : {
          plan: row.subscriptionPlan,
          timing: {
            subscriptionId: row.id,
            schedulingPeriodStartsAt: (
              row.schedulingPeriodStartsAt ?? now
            ).toISOString(),
            schedulingPeriodEndsAt: (
              row.schedulingPeriodEndsAt ??
              addMonths(now, row.subscriptionPlan.durationInMonths || 1)
            ).toISOString(),
          },
        };
  let paymentResult;
  try {
    paymentResult = await createApprovalPaymentIntent({
      userId: row.requestedBy.user.id,
      appointmentType:
        args.kind === "consultation" ? "CONSULTATION" : "SUBSCRIPTION",
      // #1181 / #1554 — the request-time appointment (or the purchase
      // wrapper): capture confirms THAT row and the duplicate guard sees it.
      appointmentId: row.appointment?.id ?? undefined,
      planId: plan.id,
      // #1165 — settlement is INR-only; Razorpay is the KYC'd primary gateway.
      paymentGateway: PaymentGateway.RAZORPAY,
      // #1166 ORG-9 — org sponsorship survives the approval flow.
      organizationId: row.appointment?.organizationId ?? undefined,
      ...timing,
      notes: row.requestNotes ?? undefined,
    });
  } catch (linkError) {
    // #1319 review — a lapsed approval is not a retryable mint failure.
    if (linkError instanceof ApprovalWindowLapsedError) {
      return { status: "lapsed", message: linkError.message };
    }
    report(linkError);
    return { status: "mint_failed", error: linkError };
  }

  let paymentUrl: string | null = paymentResult.checkoutUrl;
  try {
    // #1583 A-P0-06 — a CAS on the exact shape the link belongs to: a mint
    // landing after the lapse sweep EXPIRED the request must not re-arm a
    // link; zero rows is reconciled, never thrown.
    const persist = {
      where: {
        id: row.id,
        status: AppointmentStatus.APPROVED_PENDING_PAYMENT,
        pendingPaymentUrl: null,
      },
      data: {
        pendingPaymentUrl: paymentResult.checkoutUrl,
        requestNotes: row.requestNotes
          ? `${row.requestNotes}\n\n[System] Payment link generated and sent to user.`
          : `[System] Payment link generated and sent to user.`,
      },
    };
    const persisted =
      args.kind === "consultation"
        ? await prisma.consultation.updateMany(persist)
        : await prisma.subscription.updateMany(persist);
    if (persisted.count === 0) {
      // The request moved since the mint (lapsed, paid, or a sibling
      // persisted first): the orphaned order is tombstoned and only a link
      // still live on the row may reach the consultee.
      const outcome = await reconcileOrphanedPayLink({
        kind: args.kind,
        id: row.id,
        paymentIntentId: paymentResult.paymentIntentId,
        checkoutUrl: paymentResult.checkoutUrl,
      });
      paymentUrl = outcome.url;
    }
  } catch (persistError) {
    // The row's state is unproven, so the link is not delivered; the next
    // approval reuses the same PENDING intent (#1181).
    paymentUrl = null;
    console.error(
      `⚠️ Failed to persist payment link for ${args.kind} ${row.id}:`,
      persistError instanceof Error ? persistError.message : "Unknown error",
    );
    report(persistError);
  }
  if (!paymentUrl) return { status: "not_delivered" };

  try {
    await email.sendPaymentLinkEmail({
      email: row.requestedBy.user.email || "",
      name: row.requestedBy.user.name || "User",
      consultantName: plan.consultantProfile.user.name || "Consultant",
      appointmentType: args.kind,
      amount: paymentResult.amount,
      currency: paymentResult.currency,
      paymentUrl,
      expiresAt: new Date(Date.now() + APPROVAL_PAYMENT_EXPIRATION_MS),
    });
    console.log(`📧 Payment link email sent for ${args.kind} ${row.id}`);
  } catch (emailError) {
    // The link is live on the dashboard via pendingPaymentUrl; mail is best-effort.
    console.error(
      `⚠️ Failed to send payment link email for ${args.kind} ${row.id}:`,
      emailError instanceof Error ? emailError.message : "Unknown error",
    );
    report(emailError);
  }
  return {
    status: "minted",
    paymentUrl,
    paymentAmount: paymentResult.amount,
    paymentCurrency: paymentResult.currency,
  };
}
