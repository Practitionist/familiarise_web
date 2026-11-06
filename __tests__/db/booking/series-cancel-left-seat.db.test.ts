/**
 * A host cancelling a class series pays each seat only what it is still owed:
 *  - a seat that already left (ladder leave, or the free leave a re-time opens)
 *    gets nothing more, whatever it was refunded on the way out;
 *  - a seat still in the class gets every undelivered session back.
 * Real Postgres, the real cancel route, a refund door that writes Refund rows.
 */
import "./harness-cancel-route";
import prisma from "../../../lib/prisma";
import { HOUR_MS, seedHost, type SeededHost } from "./harness";

import { occurrenceRefundsPaise } from "../../../lib/booking/class-series";
import { leaveEventSeat } from "../../../lib/booking/seat-leave";
import {
  CLASS_UNDER_WAY as SHAPE,
  hostCancels as cancelAsHost,
  seatClassBuyer,
  seedClassUnderWay as seedClass,
} from "./harness-class-series";
import { refundedPaise, refundOnRowsEachTest } from "./harness-refunds";

const DAY_MS = 24 * HOUR_MS;

refundOnRowsEachTest();

const seedClassUnderWay = (host: SeededHost) => seedClass(host, SHAPE);
const seatBuyer = (cls: { appointmentId: string }) =>
  seatClassBuyer(cls, SHAPE);

const leave = (classId: string, userId: string) =>
  leaveEventSeat({
    kind: "class",
    eventId: classId,
    userId,
    actorUserId: userId,
    isSelfLeave: true,
  });

async function hostCancels(host: SeededHost, appointmentId: string) {
  expect((await cancelAsHost(host, appointmentId)).status).toBe(200);
}

const UNDELIVERED =
  (SHAPE.price / SHAPE.sessions) * (SHAPE.sessions - SHAPE.delivered);

describe("series cancel after a seat already left", () => {
  it("pays a seat that left on the ladder nothing more, and a staying seat its undelivered sessions", async () => {
    const host = await seedHost();
    const cls = await seedClassUnderWay(host);
    const leaver = await seatBuyer(cls);
    const stayer = await seatBuyer(cls);

    await leave(cls.classId, leaver.userId);
    const paidOnLeave = await refundedPaise(leaver.paymentId);
    expect(paidOnLeave).toBeGreaterThan(0);
    expect(paidOnLeave).toBeLessThanOrEqual(UNDELIVERED);
    // The leave's refund counts as sessions already returned on this payment.
    expect(await occurrenceRefundsPaise(prisma, leaver.paymentId)).toBe(
      paidOnLeave,
    );

    await hostCancels(host, cls.appointmentId);

    expect(await refundedPaise(leaver.paymentId)).toBe(paidOnLeave);
    expect(await refundedPaise(stayer.paymentId)).toBe(UNDELIVERED);
    const markers = await prisma.payment.findMany({
      where: { id: { in: [leaver.paymentId, stayer.paymentId] } },
      select: { refundOwedKey: true },
    });
    expect(markers.every((m) => m.refundOwedKey === null)).toBe(true);
  });

  it("pays a seat that took the re-time free leave nothing more", async () => {
    const host = await seedHost();
    const cls = await seedClassUnderWay(host);
    const leaver = await seatBuyer(cls);
    const stayer = await seatBuyer(cls);
    // The host moved the next session an hour ago; the free leave runs two days.
    const next = await prisma.appointmentOccurrence.findFirstOrThrow({
      where: {
        appointmentId: cls.appointmentId,
        completionStatus: "SCHEDULED",
      },
      orderBy: { startsAt: "asc" },
    });
    await prisma.appointmentOccurrence.update({
      where: { id: next.id },
      data: { movedAt: new Date(Date.now() - HOUR_MS) },
    });
    await prisma.class.update({
      where: { id: cls.classId },
      data: { retimeBy: new Date(Date.now() + 2 * DAY_MS) },
    });

    await leave(cls.classId, leaver.userId);
    expect(await refundedPaise(leaver.paymentId)).toBe(UNDELIVERED);

    await hostCancels(host, cls.appointmentId);

    expect(await refundedPaise(leaver.paymentId)).toBe(UNDELIVERED);
    expect(await refundedPaise(stayer.paymentId)).toBe(UNDELIVERED);
  });
});
