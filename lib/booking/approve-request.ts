import * as Sentry from "@sentry/nextjs";
import {
  AppointmentStatus,
  PaymentGateway,
  PaymentStatus,
  type Prisma,
} from "@prisma/client";
import prisma from "@/lib/prisma";

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
    // Free at the price frozen at request; a pre-freeze row reads the plan.
    { pricePaise: 0 },
    { pricePaise: null, consultationPlan: { price: 0 } },
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
      /** When the link stops being payable; never later than the first session allows. */
      payExpiresAt: Date;
    }
  /** The row already carries a live link: nothing minted, nothing mailed. */
  | { status: "already_live"; paymentUrl: string }
  /** The persist lost (lapsed, paid, or a sibling won) and no link is live. */
  | { status: "not_delivered" }
  /** The request behind a dead intent is gone (ApprovalWindowLapsedError). */
  | { status: "lapsed"; message: string }
  /** The gateway mint threw; the caller decides between 502 and a system error. */
  | { status: "mint_failed"; error: unknown };

/**
 * #1780 R-4 — a mint failure that is a state answer, not a fault: another
 * action minted the order first (PAYMENT_ALREADY_EXISTS) or the request is
 * already paid (ALREADY_PAID). Read by code so this light module never loads
 * the payments barrel. Null means a real fault (502).
 */
export function approvalMintConflict(
  error: unknown,
): { code: string; message: string } | null {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "PAYMENT_ALREADY_EXISTS" || code === "ALREADY_PAID") {
    return { code, message: (error as Error).message };
  }
  return null;
}

const MINT_PARTY_SELECT = {
  requestedBy: {
    select: { user: { select: { id: true, name: true, email: true } } },
  },
  appointment: {
    select: {
      id: true,
      organizationId: true,
      organization: { select: { name: true } },
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
    title: true,
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
 * #1775 — the link onto the row, or null when it is not deliverable.
 * #1583 A-P0-06 — a CAS on the exact shape the link belongs to: a mint
 * landing after the lapse sweep EXPIRED the request must not re-arm a link;
 * zero rows is reconciled (the orphaned order tombstoned, only a link still
 * live on the row may reach the consultee), never thrown. A persist that
 * throws leaves the row's state unproven, so the link is not delivered and
 * the next approval reuses the same PENDING intent (#1181).
 */
async function persistPayLink(
  kind: "consultation" | "subscription",
  id: string,
  requestNotes: string | null,
  paymentResult: { paymentIntentId: string; checkoutUrl: string },
  reconcile: (typeof import("@/lib/booking/pay-link-persist"))["reconcileOrphanedPayLink"],
): Promise<string | null> {
  try {
    const persist = {
      where: {
        id,
        status: AppointmentStatus.APPROVED_PENDING_PAYMENT,
        pendingPaymentUrl: null,
      },
      data: {
        pendingPaymentUrl: paymentResult.checkoutUrl,
        requestNotes: requestNotes
          ? `${requestNotes}\n\n[System] Payment link generated and sent to user.`
          : `[System] Payment link generated and sent to user.`,
      },
    };
    const persisted =
      kind === "consultation"
        ? await prisma.consultation.updateMany(persist)
        : await prisma.subscription.updateMany(persist);
    if (persisted.count > 0) return paymentResult.checkoutUrl;
    const outcome = await reconcile({
      kind,
      id,
      paymentIntentId: paymentResult.paymentIntentId,
      checkoutUrl: paymentResult.checkoutUrl,
    });
    return outcome.url;
  } catch (persistError) {
    console.error(
      `⚠️ Failed to persist payment link for ${kind} ${id}:`,
      persistError instanceof Error ? persistError.message : "Unknown error",
    );
    report(persistError);
    return null;
  }
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
  const [
    {
      ApprovalTooCloseToStartError,
      ApprovalWindowLapsedError,
      createApprovalPaymentIntent,
    },
    email,
    { notifyPaymentLink, notificationScope },
  ] = await Promise.all([
    import("@/lib/payments/operations/approval-payment"),
    import("@/lib/email"),
    import("@/lib/novu"),
  ]);
  const { reconcileOrphanedPayLink } =
    await import("@/lib/booking/pay-link-persist");

  const slot = row.appointment?.occurrences[0];
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
            schedulingPeriodStartsAt:
              row.schedulingPeriodStartsAt.toISOString(),
            schedulingPeriodEndsAt: row.schedulingPeriodEndsAt.toISOString(),
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
    // The pay window can no longer open: release the approval rather than
    // leave it awaiting a payment nobody can make.
    if (linkError instanceof ApprovalTooCloseToStartError) {
      const { lapseTooCloseApproval, TOO_CLOSE_TO_PAY_REASON } =
        await import("@/lib/booking/lapse-approved-request");
      await lapseTooCloseApproval({
        kind: args.kind,
        id: row.id,
        consulteeUserId: row.requestedBy.user.id,
        consulteeName: row.requestedBy.user.name,
        consultantName: plan.consultantProfile.user.name,
        planTitle: plan.title,
        organizationId: row.appointment?.organizationId ?? null,
        startsAt: slot?.startsAt ?? null,
      });
      return { status: "lapsed", message: TOO_CLOSE_TO_PAY_REASON };
    }
    report(linkError);
    return { status: "mint_failed", error: linkError };
  }

  const paymentUrl = await persistPayLink(
    args.kind,
    row.id,
    row.requestNotes,
    paymentResult,
    reconcileOrphanedPayLink,
  );
  if (!paymentUrl) return { status: "not_delivered" };

  const { expiresAt } = paymentResult;
  const consultantName = plan.consultantProfile.user.name || "Consultant";
  await Promise.all([
    notifyPaymentLink(
      row.requestedBy.user.id,
      {
        ...notificationScope(
          row.appointment?.organizationId,
          row.appointment?.organization?.name,
        ),
        paymentId: paymentResult.paymentId,
        appointmentId: row.appointment?.id ?? row.id,
        amount: paymentResult.amount,
        currency: paymentResult.currency,
        consultantName,
        appointmentType:
          args.kind === "consultation" ? "CONSULTATION" : "SUBSCRIPTION",
        planTitle: plan.title,
        paymentUrl: email.emailPayUrl(paymentResult.paymentId, paymentUrl),
        expiresAt,
        reminder: false,
      },
      `payment-link:${paymentResult.paymentId}`,
    ).catch((bellError) => {
      console.error(
        `⚠️ Failed to send payment link bell for ${args.kind} ${row.id}:`,
        bellError instanceof Error ? bellError.message : "Unknown error",
      );
      return null;
    }),
    email
      .sendPaymentLinkEmail({
        email: row.requestedBy.user.email || "",
        name: row.requestedBy.user.name || "User",
        consultantName,
        appointmentType: args.kind,
        amount: paymentResult.amount,
        currency: paymentResult.currency,
        paymentUrl,
        expiresAt,
        paymentId: paymentResult.paymentId,
      })
      .then(() => {
        console.log(`📧 Payment link email sent for ${args.kind} ${row.id}`);
      })
      .catch((emailError) => {
        // The link is live on the dashboard via pendingPaymentUrl; mail is best-effort.
        console.error(
          `⚠️ Failed to send payment link email for ${args.kind} ${row.id}:`,
          emailError instanceof Error ? emailError.message : "Unknown error",
        );
        report(emailError);
      }),
  ]);
  return {
    status: "minted",
    paymentUrl,
    paymentAmount: paymentResult.amount,
    paymentCurrency: paymentResult.currency,
    payExpiresAt: expiresAt,
  };
}
