/**
 * Ends a rejected expert's unpaid sales after the reject commits, as Request
 * again closes an order: the gateway is asked about every open order first, the
 * cleared sales end in one transaction with their learner notices staged, and
 * each closed order is read once more so a capture that slipped in is refunded.
 * Never throws on a gateway failure; what it could not settle is reported once.
 */

import { Prisma, PaymentGateway } from "@prisma/client";

import prisma, { type Tx } from "@/lib/prisma";
import { mapLimit } from "@/lib/db/bounded";
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
import { isPreMintIntent } from "@/lib/payments/pre-mint-intent";
import {
  isPublicExpertProfile,
  publicProfileFacts,
} from "@/lib/profiles/public-profile";
import { cancelPaymentIntent } from "@/scripts/payments/cleanup-abandoned-payments";

/** Gateway reads stop starting this long after the ending began; the rest wait for another pass. */
const GATEWAY_READ_BUDGET_MS = 15_000;
/** Gateway reads in flight at once. */
const GATEWAY_READS_IN_FLIGHT = 4;

export interface UnverifiedExpertSalesOutcome extends Pick<
  EndedUnpaidSales,
  | "payLinksClosed"
  | "requestsDeclined"
  | "trialHoldsReleased"
  | "seatsReleased"
  | "salesKept"
  | "skipped"
> {
  /** Orders a live payment kept open; reconciliation confirms or refunds them. */
  ordersLive: number;
  /** Orders the gateway could not answer for; their sales were left open. */
  ordersUnchecked: number;
  /** False while orders were left unread for time: another pass must end their sales. */
  complete: boolean;
  bells: StagedTrigger[];
  emails: StagedEmailBundleEntry[];
}

interface GatewayAnswers {
  cleared: Map<string, string>;
  live: string[];
  unchecked: string[];
  /** Never read: the time budget ran out first. */
  notRead: string[];
}

/** The abandoned-payment rule: an order closes only once its gateway holds no live payment. */
async function askGateway(
  orders: OpenOrder[],
  outOfTime: () => boolean,
): Promise<GatewayAnswers> {
  const answers: GatewayAnswers = {
    cleared: new Map(),
    live: [],
    unchecked: [],
    notRead: [],
  };
  await mapLimit(orders, GATEWAY_READS_IN_FLIGHT, async (order) => {
    if (!isGatewayOrder(order)) {
      answers.cleared.set(order.paymentId, order.paymentIntent);
      return;
    }
    if (outOfTime()) {
      answers.notRead.push(order.paymentIntent);
      return;
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
  });
  return answers;
}

/** What the re-read after the close left unsettled, by order intent. */
interface Recheck {
  /** Not read, or captured without the handler refunding it. */
  unread: string[];
  /** A payment still in flight: it may capture after the close. */
  live: string[];
}

type RecheckAnswer = "settled" | "unread" | "live";

/**
 * A capture between the gateway check and the commit is refunded through the
 * capture handler; only an empty order or a refunded capture is settled.
 */
async function recheckClosedOrders(orders: GatewayCancel[]): Promise<Recheck> {
  const real = orders.filter(
    (o) =>
      o.gateway === PaymentGateway.RAZORPAY &&
      !isPreMintIntent(o.paymentIntent),
  );
  const answers = await mapLimit(
    real,
    GATEWAY_READS_IN_FLIGHT,
    async (order): Promise<RecheckAnswer> => {
      try {
        const holding = await readRazorpayOrderHolding(order.paymentIntent);
        if (holding.kind === "empty") return "settled";
        if (holding.kind === "live") return "live";
        // Dynamic: the capture handlers reach back into booking.
        const { handlePaymentSuccess } =
          await import("@/lib/payments/webhooks/handlers");
        const outcome = await handlePaymentSuccess(
          order.paymentIntent,
          {},
          holding.amountPaise,
          holding.paymentId,
        );
        return outcome === "captured_after_release" ? "settled" : "unread";
      } catch {
        return "unread";
      }
    },
  );
  const intents = (answer: RecheckAnswer) =>
    real.filter((_, i) => answers[i] === answer).map((o) => o.paymentIntent);
  return { unread: intents("unread"), live: intents("live") };
}

/** Stages one learner's notice in the ending's transaction, so a closed sale is never left unannounced. */
async function stageLearnerNotice(
  tx: Tx,
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
      { tx },
    );
    bells.push(...staged.flatMap((b) => (b.staged ? [b.staged] : [])));
    const rows = await stageTrialLifecycleEmail(tx, {
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
    tx,
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

const skipped = (): UnverifiedExpertSalesOutcome => ({
  payLinksClosed: 0,
  requestsDeclined: 0,
  trialHoldsReleased: 0,
  seatsReleased: 0,
  salesKept: 0,
  skipped: true,
  ordersLive: 0,
  ordersUnchecked: 0,
  complete: true,
  bells: [],
  emails: [],
});

export async function endUnverifiedExpertSales(args: {
  consultantProfileId: string;
  actorUserId: string;
  /** Stops new gateway reads; defaults to a budget from now. */
  outOfTime?: () => boolean;
}): Promise<UnverifiedExpertSalesOutcome> {
  const readUntil = Date.now() + GATEWAY_READ_BUDGET_MS;
  const outOfTime = args.outOfTime ?? (() => Date.now() >= readUntil);
  const standing = await prisma.consultantProfile.findUnique({
    where: { id: args.consultantProfileId },
    select: publicProfileFacts,
  });
  if (standing && isPublicExpertProfile(standing)) return skipped();

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
    outOfTime,
  );
  const asked = new Set(orders.map((o) => o.id));
  const { ended, bells, emails } = await withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const ending = await endUnpaidSalesInTx(tx, {
          consultantProfileId: args.consultantProfileId,
          actorUserId: args.actorUserId,
          cleared: answers.cleared,
          asked,
        });
        const stagedBells: StagedTrigger[] = [];
        const stagedEmails: StagedEmailBundleEntry[] = [];
        for (const sale of ending.ended) {
          await stageLearnerNotice(tx, sale, stagedBells, stagedEmails);
        }
        return { ended: ending, bells: stagedBells, emails: stagedEmails };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 30_000,
      },
    ),
  );
  if (ended.skipped) return skipped();

  const { unread, live } = await recheckClosedOrders(ended.closedOrders);
  let heldNoticesFailed = 0;
  for (const holdNotices of ended.holdNotices) {
    await flushBackupInterestNotices(holdNotices).catch(() => {
      heldNoticesFailed++;
    });
  }
  const unsettled =
    answers.unchecked.length +
    unread.length +
    live.length +
    ended.ordersChanged.length +
    heldNoticesFailed;
  if (unsettled > 0) {
    reportSentryMessage(
      `REJECT_SALES_UNSETTLED: ${answers.unchecked.length} unchecked, ${unread.length} not re-read or not refunded, ${live.length} still live after the close, ${ended.ordersChanged.length} changed since the check, ${heldNoticesFailed} held-time notice(s) failed`,
      {
        subsystem: "moderation",
        level: "warning",
        extra: {
          consultantProfileId: args.consultantProfileId,
          uncheckedOrderIds: answers.unchecked,
          unreadOrderIds: unread,
          liveOrderIds: live,
          changedPaymentIds: ended.ordersChanged,
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
    skipped: false,
    ordersLive: answers.live.length,
    ordersUnchecked: answers.unchecked.length,
    complete: answers.notRead.length === 0,
    bells,
    emails,
  };
}
