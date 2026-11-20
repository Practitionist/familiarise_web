/**
 * "Request again" on a booking whose pay window closed while its order is still
 * PENDING closes the old order first, on real Postgres:
 *  - the click expires the order and returns what its checkout consumed, once;
 *  - a late capture afterwards is refunded and never confirms the old booking;
 *  - a capture that won first refuses the click, and nothing is closed;
 *  - a second click changes nothing; an open window and a stranger are refused;
 *  - a pay-first hold, a trial and a webinar seat close the same way.
 */
import { randomUUID } from "node:crypto";
import prisma from "../../../lib/prisma";
import {
  futureAt,
  HOUR_MS,
  seedConsultee,
  seedHost,
  seedOneToOne,
} from "./harness";
import { publishEveryHour, seedBuyer } from "./harness-host";
import { seedHeldSeat, seedWebinar } from "./harness-seats";
import {
  consumedBy,
  RETURNED,
  seedCheckoutConsumption,
  STILL_SPENT,
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
jest.mock("../../../lib/stream/access-revocation", () =>
  jest.requireActual("./harness-edges").chatRevocationMock(),
);
jest.mock("../../../lib/rate-limit", () =>
  jest.requireActual("./harness-edges").rateLimitMock(),
);

import { closeOrderForRequestAgain } from "../../../lib/booking/request-again";
import { handlePaymentSuccess } from "../../../lib/payments/webhooks/handlers";
import { bookTrialInTx } from "../../../lib/trials/book-trial";
import { refundDoor } from "./harness-edges";

const PRICE_PAISE = 80_000;
const CLOSED_MINUTES_AGO = 5;

/** An approved request whose pay link closed five minutes ago, its time still free, its checkout having spent credit, a code and an engagement. */
async function lapsedApproval(
  shape: { status?: "PENDING" | "SUCCEEDED"; expiresAt?: Date } = {},
) {
  const startsAt = futureAt(4, 10);
  const consultee = await seedConsultee();
  const request = await seedOneToOne(
    "consultation",
    await seedHost(),
    consultee,
    { startsAt, endsAt: new Date(startsAt.getTime() + HOUR_MS) },
    {
      status: "APPROVED_PENDING_PAYMENT",
      bookingSource: "REQUEST_SUBMITTED",
      isTentative: true,
      payment: {
        status: shape.status ?? "PENDING",
        amount: PRICE_PAISE,
        expiresAt:
          shape.expiresAt ?? new Date(Date.now() - CLOSED_MINUTES_AGO * 60_000),
      },
    },
  );
  const consumption = await seedCheckoutConsumption(
    consultee.userId,
    request.payment!.id,
    PRICE_PAISE,
  );
  return { consultee, request, consumption };
}

const click = (appointmentId: string, userId: string) =>
  closeOrderForRequestAgain({ appointmentId, userId });

const capture = (request: Awaited<ReturnType<typeof seedOneToOne>>) =>
  handlePaymentSuccess(
    request.payment!.paymentIntent,
    request.captureMetadata,
    Number(request.payment!.amount),
  );

const consultationStatus = async (id: string) =>
  (
    await prisma.consultation.findUniqueOrThrow({
      where: { id },
      select: { status: true },
    })
  ).status;

const paymentStatus = async (id: string) =>
  (
    await prisma.payment.findUniqueOrThrow({
      where: { id },
      select: { paymentStatus: true },
    })
  ).paymentStatus;

describe("Request again closes the old order first", () => {
  beforeEach(() => refundDoor.refundBookingPayment.mockClear());

  it("closes the open order and returns what its checkout consumed, once", async () => {
    const { consultee, request, consumption } = await lapsedApproval();

    await expect(
      click(request.appointmentId, consultee.userId),
    ).resolves.toEqual({ ok: true, closed: 1 });
    await expect(
      click(request.appointmentId, consultee.userId),
    ).resolves.toEqual({ ok: true, closed: 0 });

    expect(await paymentStatus(request.payment!.id)).toBe("EXPIRED");
    expect(await consultationStatus(request.consultationId!)).toBe("EXPIRED");
    expect(await consumedBy(consumption)).toEqual(RETURNED);
    const hold = await prisma.appointmentOccurrence.findUniqueOrThrow({
      where: { id: request.occurrenceId },
      select: { completionStatus: true, deletedAt: true },
    });
    expect(hold.completionStatus).toBe("CANCELLED");
    expect(hold.deletedAt).not.toBeNull();
    const edge = await prisma.bookingStatusHistory.findFirstOrThrow({
      where: { entityId: request.consultationId!, toStatus: "EXPIRED" },
      select: { fromStatus: true, reason: true, actorUserId: true },
    });
    expect(edge).toEqual({
      fromStatus: "APPROVED_PENDING_PAYMENT",
      reason: "REQUESTED_AGAIN",
      actorUserId: consultee.userId,
    });
  });

  it("a late capture after the click is refunded and never confirms the old booking", async () => {
    const { consultee, request } = await lapsedApproval();
    await click(request.appointmentId, consultee.userId);

    expect(await capture(request)).toBe("captured_after_release");

    expect(await consultationStatus(request.consultationId!)).toBe("EXPIRED");
    expect(refundDoor.refundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: request.payment!.id }),
    );
    // The refunded capture is not a confirmed booking, so a later click still goes through.
    await expect(
      click(request.appointmentId, consultee.userId),
    ).resolves.toEqual({ ok: true, closed: 0 });
  });

  it("a capture that won first refuses the click, and nothing is closed", async () => {
    const { consultee, request, consumption } = await lapsedApproval();
    await capture(request);
    expect(await consultationStatus(request.consultationId!)).toBe("APPROVED");

    await expect(
      click(request.appointmentId, consultee.userId),
    ).resolves.toEqual({ ok: false, code: "ALREADY_PAID" });

    expect(await paymentStatus(request.payment!.id)).toBe("SUCCEEDED");
    expect(await consultationStatus(request.consultationId!)).toBe("APPROVED");
    expect(await consumedBy(consumption)).toEqual(STILL_SPENT);
  });

  it("a click racing a capture either closes the order or is refused, never both", async () => {
    const { consultee, request } = await lapsedApproval();

    const [clicked, captured] = await Promise.all([
      click(request.appointmentId, consultee.userId),
      capture(request),
    ]);

    const outcome = {
      click: clicked.ok ? "closed" : clicked.code,
      capture: captured,
      request: await consultationStatus(request.consultationId!),
      refunded: refundDoor.refundBookingPayment.mock.calls.length > 0,
    };
    expect([
      {
        click: "closed",
        capture: "captured_after_release",
        request: "EXPIRED",
        refunded: true,
      },
      {
        click: "ALREADY_PAID",
        capture: "confirmed",
        request: "APPROVED",
        refunded: false,
      },
    ]).toContainEqual(outcome);
  });

  it("refuses a window that is still open, and a booking that is not the caller's", async () => {
    const { consultee, request, consumption } = await lapsedApproval({
      expiresAt: new Date(Date.now() + 30 * 60_000),
    });
    const stranger = await seedConsultee();

    await expect(
      click(request.appointmentId, consultee.userId),
    ).resolves.toEqual({ ok: false, code: "PAY_WINDOW_OPEN" });
    await expect(
      click(request.appointmentId, stranger.userId),
    ).resolves.toEqual({ ok: false, code: "NOT_FOUND" });

    expect(await paymentStatus(request.payment!.id)).toBe("PENDING");
    expect(await consumedBy(consumption)).toEqual(STILL_SPENT);
  });

  it("a pay-first hold expires like the abandoned-payment pass expires it", async () => {
    const startsAt = futureAt(4, 12);
    const consultee = await seedConsultee();
    const hold = await seedOneToOne(
      "consultation",
      await seedHost(),
      consultee,
      { startsAt, endsAt: new Date(startsAt.getTime() + HOUR_MS) },
      {
        status: "PENDING",
        bookingSource: "DIRECT_CHECKOUT",
        isTentative: true,
        payment: {
          status: "PENDING",
          expiresAt: new Date(Date.now() - 60_000),
        },
      },
    );

    await expect(click(hold.appointmentId, consultee.userId)).resolves.toEqual({
      ok: true,
      closed: 1,
    });

    expect(await paymentStatus(hold.payment!.id)).toBe("EXPIRED");
    expect(await consultationStatus(hold.consultationId!)).toBe("EXPIRED");
    const appointment = await prisma.appointment.findUniqueOrThrow({
      where: { id: hold.appointmentId },
      select: { deletedAt: true },
    });
    expect(appointment.deletedAt).not.toBeNull();
    const seat = await prisma.appointmentParticipant.findFirstOrThrow({
      where: { appointmentId: hold.appointmentId, userId: consultee.userId },
      select: { status: true },
    });
    expect(seat.status).toBe("CANCELLED");
  });

  it("a paid trial's lapsed order closes and the trial is cancelled", async () => {
    const host = await seedHost();
    await publishEveryHour(host);
    const buyer = await seedBuyer();
    const plan = await prisma.subscriptionPlan.create({
      data: {
        title: "Request again trial plan",
        price: BigInt(400_000),
        consultantProfileId: host.consultantProfileId,
        sessionsPerWeek: 1,
        durationInMonths: 1,
        sessionDurationInHours: 1,
        totalSessions: 4,
        trialEnabled: true,
        trialDurationMinutes: 30,
        trialPriceInPaise: BigInt(20_000),
      },
    });
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
        expiresAt: new Date(Date.now() - 60_000),
        legs: { create: [{ source: "CARD", amountPaise: BigInt(20_000) }] },
      },
    });

    await expect(click(trial.appointmentId, buyer.userId)).resolves.toEqual({
      ok: true,
      closed: 1,
    });

    expect(await paymentStatus(payment.id)).toBe("EXPIRED");
    const row = await prisma.trial.findUniqueOrThrow({
      where: { id: trial.id },
      select: { status: true, pendingPaymentUrl: true },
    });
    expect(row).toEqual({ status: "CANCELLED", pendingPaymentUrl: null });
  });

  it("a webinar seat's lapsed order closes only the caller's seat", async () => {
    const webinar = await seedWebinar();
    const mine = await seedHeldSeat(webinar, {
      status: "PENDING",
      expiresAt: new Date(Date.now() - 60_000),
    });
    const theirs = await seedHeldSeat(webinar, {
      status: "PENDING",
      expiresAt: new Date(Date.now() - 60_000),
    });

    await expect(
      click(webinar.appointmentId, mine.buyer.userId),
    ).resolves.toEqual({ ok: true, closed: 1 });

    expect(await paymentStatus(mine.payment.id)).toBe("EXPIRED");
    expect(await paymentStatus(theirs.payment.id)).toBe("PENDING");
    const seats = await prisma.appointmentParticipant.findMany({
      where: { appointmentId: webinar.appointmentId, role: "CONSULTEE" },
      select: { userId: true, status: true },
    });
    expect(Object.fromEntries(seats.map((s) => [s.userId, s.status]))).toEqual({
      [mine.buyer.userId]: "CANCELLED",
      [theirs.buyer.userId]: "HELD",
    });
  });
});
