/**
 * Ends a rejected expert's unpaid sales after the reject commits, as Request
 * again closes an order: the gateway is asked about every open order first, the
 * cleared sales end in one transaction, and each closed order is read once more
 * so a capture that slipped in is refunded. Never throws on a gateway or notice
 * failure; what it could not settle is reported once.
 */

import { Prisma, PaymentGateway } from "@prisma/client";

import prisma from "@/lib/prisma";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { flushBackupInterestNotices } from "@/lib/booking/backup-interest";
import { stageRequestEndedNotice } from "@/lib/booking/expiry-notices";
import { closedRequestNotice } from "@/lib/booking/closed-sale-copy";
import {
  endUnpaidSalesInTx,
  isGatewayOrder,
  openSaleOrdersWhere,
  type EndedSale,
  type EndedUnpaidSales,
  type OpenOrder,
} from "@/lib/booking/unverified-expert-sales";
import type { GatewayCancel } from "@/lib/booking/pending-payment-expiry";
import { stageTrialLifecycleEmail } from "@/lib/email/senders/booking";
import { goHref } from "@/lib/dashboard/go";
import { notifyTrialCancelled } from "@/lib/novu/service";
import type { StagedTrigger } from "@/lib/novu/outbox";
import type { StagedEmailBundleEntry } from "@/lib/novu/stage-then-attempt";
import { reportSentryMessage } from "@/lib/observability/report";
import { readRazorpayOrderHolding } from "@/lib/payments/core/razorpay";
import { cancelPaymentIntent } from "@/scripts/payments/cleanup-abandoned-payments";

export interface UnverifiedExpertSalesOutcome extends Pick<
  EndedUnpaidSales,
  | "payLinksClosed"
  | "requestsDeclined"
  | "trialHoldsReleased"
  | "seatsReleased"
  | "salesKept"
> {
  /** Orders a live payment kept open; reconciliation confirms or refunds them. */
  ordersLive: number;
  /** Orders the gateway could not answer for; their sales were left open. */
  ordersUnchecked: number;
  bells: StagedTrigger[];
  emails: StagedEmailBundleEntry[];
}

interface GatewayAnswers {
  cleared: Map<string, string>;
  live: string[];
  unchecked: string[];
}

/** The abandoned-payment rule: an order closes only once its gateway holds no live payment. */
async function askGateway(orders: OpenOrder[]): Promise<GatewayAnswers> {
  const answers: GatewayAnswers = {
    cleared: new Map(),
    live: [],
    unchecked: [],
  };
  for (const order of orders) {
    if (!isGatewayOrder(order)) {
      answers.cleared.set(order.paymentId, order.paymentIntent);
      continue;
    }
    const answer = await cancelPaymentIntent(
      order.paymentIntent,
      order.paymentGateway,
    ).catch(() => "unknown" as const);
    if (answer === "no_live_payment") {
      answers.cleared.set(order.paymentId, order.paymentIntent);
    } else if (answer === "has_live_payment") {
      answers.live.push(order.paymentIntent);
    } else {
      answers.unchecked.push(order.paymentIntent);
    }
  }
  return answers;
}

/** A capture between the gateway check and the commit is refunded through the capture handler. */
async function recheckClosedOrders(orders: GatewayCancel[]): Promise<string[]> {
  const unread: string[] = [];
  for (const order of orders) {
    if (order.gateway !== PaymentGateway.RAZORPAY) continue;
    try {
      const holding = await readRazorpayOrderHolding(order.paymentIntent);
      if (holding.kind !== "captured") continue;
      // Dynamic: the capture handlers reach back into booking.
      const { handlePaymentSuccess } =
        await import("@/lib/payments/webhooks/handlers");
      await handlePaymentSuccess(
        order.paymentIntent,
        {},
        holding.amountPaise,
        holding.paymentId,
      );
    } catch {
      unread.push(order.paymentIntent);
    }
  }
  return unread;
}

async function stageLearnerNotice(
  sale: EndedSale,
  bells: StagedTrigger[],
  emails: StagedEmailBundleEntry[],
): Promise<void> {
  if (sale.kind === "trial") {
    const dashboardUrl = goHref("client", "appointments");
    const staged = await notifyTrialCancelled(
      [sale.learnerUserId],
      {
        consultantName: sale.expertName,
        consulteeName: sale.learnerName,
        planTitle: sale.planTitle,
        status: "CANCELLED",
        dateTime: sale.startsAt?.toISOString(),
        dashboardUrl,
      },
      `trial-cancelled:${sale.id}`,
      { tx: prisma },
    );
    bells.push(...staged.flatMap((b) => (b.staged ? [b.staged] : [])));
    const rows = await stageTrialLifecycleEmail(prisma, {
      trialId: sale.id,
      userIds: [sale.learnerUserId],
      kind: "TRIAL_CANCELLED",
      planTitle: sale.planTitle,
      consultantName: sale.expertName,
      consulteeName: sale.learnerName,
      startsAt: sale.startsAt ?? undefined,
      dashboardUrl,
    });
    emails.push({ rows, emailType: "TRIAL_CANCELLED" });
    return;
  }
  const staged = await stageRequestEndedNotice(
    prisma,
    {
      appointmentId: sale.appointmentId ?? sale.id,
      organizationId: sale.organizationId,
      consultantName: sale.expertName,
      consulteeName: sale.learnerName,
      planTitle: sale.planTitle,
      appointmentType: sale.appointmentType,
      startsAt: sale.startsAt,
      reason: closedRequestNotice(sale.expertName, sale.orderExisted),
    },
    { recipients: [sale.learnerUserId] },
  );
  bells.push(...staged.bells);
  emails.push({ rows: staged.emails, emailType: "APPOINTMENT_CANCELLED" });
}

export async function endUnverifiedExpertSales(args: {
  consultantProfileId: string;
  actorUserId: string;
}): Promise<UnverifiedExpertSalesOutcome> {
  const orders = await prisma.payment.findMany({
    where: openSaleOrdersWhere(args.consultantProfileId),
    select: {
      id: true,
      paymentIntent: true,
      paymentGateway: true,
      isMockPayment: true,
    },
  });
  const answers = await askGateway(
    orders.map((o) => ({ ...o, paymentId: o.id })),
  );
  const ended = await withSerializableRetry(() =>
    prisma.$transaction(
      (tx) =>
        endUnpaidSalesInTx(tx, {
          consultantProfileId: args.consultantProfileId,
          actorUserId: args.actorUserId,
          cleared: answers.cleared,
        }),
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 30_000,
      },
    ),
  );

  const unread = await recheckClosedOrders(ended.closedOrders);
  const bells: StagedTrigger[] = [];
  const emails: StagedEmailBundleEntry[] = [];
  const failedNotices: string[] = [];
  for (const holdNotices of ended.holdNotices) {
    await flushBackupInterestNotices(holdNotices).catch(() => {
      failedNotices.push("held-time");
    });
  }
  for (const sale of ended.ended) {
    await stageLearnerNotice(sale, bells, emails).catch(() => {
      failedNotices.push(sale.id);
    });
  }
  if (answers.unchecked.length + unread.length + failedNotices.length > 0) {
    reportSentryMessage(
      `REJECT_SALES_UNSETTLED: ${answers.unchecked.length} unchecked, ${unread.length} not re-read, ${failedNotices.length} notice(s) failed`,
      {
        subsystem: "moderation",
        level: "warning",
        extra: {
          consultantProfileId: args.consultantProfileId,
          uncheckedOrderIds: answers.unchecked,
          unreadOrderIds: unread,
          failedNotices,
        },
      },
    );
  }
  return {
    payLinksClosed: ended.payLinksClosed,
    requestsDeclined: ended.requestsDeclined,
    trialHoldsReleased: ended.trialHoldsReleased,
    seatsReleased: ended.seatsReleased,
    salesKept: ended.salesKept,
    ordersLive: answers.live.length,
    ordersUnchecked: answers.unchecked.length,
    bells,
    emails,
  };
}
