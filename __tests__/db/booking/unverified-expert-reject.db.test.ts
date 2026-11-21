/**
 * A moderation reject stops new sales and honours what is booked, on real
 * Postgres: once the reject commits, the gateway is asked about every open
 * order, and the expert's unpaid approved link expires, their unanswered unpaid
 * request is declined, their unpaid trial hold and group seats are released,
 * each order expired and its checkout's spend returned; paid bookings stay. A
 * live payment keeps its sale open, a capture after the close is refunded, and
 * an unpaid request can no longer be approved for an unverified expert.
 */
import { randomUUID } from "node:crypto";
import prisma from "../../../lib/prisma";
import {
  futureAt,
  HOUR_MS,
  seedConsultee,
  seedHost,
  seedOneToOne,
  type SeededHost,
} from "./harness";
import {
  halfHourStarts,
  publishEveryHour,
  seedPaidTrialHold,
  seedRequest,
} from "./harness-host";
import {
  consumedBy,
  RETURNED,
  seedCheckoutConsumption,
} from "./harness-consumed";

jest.mock("../../../lib/payments/index", () =>
  jest.requireActual("./harness-edges").gatewayMock(),
);
jest.mock("../../../lib/novu", () =>
  jest.requireActual("../../fixtures/noop-module").noopModule(),
);
jest.mock("../../../lib/email", () =>
  jest.requireActual("../../fixtures/noop-module").noopModule(),
);
jest.mock("../../../lib/email/render", () => ({
  __esModule: true,
  renderEmail: async () => ({ html: "<p>rendered</p>", text: "rendered" }),
}));
jest.mock("../../../lib/compliance/dpdp", () => ({
  __esModule: true,
  checkConsent: jest.fn(async () => true),
}));
jest.mock("../../../lib/stream/access-revocation", () =>
  jest.requireActual("./harness-edges").chatRevocationMock(),
);
jest.mock("../../../lib/rate-limit", () =>
  jest.requireActual("./harness-edges").rateLimitMock(),
);
const mockGateway = {
  cancelRazorpayOrder: jest.fn(
    async (_orderId: string): Promise<string> => "no_live_payment",
  ),
  readRazorpayOrderHolding: jest.fn(
    async (_orderId: string): Promise<unknown> => ({
      kind: "empty",
      onlyFailed: false,
    }),
  ),
};
jest.mock("../../../lib/payments/core/razorpay", () => ({
  ...jest.requireActual("../../../lib/payments/core/razorpay"),
  cancelRazorpayOrder: (orderId: string) =>
    mockGateway.cancelRazorpayOrder(orderId),
  readRazorpayOrderHolding: (orderId: string) =>
    mockGateway.readRazorpayOrderHolding(orderId),
}));
// The sweep's mutual exclusion is a lease the database tier need not hold.
jest.mock("../../../lib/cron/with-cron-lock", () => ({
  ...jest.requireActual("../../../lib/cron/with-cron-lock"),
  withCronLock: (_job: string, _opts: unknown, fn: () => unknown) => fn(),
}));
/** Overrides the capture handler's answer for one case; null delegates to the real one. */
const mockCapture = { answer: null as null | (() => Promise<unknown>) };
jest.mock("../../../lib/payments/webhooks/handlers", () => {
  const actual = jest.requireActual("../../../lib/payments/webhooks/handlers");
  return {
    ...actual,
    handlePaymentSuccess: (...args: unknown[]) =>
      mockCapture.answer
        ? mockCapture.answer()
        : actual.handlePaymentSuccess(...args),
  };
});
/** Makes the learner notice's staging throw, as a failed outbox write would. */
const mockStaging = { fail: false };
jest.mock("../../../lib/booking/expiry-notices", () => {
  const actual = jest.requireActual("../../../lib/booking/expiry-notices");
  return {
    ...actual,
    stageRequestEndedNotice: (...args: unknown[]) => {
      if (mockStaging.fail) throw new Error("outbox write failed");
      return actual.stageRequestEndedNotice(...args);
    },
  };
});
const mockReport = { message: jest.fn() };
jest.mock("../../../lib/observability/report", () => {
  const actual = jest.requireActual("../../../lib/observability/report");
  return {
    ...actual,
    reportSentryMessage: (...args: unknown[]) => {
      mockReport.message(...args);
      return actual.reportSentryMessage(...args);
    },
  };
});

import {
  applyBestEffortEffects,
  applyTransactionalEffects,
} from "../../../lib/moderation/side-effects";
import { handlePaymentSuccess } from "../../../lib/payments/webhooks/handlers";
import { resolvePayPage } from "../../../lib/payments/pay-page";
import { allocate } from "../../../lib/booking/allocation";
import { refundDoor } from "./harness-edges";
import { seedHeldSeat, seedWebinar } from "./harness-seats";
import { retryModerationEnforcement } from "../../../scripts/cleanup/retry-moderation-enforcement";
import { endUnverifiedExpertSales } from "../../../lib/booking/unverified-expert-notices";
import { endUnpaidSalesInTx } from "../../../lib/booking/unverified-expert-sales";

const PRICE_PAISE = 80_000;
/** The learner's notice: neutral, the expert named, no reason given; no charge promised once an order existed. */
const CLOSED_NO_ORDER =
  "Database tier consultant isn't taking bookings right now, so your request was closed. No payment was taken.";
const CLOSED_AFTER_ORDER =
  "Database tier consultant isn't taking bookings right now, so your request was closed. If you were charged, the money is refunded automatically.";
const PAY_PAGE_AFTER_ORDER =
  "This expert isn't taking bookings right now. If you were charged, the money is refunded automatically.";

/** The bells staged for one learner, as their outbox rows hold them. */
async function bellPayloads(userId: string): Promise<string> {
  const rows = await prisma.notificationOutbox.findMany({
    where: { recipients: { has: userId } },
    select: { payload: true },
  });
  return JSON.stringify(rows.map((r) => r.payload));
}

function rejectInput(host: SeededHost, staffUserId: string) {
  return {
    actionType: "PROFILE_UNVERIFIED" as const,
    report: {
      id: randomUUID(),
      type: "PROFILE" as const,
      targetUserId: host.userId,
      reviewId: null,
    },
    staffUserId,
  };
}

/** The reject, as the action route runs it: the transaction, then phase 2. */
async function reject(host: SeededHost) {
  const staff = await seedConsultee();
  const input = rejectInput(host, staff.userId);
  const transactional = await prisma.$transaction(
    (tx) => applyTransactionalEffects(tx, input),
    { timeout: 30_000 },
  );
  const summary = await applyBestEffortEffects(input, transactional);
  return { transactional, summary };
}

/** An approved request whose pay link is still open, its checkout having spent credit, a code and an engagement. */
async function liveLink(host: SeededHost) {
  const consultee = await seedConsultee();
  const startsAt = futureAt(4, 10);
  const request = await seedOneToOne(
    "consultation",
    host,
    consultee,
    { startsAt, endsAt: new Date(startsAt.getTime() + HOUR_MS) },
    {
      status: "APPROVED_PENDING_PAYMENT",
      bookingSource: "REQUEST_SUBMITTED",
      isTentative: true,
      payment: {
        status: "PENDING",
        amount: PRICE_PAISE,
        expiresAt: new Date(Date.now() + 6 * HOUR_MS),
      },
    },
  );
  // A real gateway order, so the reject owes it a cancel after commit.
  await prisma.payment.update({
    where: { id: request.payment!.id },
    data: { isMockPayment: false },
  });
  const consumption = await seedCheckoutConsumption(
    consultee.userId,
    request.payment!.id,
    PRICE_PAISE,
  );
  return { consultee, request, consumption };
}

async function unpaidTrialHold(host: SeededHost) {
  await publishEveryHour(host);
  const plan = await prisma.subscriptionPlan.create({
    data: {
      title: "Trial plan",
      price: BigInt(400_000),
      consultantProfileId: host.consultantProfileId,
      trialEnabled: true,
      trialDurationMinutes: 30,
      trialPriceInPaise: BigInt(20_000),
    },
  });
  const { trial, payment } = await seedPaidTrialHold(
    host,
    plan.id,
    new Date(Date.now() + HOUR_MS),
  );
  return { trial, payment };
}

const statusOf = {
  consultation: async (id: string) =>
    (
      await prisma.consultation.findUniqueOrThrow({
        where: { id },
        select: { status: true },
      })
    ).status,
  subscription: async (id: string) =>
    (
      await prisma.subscription.findUniqueOrThrow({
        where: { id },
        select: { status: true },
      })
    ).status,
  payment: async (id: string) =>
    (
      await prisma.payment.findUniqueOrThrow({
        where: { id },
        select: { paymentStatus: true },
      })
    ).paymentStatus,
};

beforeEach(() => {
  refundDoor.refundBookingPayment.mockClear();
  mockGateway.cancelRazorpayOrder.mockReset();
  mockGateway.cancelRazorpayOrder.mockResolvedValue("no_live_payment");
  mockGateway.readRazorpayOrderHolding.mockReset();
  mockGateway.readRazorpayOrderHolding.mockResolvedValue({
    kind: "empty",
    onlyFailed: false,
  });
  mockReport.message.mockClear();
  mockCapture.answer = null;
  mockStaging.fail = false;
});

const rejectedAs = (host: SeededHost) =>
  prisma.consultantProfile.update({
    where: { id: host.consultantProfileId },
    data: { verificationStatus: "REJECTED" },
  });

describe("a moderation reject stops new sales and honours what is booked", () => {
  it("ends every unpaid sale in its transaction and leaves the paid ones", async () => {
    const host = await seedHost();
    const link = await liveLink(host);
    // What the booking read at each gateway call: open before the close, ended at the re-read.
    const seenAt: Record<string, string> = {};
    mockGateway.cancelRazorpayOrder.mockImplementation(async () => {
      seenAt.cancel = await statusOf.consultation(link.request.consultationId!);
      return "no_live_payment";
    });
    mockGateway.readRazorpayOrderHolding.mockImplementation(async () => {
      seenAt.reread = await statusOf.consultation(link.request.consultationId!);
      return { kind: "empty", onlyFailed: false };
    });
    const requester = await seedConsultee();
    const request = await seedOneToOne(
      "consultation",
      host,
      requester,
      { startsAt: futureAt(6, 10), endsAt: futureAt(6, 11) },
      {
        status: "PENDING",
        bookingSource: "REQUEST_SUBMITTED",
        isTentative: true,
      },
    );
    const hold = await unpaidTrialHold(host);
    const paidBuyer = await seedConsultee();
    const paid = await seedOneToOne(
      "consultation",
      host,
      paidBuyer,
      { startsAt: futureAt(8, 9), endsAt: futureAt(8, 10) },
      {
        status: "APPROVED",
        isTentative: false,
        payment: { status: "SUCCEEDED", expiresAt: null },
      },
    );
    const planBuyer = await seedConsultee();
    const boughtPlan = await seedOneToOne(
      "subscription",
      host,
      planBuyer,
      { startsAt: futureAt(9, 9), endsAt: futureAt(9, 10) },
      {
        status: "PENDING",
        isTentative: true,
        payment: { status: "SUCCEEDED", expiresAt: null },
      },
    );

    const { summary } = await reject(host);

    expect(summary).toMatchObject({
      payLinksClosed: 1,
      requestsDeclined: 1,
      trialHoldsReleased: 1,
      salesKept: 0,
      unpaidSales: "ok",
    });
    // The approved link: EXPIRED, its order expired, its checkout's spend returned.
    expect(await statusOf.consultation(link.request.consultationId!)).toBe(
      "EXPIRED",
    );
    expect(await statusOf.payment(link.request.payment!.id)).toBe("EXPIRED");
    expect(await consumedBy(link.consumption)).toEqual(RETURNED);
    // The unanswered request: declined, its held time released.
    expect(await statusOf.consultation(request.consultationId!)).toBe(
      "REJECTED",
    );
    const released = await prisma.appointmentOccurrence.findUniqueOrThrow({
      where: { id: request.occurrenceId },
      select: { completionStatus: true, deletedAt: true },
    });
    expect(released.completionStatus).toBe("CANCELLED");
    expect(released.deletedAt).not.toBeNull();
    // The unpaid trial hold: cancelled, its order expired, its call tombstoned.
    const trial = await prisma.trial.findUniqueOrThrow({
      where: { id: hold.trial.id },
      select: { status: true, appointment: { select: { deletedAt: true } } },
    });
    expect(trial.status).toBe("CANCELLED");
    expect(trial.appointment?.deletedAt).not.toBeNull();
    expect(await statusOf.payment(hold.payment.id)).toBe("EXPIRED");
    // Every ending carries a neutral reason, since learners read their history.
    const edges = await prisma.bookingStatusHistory.findMany({
      where: {
        entityId: {
          in: [
            link.request.consultationId!,
            request.consultationId!,
            hold.trial.id,
          ],
        },
        reason: "EXPERT_UNAVAILABLE",
      },
      select: { toStatus: true },
    });
    expect(edges.map((e) => e.toStatus).sort()).toEqual([
      "CANCELLED",
      "EXPIRED",
      "REJECTED",
    ]);
    // Paid bookings are honoured.
    expect(await statusOf.consultation(paid.consultationId!)).toBe("APPROVED");
    expect(await statusOf.subscription(boughtPlan.subscriptionId!)).toBe(
      "PENDING",
    );
    expect(await statusOf.payment(paid.payment!.id)).toBe("SUCCEEDED");
    // The real order was asked about before the close and re-read after it.
    expect(mockGateway.cancelRazorpayOrder).toHaveBeenCalledWith(
      link.request.payment!.paymentIntent,
    );
    expect(mockGateway.readRazorpayOrderHolding).toHaveBeenCalledWith(
      link.request.payment!.paymentIntent,
    );
    expect(seenAt).toEqual({
      cancel: "APPROVED_PENDING_PAYMENT",
      reread: "EXPIRED",
    });
    expect(
      await prisma.bookingStatusHistory.count({
        where: { reason: "EXPERT_NOT_VERIFIED" },
      }),
    ).toBe(0);
    const noticed = (summary.stagedEmails ?? []).map((e) => e.emailType);
    expect(noticed.filter((t) => t === "APPOINTMENT_CANCELLED")).toHaveLength(
      2,
    );
    expect(noticed).toContain("TRIAL_CANCELLED");
    expect(mockReport.message).not.toHaveBeenCalled();
    expect(await bellPayloads(link.consultee.userId)).toContain(
      CLOSED_AFTER_ORDER,
    );
    expect(await bellPayloads(requester.userId)).toContain(CLOSED_NO_ORDER);
    for (const learner of [link.consultee.userId, requester.userId]) {
      expect(await bellPayloads(learner)).not.toMatch(/reject|verif/i);
    }
  }, 60_000);

  it("refunds a late capture on a closed link and never confirms the booking", async () => {
    const host = await seedHost();
    const link = await liveLink(host);
    await reject(host);
    // The pay page no longer opens the order.
    expect(
      await resolvePayPage(link.request.payment!.id, link.consultee.userId),
    ).toMatchObject({ kind: "unpayable", message: PAY_PAGE_AFTER_ORDER });

    const outcome = await handlePaymentSuccess(
      link.request.payment!.paymentIntent,
      link.request.captureMetadata,
      PRICE_PAISE,
    );

    expect(outcome).toBe("captured_after_release");
    expect(await statusOf.consultation(link.request.consultationId!)).toBe(
      "EXPIRED",
    );
    expect(refundDoor.refundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: link.request.payment!.id }),
    );
    // A recorded capture on the closed booking is a refund, never a paid booking.
    expect(await statusOf.payment(link.request.payment!.id)).toBe("SUCCEEDED");
    expect(
      await resolvePayPage(link.request.payment!.id, link.consultee.userId),
    ).toMatchObject({ kind: "unpayable", message: PAY_PAGE_AFTER_ORDER });
  }, 60_000);

  it.each(["EXPIRED", "REJECTED"] as const)(
    "answers a capture on a %s booking as refunded, whoever the expert is",
    async (status) => {
      const host = await seedHost();
      const link = await liveLink(host);
      await prisma.consultation.update({
        where: { id: link.request.consultationId! },
        data: { status },
      });
      await prisma.payment.update({
        where: { id: link.request.payment!.id },
        data: { paymentStatus: "SUCCEEDED" },
      });

      expect(
        await resolvePayPage(link.request.payment!.id, link.consultee.userId),
      ).toMatchObject({
        kind: "unpayable",
        message:
          "This booking closed before your payment arrived. If you were charged, the money is refunded automatically.",
      });
    },
    60_000,
  );

  it("keeps a sale whose order already holds a live payment, and confirms it when the capture lands", async () => {
    const host = await seedHost();
    const link = await liveLink(host);
    mockGateway.cancelRazorpayOrder.mockResolvedValue("has_live_payment");

    const { summary } = await reject(host);

    expect(summary).toMatchObject({ payLinksClosed: 0, salesKept: 1 });
    expect(await statusOf.consultation(link.request.consultationId!)).toBe(
      "APPROVED_PENDING_PAYMENT",
    );
    expect(await statusOf.payment(link.request.payment!.id)).toBe("PENDING");
    expect(
      await handlePaymentSuccess(
        link.request.payment!.paymentIntent,
        link.request.captureMetadata,
        PRICE_PAISE,
      ),
    ).toBe("confirmed");
    expect(refundDoor.refundBookingPayment).not.toHaveBeenCalled();
  }, 60_000);

  it("refunds a capture that lands after the close even if no webhook arrives", async () => {
    const host = await seedHost();
    const link = await liveLink(host);
    mockGateway.readRazorpayOrderHolding.mockResolvedValue({
      kind: "captured",
      paymentId: `pay_${randomUUID()}`,
      amountPaise: PRICE_PAISE,
    });

    await reject(host);

    expect(await statusOf.consultation(link.request.consultationId!)).toBe(
      "EXPIRED",
    );
    expect(refundDoor.refundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: link.request.payment!.id }),
    );
  }, 60_000);

  it("closes nothing for an order the gateway cannot answer for, and reports it once", async () => {
    const host = await seedHost();
    const link = await liveLink(host);
    mockGateway.cancelRazorpayOrder.mockRejectedValue(new Error("timeout"));

    const { summary } = await reject(host);

    expect(summary).toMatchObject({ payLinksClosed: 0, salesKept: 1 });
    expect(await statusOf.payment(link.request.payment!.id)).toBe("PENDING");
    expect(await statusOf.consultation(link.request.consultationId!)).toBe(
      "APPROVED_PENDING_PAYMENT",
    );
    expect(mockReport.message).toHaveBeenCalledTimes(1);
    expect(String(mockReport.message.mock.calls[0][0])).toContain(
      "REJECT_SALES_UNSETTLED",
    );
  }, 60_000);

  it("reports a capture the re-read found but the capture handler did not refund", async () => {
    const host = await seedHost();
    await liveLink(host);
    mockGateway.readRazorpayOrderHolding.mockResolvedValue({
      kind: "captured",
      paymentId: `pay_${randomUUID()}`,
      amountPaise: PRICE_PAISE,
    });
    mockCapture.answer = async () => null;

    await reject(host);

    expect(mockReport.message).toHaveBeenCalledTimes(1);
    expect(mockReport.message.mock.calls[0][1]).toMatchObject({
      extra: { unreadOrderIds: [expect.stringMatching(/^order_/)] },
    });
  }, 60_000);

  it("reports a closed order still holding a live payment, which the closed-order reconciler can then re-read", async () => {
    const host = await seedHost();
    const link = await liveLink(host);
    mockGateway.readRazorpayOrderHolding.mockResolvedValue({ kind: "live" });
    const closedFrom = new Date();

    await reject(host);

    expect(mockReport.message).toHaveBeenCalledTimes(1);
    expect(String(mockReport.message.mock.calls[0][0])).toContain(
      "REJECT_SALES_UNSETTLED",
    );
    expect(mockReport.message.mock.calls[0][1]).toMatchObject({
      extra: { liveOrderIds: [link.request.payment!.paymentIntent] },
    });
    // The closed-order cohort: an EXPIRED Razorpay order with no capture, closed in its window.
    expect(
      await prisma.payment.count({
        where: {
          id: link.request.payment!.id,
          paymentStatus: "EXPIRED",
          paymentGateway: "RAZORPAY",
          paymentIntent: { startsWith: "order_" },
          capturedAt: null,
          updatedAt: { gte: closedFrom },
        },
      }),
    ).toBe(1);
  }, 60_000);

  it("never re-reads a closed pre-mint marker at the gateway", async () => {
    const host = await seedHost();
    const link = await liveLink(host);
    await prisma.payment.update({
      where: { id: link.request.payment!.id },
      data: { paymentIntent: `premint_${randomUUID()}` },
    });

    const { summary } = await reject(host);

    expect(summary).toMatchObject({ payLinksClosed: 1 });
    expect(await statusOf.payment(link.request.payment!.id)).toBe("EXPIRED");
    expect(mockGateway.readRazorpayOrderHolding).not.toHaveBeenCalled();
    expect(mockReport.message).not.toHaveBeenCalled();
  }, 60_000);

  it("ends nothing for an expert verified again before the ending runs", async () => {
    const host = await seedHost();
    const link = await liveLink(host);

    const outcome = await endUnverifiedExpertSales({
      consultantProfileId: host.consultantProfileId,
      actorUserId: link.consultee.userId,
    });

    expect(outcome).toMatchObject({ skipped: true, payLinksClosed: 0 });
    expect(await statusOf.consultation(link.request.consultationId!)).toBe(
      "APPROVED_PENDING_PAYMENT",
    );
    expect(mockGateway.cancelRazorpayOrder).not.toHaveBeenCalled();
  }, 60_000);

  it("closes what it read in time and leaves the rest open for another pass", async () => {
    const host = await seedHost();
    const link = await liveLink(host);
    await rejectedAs(host);
    const args = {
      consultantProfileId: host.consultantProfileId,
      actorUserId: link.consultee.userId,
    };

    const outOfTime = await endUnverifiedExpertSales({
      ...args,
      outOfTime: () => true,
    });
    expect(outOfTime).toMatchObject({ complete: false, payLinksClosed: 0 });
    expect(await statusOf.payment(link.request.payment!.id)).toBe("PENDING");

    const next = await endUnverifiedExpertSales(args);
    expect(next).toMatchObject({ complete: true, payLinksClosed: 1 });
    expect(await statusOf.payment(link.request.payment!.id)).toBe("EXPIRED");
  }, 60_000);

  it("closes no sale whose learner notice could not be staged", async () => {
    const host = await seedHost();
    const link = await liveLink(host);
    await rejectedAs(host);
    const args = {
      consultantProfileId: host.consultantProfileId,
      actorUserId: link.consultee.userId,
    };
    mockStaging.fail = true;

    await expect(endUnverifiedExpertSales(args)).rejects.toThrow(
      "outbox write failed",
    );
    expect(await statusOf.consultation(link.request.consultationId!)).toBe(
      "APPROVED_PENDING_PAYMENT",
    );
    expect(await statusOf.payment(link.request.payment!.id)).toBe("PENDING");

    mockStaging.fail = false;
    await endUnverifiedExpertSales(args);
    expect(await statusOf.consultation(link.request.consultationId!)).toBe(
      "EXPIRED",
    );
    expect(await bellPayloads(link.consultee.userId)).toContain(
      CLOSED_AFTER_ORDER,
    );
  }, 60_000);

  it("names an order that changed after the gateway was asked, and keeps its sale", async () => {
    const host = await seedHost();
    const link = await liveLink(host);
    await rejectedAs(host);
    const paymentId = link.request.payment!.id;

    // The snapshot saw a pre-mint marker; the row now holds a real order.
    const ended = await prisma.$transaction((tx) =>
      endUnpaidSalesInTx(tx, {
        consultantProfileId: host.consultantProfileId,
        actorUserId: link.consultee.userId,
        cleared: new Map([[paymentId, `premint_${randomUUID()}`]]),
        asked: new Set([paymentId]),
      }),
    );

    expect(ended).toMatchObject({ salesKept: 1, ordersChanged: [paymentId] });
    expect(await statusOf.payment(paymentId)).toBe("PENDING");
  }, 60_000);

  it("records the retry marker in the reject's own transaction", async () => {
    const host = await seedHost();
    const staff = await seedConsultee();
    const reporter = await seedConsultee();
    const report = await prisma.moderationReport.create({
      data: {
        type: "PROFILE",
        reason: "OTHER",
        status: "ACTION_TAKEN",
        reportedById: reporter.userId,
        targetUserId: host.userId,
      },
    });
    const action = await prisma.moderationAction.create({
      data: {
        actionType: "PROFILE_UNVERIFIED",
        reportId: report.id,
        takenById: staff.userId,
      },
    });

    // The worker stops after the commit: phase 2 never runs.
    await prisma.$transaction(
      (tx) =>
        applyTransactionalEffects(tx, {
          ...rejectInput(host, staff.userId),
          actionId: action.id,
        }),
      { timeout: 30_000 },
    );

    const row = await prisma.moderationAction.findUniqueOrThrow({
      where: { id: action.id },
      select: { sideEffects: true },
    });
    expect(row.sideEffects).toMatchObject({
      unverifiedConsultantProfileId: host.consultantProfileId,
      unpaidSales: "failed",
      unpaidSalesAttempts: 0,
    });
  }, 60_000);

  it("releases an unpaid group seat and keeps the event and its paid seat", async () => {
    const webinar = await seedWebinar({ capacity: 20, price: 50_000 });
    const paidSeat = await seedHeldSeat(webinar, {
      status: "SUCCEEDED",
      expiresAt: null,
    });
    const open = await seedHeldSeat(webinar, {
      status: "PENDING",
      expiresAt: new Date(Date.now() + HOUR_MS),
    });

    const { summary } = await reject(webinar.host);

    expect(summary).toMatchObject({ seatsReleased: 1 });
    const seats = await prisma.appointmentParticipant.findMany({
      where: {
        appointmentId: webinar.appointmentId,
        userId: { in: [paidSeat.buyer.userId, open.buyer.userId] },
      },
      select: { userId: true, status: true },
    });
    expect(Object.fromEntries(seats.map((p) => [p.userId, p.status]))).toEqual({
      [paidSeat.buyer.userId]: "CONFIRMED",
      [open.buyer.userId]: "CANCELLED",
    });
    expect(await statusOf.payment(open.payment.id)).toBe("EXPIRED");
    expect(await statusOf.payment(paidSeat.payment.id)).toBe("SUCCEEDED");
    expect(
      await prisma.appointmentOccurrence.count({
        where: { appointmentId: webinar.appointmentId, deletedAt: null },
      }),
    ).toBe(1);
  }, 60_000);

  it("refuses to approve an unpaid request for an unverified expert, and still places a paid one", async () => {
    const host = await seedHost();
    await publishEveryHour(host);
    const unpaid = await seedRequest(host, await seedConsultee());
    const paidRequester = await seedConsultee();
    const paid = await seedOneToOne(
      "consultation",
      host,
      paidRequester,
      { startsAt: futureAt(7, 9), endsAt: futureAt(7, 10) },
      {
        status: "PENDING",
        isTentative: true,
        payment: { status: "SUCCEEDED", expiresAt: null },
      },
    );
    await prisma.consultantProfile.update({
      where: { id: host.consultantProfileId },
      data: { verificationStatus: "REJECTED" },
    });

    const refused = await allocate({
      eventType: "consultation",
      eventId: unpaid.consultationId,
      mode: "manual",
      slots: halfHourStarts(futureAt(6, 10)),
      override: true,
    });
    const placed = await allocate({
      eventType: "consultation",
      eventId: paid.consultationId!,
      mode: "requested",
    });

    expect(refused).toMatchObject({
      success: false,
      errorCode: "EXPERT_NOT_VERIFIED",
      httpStatus: 409,
    });
    expect(await statusOf.consultation(unpaid.consultationId)).toBe("PENDING");
    expect(placed).toMatchObject({ success: true, outcome: "approved" });
  }, 60_000);

  it("refuses to approve an unpaid request for a deleted expert whose status still reads VERIFIED", async () => {
    const host = await seedHost();
    await publishEveryHour(host);
    const unpaid = await seedRequest(host, await seedConsultee());
    await prisma.consultantProfile.update({
      where: { id: host.consultantProfileId },
      data: { deletedAt: new Date() },
    });

    const refused = await allocate({
      eventType: "consultation",
      eventId: unpaid.consultationId,
      mode: "manual",
      slots: halfHourStarts(futureAt(6, 12)),
      override: true,
    });

    expect(refused).toMatchObject({
      success: false,
      errorCode: "EXPERT_NOT_VERIFIED",
    });
    expect(await statusOf.consultation(unpaid.consultationId)).toBe("PENDING");
  }, 60_000);

  describe("when the ending fails after the reject commits", () => {
    /** A committed reject whose phase 2 never ended the sales, as the action row records it. */
    async function failedEnding(host: SeededHost, ageMinutes?: number) {
      const reporter = await seedConsultee();
      const staff = await seedConsultee();
      const report = await prisma.moderationReport.create({
        data: {
          type: "PROFILE",
          reason: "OTHER",
          status: "ACTION_TAKEN",
          reportedById: reporter.userId,
          targetUserId: host.userId,
        },
      });
      return prisma.moderationAction.create({
        data: {
          actionType: "PROFILE_UNVERIFIED",
          reportId: report.id,
          takenById: staff.userId,
          createdAt: new Date(Date.now() - (ageMinutes ?? 10) * 60_000),
          sideEffects: {
            profilesUnverified: 1,
            unverifiedConsultantProfileId: host.consultantProfileId,
            unpaidSales: "failed",
            unpaidSalesAttempts: 1,
          },
        },
      });
    }
    const sideEffectsOf = async (id: string) =>
      JSON.stringify(
        (
          await prisma.moderationAction.findUniqueOrThrow({
            where: { id },
            select: { sideEffects: true },
          })
        ).sideEffects,
      );

    it("the retry sweep ends the sales and marks the step settled", async () => {
      const host = await seedHost();
      const request = await seedOneToOne(
        "consultation",
        host,
        await seedConsultee(),
        { startsAt: futureAt(6, 14), endsAt: futureAt(6, 15) },
        {
          status: "PENDING",
          bookingSource: "REQUEST_SUBMITTED",
          isTentative: true,
        },
      );
      await prisma.consultantProfile.update({
        where: { id: host.consultantProfileId },
        data: { verificationStatus: "REJECTED" },
      });
      const action = await failedEnding(host);

      await retryModerationEnforcement();

      expect(await statusOf.consultation(request.consultationId!)).toBe(
        "REJECTED",
      );
      const settled = await sideEffectsOf(action.id);
      expect(settled).toContain('"unpaidSales":"ok"');
      expect(settled).toContain('"requestsDeclined":1');
      // Settled rows leave the queue: a second run changes nothing.
      await retryModerationEnforcement();
      expect(await sideEffectsOf(action.id)).toBe(settled);
    }, 60_000);

    it("skips the ending for an expert verified again since", async () => {
      const host = await seedHost();
      const request = await seedOneToOne(
        "consultation",
        host,
        await seedConsultee(),
        { startsAt: futureAt(6, 16), endsAt: futureAt(6, 17) },
        {
          status: "PENDING",
          bookingSource: "REQUEST_SUBMITTED",
          isTentative: true,
        },
      );
      const action = await failedEnding(host);

      await retryModerationEnforcement();

      expect(await statusOf.consultation(request.consultationId!)).toBe(
        "PENDING",
      );
      expect(await sideEffectsOf(action.id)).toContain(
        '"unpaidSales":"skipped"',
      );
    }, 60_000);

    it("leaves a marker just written to the reject's own phase 2", async () => {
      const host = await seedHost();
      await rejectedAs(host);
      const action = await failedEnding(host, 0);

      await retryModerationEnforcement();

      expect(await sideEffectsOf(action.id)).toContain(
        '"unpaidSales":"failed"',
      );
    }, 60_000);
  });
});
