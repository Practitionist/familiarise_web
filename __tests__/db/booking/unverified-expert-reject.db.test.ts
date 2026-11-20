/**
 * A moderation reject stops new sales and honours what is booked, on real
 * Postgres: in the reject's own transaction the expert's unpaid approved link
 * expires, their unanswered unpaid request is declined and their unpaid trial
 * hold is released, each open order expired and its checkout's spend returned;
 * paid bookings stay. A late capture on a closed link is refunded, and an
 * unpaid request can no longer be approved for an unverified expert.
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
  seedBuyer,
  seedRequest,
} from "./harness-host";
import {
  consumedBy,
  RETURNED,
  seedCheckoutConsumption,
} from "./harness-consumed";

jest.mock("../../../lib/payments/index", () => ({
  __esModule: true,
  createPaymentIntent: jest.fn(),
  cancelPaymentIntent: jest.fn(async () => undefined),
}));
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
  cancelRazorpayOrder: jest.fn(async (_orderId: string) => "no_live_payment"),
};
jest.mock("../../../lib/payments/core/razorpay", () => ({
  ...jest.requireActual("../../../lib/payments/core/razorpay"),
  cancelRazorpayOrder: (orderId: string) =>
    mockGateway.cancelRazorpayOrder(orderId),
}));

import {
  applyBestEffortEffects,
  applyTransactionalEffects,
} from "../../../lib/moderation/side-effects";
import { handlePaymentSuccess } from "../../../lib/payments/webhooks/handlers";
import { resolvePayPage } from "../../../lib/payments/pay-page";
import { allocate } from "../../../lib/booking/allocation";
import { bookTrialInTx } from "../../../lib/trials/book-trial";
import { refundDoor } from "./harness-edges";

const PRICE_PAISE = 80_000;

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
  const buyer = await seedBuyer();
  const startsAt = futureAt(5, 10);
  const trial = await prisma.$transaction((tx) =>
    bookTrialInTx(tx, {
      consulteeProfileId: buyer.consulteeProfileId,
      consultantProfileId: host.consultantProfileId,
      subscriptionPlanId: plan.id,
      organizationId: null,
      consulteeUserId: buyer.userId,
      consultantUserId: host.userId,
      paid: true,
      agreedPricePaise: 20_000,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
    }),
  );
  const payment = await prisma.payment.create({
    data: {
      amount: BigInt(20_000),
      originalAmount: BigInt(20_000),
      paymentMethod: "card",
      paymentIntent: `order_dbtier_${randomUUID()}`,
      paymentGateway: "RAZORPAY",
      paymentStatus: "PENDING",
      userId: buyer.userId,
      appointmentId: trial.appointmentId,
      isMockPayment: true,
      expiresAt: new Date(Date.now() + HOUR_MS),
      legs: { create: [{ source: "CARD", amountPaise: BigInt(20_000) }] },
    },
  });
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
  mockGateway.cancelRazorpayOrder.mockClear();
});

describe("a moderation reject stops new sales and honours what is booked", () => {
  it("ends every unpaid sale in its transaction and leaves the paid ones", async () => {
    const host = await seedHost();
    const link = await liveLink(host);
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

    const { transactional, summary } = await reject(host);

    expect({
      payLinksClosed: transactional.payLinksClosed,
      requestsDeclined: transactional.requestsDeclined,
      trialHoldsReleased: transactional.trialHoldsReleased,
    }).toEqual({
      payLinksClosed: 1,
      requestsDeclined: 1,
      trialHoldsReleased: 1,
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
    // Every ending carries the reject's reason on its history row.
    const edges = await prisma.bookingStatusHistory.findMany({
      where: {
        entityId: {
          in: [
            link.request.consultationId!,
            request.consultationId!,
            hold.trial.id,
          ],
        },
        reason: "EXPERT_NOT_VERIFIED",
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
    // After commit: the real order is cancelled, each learner's notice is staged.
    expect(mockGateway.cancelRazorpayOrder).toHaveBeenCalledWith(
      link.request.payment!.paymentIntent,
    );
    const noticed = (summary.stagedEmails ?? []).map((e) => e.emailType);
    expect(noticed.filter((t) => t === "APPOINTMENT_CANCELLED")).toHaveLength(
      2,
    );
    expect(noticed).toContain("TRIAL_CANCELLED");
    expect(summary).not.toHaveProperty("unpaidSalesEnded");
  }, 60_000);

  it("refunds a late capture on a closed link and never confirms the booking", async () => {
    const host = await seedHost();
    const link = await liveLink(host);
    await reject(host);
    // The pay page no longer opens the order.
    expect(
      await resolvePayPage(link.request.payment!.id, link.consultee.userId),
    ).toMatchObject({ kind: "unpayable" });

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
});
