/**
 * Re-timing a published webinar on the database: the session moves in place
 * and is stamped as moved, the free-leave deadline opens, an attendee busy at
 * the new time is flagged without blocking the move, a host busy then refuses
 * it, and the attendee's leave in that window refunds in full.
 */
import prisma from "../../../lib/prisma";
import {
  HOUR_MS,
  futureAt,
  seedConsultee,
  seedHost,
  seedOneToOne,
} from "./harness";
import { seedHeldSeat, seedWebinar } from "./harness-seats";

jest.mock("../../../lib/novu/service", () => {
  const noop = jest.fn(async () => []);
  return new Proxy(
    {},
    { get: (_target, prop) => (prop === "__esModule" ? true : noop) },
  );
});

import { notifyAppointmentRescheduled } from "../../../lib/novu/service";
import { retimeWebinar } from "../../../lib/booking/event-retime";
import { BookingRuleError } from "../../../lib/booking/booking-rule-error";
import { inRetimeFreeLeave } from "../../../lib/booking/retime-leave";
import { quoteSeatLeave } from "../../../lib/booking/seat-leave";

describe("webinar re-time", () => {
  it("moves the session in place, flags a busy attendee and opens the free leave", async () => {
    const webinar = await seedWebinar({
      capacity: 20,
      startsAt: futureAt(6, 9),
    });
    const { buyer } = await seedHeldSeat(webinar, {
      status: "SUCCEEDED",
      expiresAt: null,
    });
    const newStart = futureAt(9, 14);
    // The attendee already has a 1:1 with another expert at the new time.
    const other = await seedHost();
    const profile = await prisma.consulteeProfile.findUniqueOrThrow({
      where: { userId: buyer.userId },
      select: { id: true },
    });
    await seedOneToOne(
      "consultation",
      other,
      { userId: buyer.userId, consulteeProfileId: profile.id },
      { startsAt: newStart, endsAt: new Date(newStart.getTime() + HOUR_MS) },
      {
        status: "APPROVED",
        isTentative: false,
        payment: { status: "SUCCEEDED", expiresAt: null },
      },
    );

    const before = await prisma.appointmentOccurrence.findFirstOrThrow({
      where: { appointmentId: webinar.appointmentId },
    });
    const result = await retimeWebinar({
      appointmentId: webinar.appointmentId,
      startsAt: newStart,
      actorUserId: webinar.host.userId,
    });
    expect(result.attendeesWithClash).toBe(1);

    const after = await prisma.appointmentOccurrence.findMany({
      where: { appointmentId: webinar.appointmentId },
    });
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before.id);
    expect(after[0].startsAt).toEqual(newStart);
    expect(after[0].endsAt).toEqual(new Date(newStart.getTime() + HOUR_MS));
    expect(after[0].movedAt).not.toBeNull();
    const event = await prisma.webinar.findUniqueOrThrow({
      where: { id: webinar.webinarId },
      select: { retimeBy: true },
    });
    expect(event.retimeBy).toEqual(result.retimeBy);
    expect(result.retimeBy.getTime()).toBeLessThanOrEqual(newStart.getTime());

    // The busy attendee's notice is flagged and names the free-leave deadline,
    // staged in the move's transaction.
    expect(notifyAppointmentRescheduled).toHaveBeenCalledWith(
      [buyer.userId],
      expect.objectContaining({
        outcome: "MOVED",
        clash: true,
        leaveBy: result.retimeBy.toISOString(),
      }),
      expect.objectContaining({ deferAttempt: true, tx: expect.anything() }),
    );

    // A seat bought before the move is inside the free leave.
    await prisma.$transaction(async (tx) => {
      expect(
        await inRetimeFreeLeave(
          tx,
          "webinar",
          webinar.webinarId,
          new Date(Date.now() - HOUR_MS),
          new Date(),
        ),
      ).toBe(true);
    });
  });

  it("re-times a 200-seat webinar inside its transaction deadline", async () => {
    const webinar = await seedWebinar({
      capacity: 250,
      startsAt: futureAt(6, 9),
    });
    const seats = [];
    for (let i = 0; i < 200; i += 1) {
      seats.push(
        await seedHeldSeat(webinar, { status: "SUCCEEDED", expiresAt: null }),
      );
    }
    const newStart = futureAt(9, 16);
    const busy = seats[17].buyer;
    const profile = await prisma.consulteeProfile.findUniqueOrThrow({
      where: { userId: busy.userId },
      select: { id: true },
    });
    await seedOneToOne(
      "consultation",
      await seedHost(),
      { userId: busy.userId, consulteeProfileId: profile.id },
      { startsAt: newStart, endsAt: new Date(newStart.getTime() + HOUR_MS) },
      {
        status: "APPROVED",
        isTentative: false,
        payment: { status: "SUCCEEDED", expiresAt: null },
      },
    );
    jest.mocked(notifyAppointmentRescheduled).mockClear();

    const result = await retimeWebinar({
      appointmentId: webinar.appointmentId,
      startsAt: newStart,
      actorUserId: webinar.host.userId,
    });

    expect(result.attendeesWithClash).toBe(1);
    const notified = jest
      .mocked(notifyAppointmentRescheduled)
      .mock.calls.map(([userIds, payload]) => ({
        count: userIds.length,
        clash: payload.outcome === "MOVED" ? payload.clash : undefined,
      }));
    expect(notified).toEqual(
      expect.arrayContaining([
        { count: 1, clash: true },
        { count: 199, clash: false },
      ]),
    );
  }, 120_000);

  it("frees the leave until retimeBy, then the refund window applies again", async () => {
    const webinar = await seedWebinar({
      capacity: 20,
      startsAt: futureAt(3, 9),
    });
    // The whole run sits inside the plan's refund window.
    await prisma.webinarPlan.update({
      where: { id: webinar.planId },
      data: { refundWindowHours: 400 },
    });
    const { buyer } = await seedHeldSeat(webinar, {
      status: "SUCCEEDED",
      expiresAt: null,
    });
    const moved = await retimeWebinar({
      appointmentId: webinar.appointmentId,
      startsAt: futureAt(5, 10),
      actorUserId: webinar.host.userId,
    });

    // Checkout began before the move and captured after it: the seat row is
    // newer than the move, the order is not.
    const late = await seedHeldSeat(webinar, {
      status: "SUCCEEDED",
      expiresAt: null,
    });
    await prisma.payment.update({
      where: { id: late.payment.id },
      data: { createdAt: new Date(Date.now() - 2 * HOUR_MS) },
    });

    for (const userId of [buyer.userId, late.buyer.userId]) {
      expect(
        await quoteSeatLeave("webinar", webinar.webinarId, userId),
      ).toMatchObject({ seated: true, refused: false });
    }

    await prisma.webinar.update({
      where: { id: webinar.webinarId },
      data: { retimeBy: new Date(Date.now() - 60_000) },
    });
    expect(moved.retimeBy.getTime()).toBeGreaterThan(Date.now());
    expect(
      await quoteSeatLeave("webinar", webinar.webinarId, buyer.userId),
    ).toMatchObject({ seated: true, refused: true });
  });

  it("refuses a time the host is already booked for, and leaves the session where it was", async () => {
    const webinar = await seedWebinar({
      capacity: 20,
      startsAt: futureAt(6, 9),
    });
    const clash = futureAt(10, 11);
    const client = await seedConsultee();
    await seedOneToOne(
      "consultation",
      webinar.host,
      client,
      { startsAt: clash, endsAt: new Date(clash.getTime() + HOUR_MS) },
      {
        status: "APPROVED",
        isTentative: false,
        payment: { status: "SUCCEEDED", expiresAt: null },
      },
    );
    await expect(
      retimeWebinar({
        appointmentId: webinar.appointmentId,
        startsAt: clash,
        actorUserId: webinar.host.userId,
      }),
    ).rejects.toBeInstanceOf(BookingRuleError);
    const row = await prisma.appointmentOccurrence.findFirstOrThrow({
      where: { appointmentId: webinar.appointmentId },
    });
    expect(row.startsAt).toEqual(webinar.startsAt);
    expect(row.movedAt).toBeNull();
  });

  it("refuses a move inside 24 hours of the new time", async () => {
    const webinar = await seedWebinar({
      capacity: 20,
      startsAt: futureAt(6, 9),
    });
    const soon = new Date(
      Math.ceil((Date.now() + 3 * HOUR_MS) / HOUR_MS) * HOUR_MS,
    );
    await expect(
      retimeWebinar({
        appointmentId: webinar.appointmentId,
        startsAt: soon,
        actorUserId: webinar.host.userId,
      }),
    ).rejects.toMatchObject({ code: "RETIME_TOO_SOON" });
  });
});
