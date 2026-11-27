/**
 * Cancel money rules on real Postgres:
 *  - the cancel window refuses a session about to start or already held, with
 *    nothing committed;
 *  - a cancel never drives (or leaves undurable) a refund another door owns;
 *  - an unpaid checkout's discount use comes back only on the expiry CAS win.
 */
import "./harness-cancel-route";
import { sessionUser } from "./harness-session";
import prisma from "../../../lib/prisma";
import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import {
  futureAt,
  HOUR_MS,
  seedConsultee,
  seedHost,
  seedOneToOne,
} from "./harness";

import { POST as cancel } from "../../../app/api/appointments/[appointmentId]/cancel/route";
import { handlePaymentSuccess } from "../../../lib/payments/webhooks/handlers";
import { settleCancelledSessionForOne } from "../../../scripts/appointments/settle-cancelled-sessions";

// The capture's chat channels are a fire-and-forget step this suite does not judge; left real, it logs after the suite ends.
jest.mock("../../../lib/payments/webhooks/ensure-channels", () => ({
  __esModule: true,
  ensureChannelsForAppointment: jest.fn(async () => ({ ensured: true })),
}));

const refundDoor = jest.requireMock(
  "../../../lib/payments/operations/booking-refund",
) as { refundBookingPayment: jest.Mock };

async function seedPaid(
  window: { startsAt: Date; endsAt: Date },
  opts: { completionStatus?: "SCHEDULED" | "COMPLETED" } = {},
) {
  const host = await seedHost();
  const buyer = await seedConsultee();
  const booking = await seedOneToOne("consultation", host, buyer, window, {
    status: "APPROVED",
    isTentative: false,
    completionStatus: opts.completionStatus,
    payment: { status: "SUCCEEDED", expiresAt: null },
  });
  sessionUser.current = {
    id: buyer.userId,
    role: "CONSULTEE",
    consulteeProfileId: buyer.consulteeProfileId,
    consultantProfileId: null,
    name: "Buyer",
  };
  return { host, buyer, booking, payment: booking.payment! };
}

const cancelRequest = (
  appointmentId: string,
  click: Record<string, unknown> = {},
) =>
  cancel(
    new NextRequest(
      `http://localhost/api/appointments/${appointmentId}/cancel`,
      {
        method: "POST",
        body: JSON.stringify({ reason: "SCHEDULE_CONFLICT", ...click }),
        headers: { "Content-Type": "application/json" },
      },
    ),
    { params: Promise.resolve({ appointmentId }) },
  );

const statusOf = async (consultationId: string) =>
  (
    await prisma.consultation.findUniqueOrThrow({
      where: { id: consultationId },
    })
  ).status;

describe("the cancel window on real rows", () => {
  it("refuses a paid session starting in ten minutes and commits nothing", async () => {
    const startsAt = new Date(Date.now() + 10 * 60_000);
    const { booking, payment } = await seedPaid({
      startsAt,
      endsAt: new Date(startsAt.getTime() + HOUR_MS),
    });

    const res = await cancelRequest(booking.appointmentId);

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("SESSION_IN_PROGRESS");
    expect(await statusOf(booking.consultationId!)).toBe("APPROVED");
    const row = await prisma.payment.findUniqueOrThrow({
      where: { id: payment.id },
    });
    expect(row.refundOwedKey).toBeNull();
    expect(refundDoor.refundBookingPayment).not.toHaveBeenCalled();
  });

  it("refuses a held session even with a long-notice consultee reschedule on record", async () => {
    const startsAt = new Date(Date.now() - 3 * HOUR_MS);
    const { booking, buyer } = await seedPaid(
      { startsAt, endsAt: new Date(startsAt.getTime() + HOUR_MS) },
      { completionStatus: "COMPLETED" },
    );
    // The original slot, moved by the buyer three days ahead of its start.
    const moved = await prisma.appointmentOccurrence.create({
      data: {
        appointmentId: booking.appointmentId,
        ordinal: 1,
        startsAt: new Date(startsAt.getTime() - 7 * 24 * HOUR_MS),
        endsAt: new Date(startsAt.getTime() - 7 * 24 * HOUR_MS + HOUR_MS),
        isTentative: true,
        completionStatus: "RESCHEDULED",
        deletedAt: new Date(),
      },
    });
    await prisma.bookingStatusHistory.create({
      data: {
        appointmentId: booking.appointmentId,
        entity: "OCCURRENCE",
        entityId: moved.id,
        fromStatus: "SCHEDULED",
        toStatus: "RESCHEDULED",
        actorUserId: buyer.userId,
        createdAt: new Date(startsAt.getTime() - 10 * 24 * HOUR_MS),
      },
    });

    const res = await cancelRequest(booking.appointmentId);

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("SESSION_ALREADY_DELIVERED");
    expect(await statusOf(booking.consultationId!)).toBe("APPROVED");
    expect(refundDoor.refundBookingPayment).not.toHaveBeenCalled();
  });
});

describe("the cancel owns the refund it drives", () => {
  it("refuses while another door's refund is still owed on the payment", async () => {
    const startsAt = futureAt(5, 9);
    const { booking, payment } = await seedPaid({
      startsAt,
      endsAt: new Date(startsAt.getTime() + HOUR_MS),
    });
    const heldKey = `incident:inc-1:${booking.occurrenceId}:${randomUUID()}`;
    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        refundOwedKey: heldKey,
        refundOwedPaise: BigInt(10_000),
        refundOwedReason: "incident refund",
        refundOwedAt: new Date(),
      },
    });

    const res = await cancelRequest(booking.appointmentId);

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("REFUND_IN_PROGRESS");
    expect(await statusOf(booking.consultationId!)).toBe("APPROVED");
    const row = await prisma.payment.findUniqueOrThrow({
      where: { id: payment.id },
    });
    expect(row.refundOwedKey).toBe(heldKey);
    expect(refundDoor.refundBookingPayment).not.toHaveBeenCalled();
  });
});

describe("a voided session not yet settled", () => {
  it("a learner's cancel of a ₹1,000 consultation whose session was cut short and voided owes ₹1,000 once and settles the session, so the day-14 sweep finds nothing", async () => {
    // The hour was three weeks ago; its void was confirmed 20 days ago, past the sweep's 14 days.
    const startsAt = new Date(Date.now() - 21 * 24 * HOUR_MS);
    const { booking, payment } = await seedPaid({
      startsAt,
      endsAt: new Date(startsAt.getTime() + HOUR_MS),
    });
    const confirmedAt = new Date(Date.now() - 20 * 24 * HOUR_MS);
    await prisma.appointmentOccurrence.update({
      where: { id: booking.occurrenceId },
      data: {
        completionStatus: "VOIDED",
        voidedAt: confirmedAt,
        outcome: "CUT_SHORT",
        outcomeAt: confirmedAt,
        outcomeConfirmedAt: confirmedAt,
      },
    });

    const res = await cancelRequest(booking.appointmentId);

    expect(res.status).toBe(200);
    expect((await res.json()).refund.refundPct).toBe(100);
    expect(await statusOf(booking.consultationId!)).toBe("CANCELLED");
    expect(refundDoor.refundBookingPayment).toHaveBeenCalledTimes(1);
    expect(refundDoor.refundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: payment.id, amountPaise: 100_000 }),
    );
    expect(
      await prisma.appointmentOccurrence.findUniqueOrThrow({
        where: { id: booking.occurrenceId },
        select: { completionStatus: true, seatsSettledAt: true },
      }),
    ).toMatchObject({
      completionStatus: "VOIDED",
      seatsSettledAt: expect.any(Date),
    });

    const swept = await settleCancelledSessionForOne(booking.occurrenceId);

    expect(swept).toMatchObject({ scanned: 0, refunded: 0 });
    expect(refundDoor.refundBookingPayment).toHaveBeenCalledTimes(1);
  });
});

describe("a voided session whose verdict is not yet confirmed", () => {
  it("refuses the learner's and the expert's cancel with nothing committed, then prices the cancel in full once the verdict is confirmed", async () => {
    const startsAt = new Date(Date.now() - 3 * HOUR_MS);
    const { host, booking, payment } = await seedPaid({
      startsAt,
      endsAt: new Date(startsAt.getTime() + HOUR_MS),
    });
    const verdictAt = new Date(Date.now() - HOUR_MS);
    await prisma.appointmentOccurrence.update({
      where: { id: booking.occurrenceId },
      data: {
        completionStatus: "VOIDED",
        voidedAt: verdictAt,
        outcome: "CUT_SHORT",
        outcomeAt: verdictAt,
      },
    });
    const asBuyer = sessionUser.current;
    const sessionOf = () =>
      prisma.appointmentOccurrence.findUniqueOrThrow({
        where: { id: booking.occurrenceId },
        select: { completionStatus: true, seatsSettledAt: true },
      });

    const learner = await cancelRequest(booking.appointmentId);
    sessionUser.current = {
      id: host.userId,
      role: "CONSULTANT",
      consulteeProfileId: null,
      consultantProfileId: host.consultantProfileId,
      name: "Host",
    };
    const expert = await cancelRequest(booking.appointmentId);
    sessionUser.current = asBuyer;

    for (const res of [learner, expert]) {
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        code: "CANCEL_WAITS_FOR_VERDICT",
      });
    }
    expect(await statusOf(booking.consultationId!)).toBe("APPROVED");
    expect(refundDoor.refundBookingPayment).not.toHaveBeenCalled();
    expect(await sessionOf()).toMatchObject({ seatsSettledAt: null });

    await prisma.appointmentOccurrence.update({
      where: { id: booking.occurrenceId },
      data: { outcomeConfirmedAt: new Date() },
    });
    const res = await cancelRequest(booking.appointmentId);

    expect(res.status).toBe(200);
    expect((await res.json()).refund.refundPct).toBe(100);
    expect(await statusOf(booking.consultationId!)).toBe("CANCELLED");
    expect(refundDoor.refundBookingPayment).toHaveBeenCalledTimes(1);
    expect(refundDoor.refundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: payment.id, amountPaise: 100_000 }),
    );
    expect(await sessionOf()).toMatchObject({
      completionStatus: "VOIDED",
      seatsSettledAt: expect.any(Date),
    });
  });
});

describe("discount use on an unpaid end", () => {
  async function seedUnpaidWithCode() {
    const host = await seedHost();
    const buyer = await seedConsultee();
    const startsAt = futureAt(4, 9);
    const booking = await seedOneToOne(
      "consultation",
      host,
      buyer,
      { startsAt, endsAt: new Date(startsAt.getTime() + HOUR_MS) },
      {
        status: "APPROVED_PENDING_PAYMENT",
        bookingSource: "REQUEST_SUBMITTED",
        isTentative: true,
        payment: { status: "PENDING" },
      },
    );
    const code = await prisma.discountCode.create({
      data: {
        code: `DBTIER-${randomUUID().slice(0, 8)}`,
        description: "db tier",
        discountType: "PERCENTAGE",
        discountValue: 10,
        maxUses: 5,
        currentUses: 1,
      },
    });
    await prisma.payment.update({
      where: { id: booking.payment!.id },
      data: { discountCodeId: code.id },
    });
    sessionUser.current = {
      id: buyer.userId,
      role: "CONSULTEE",
      consulteeProfileId: buyer.consulteeProfileId,
      consultantProfileId: null,
      name: "Buyer",
    };
    return { booking, code, payment: booking.payment! };
  }

  const usesOf = async (id: string) =>
    (await prisma.discountCode.findUniqueOrThrow({ where: { id } }))
      .currentUses;

  it("a cancel that expires the PENDING checkout gives the use back", async () => {
    const { booking, code } = await seedUnpaidWithCode();

    const res = await cancelRequest(booking.appointmentId, {
      expectedRefundPaise: 0,
      expectedPaid: false,
    });

    expect(res.status).toBe(200);
    expect(await usesOf(code.id)).toBe(0);
  });

  it("a capture that won first keeps the use", async () => {
    const { booking, code, payment } = await seedUnpaidWithCode();
    await handlePaymentSuccess(
      payment.paymentIntent,
      booking.captureMetadata,
      Number(payment.amount),
    );

    const res = await cancelRequest(booking.appointmentId, {
      expectedRefundPaise: 0,
      expectedPaid: false,
    });

    expect(res.status).toBe(409);
    expect(await usesOf(code.id)).toBe(1);
  });
});
