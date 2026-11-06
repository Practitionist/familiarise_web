/**
 * A whole-event cancel owns every seat's refund marker or commits nothing, on
 * real Postgres. A seat whose payment already owes another door's refund
 * refuses the host's cancel (409 `REFUND_IN_PROGRESS`) and the moderation
 * cancel alike, with the class, its sessions, its seats and every other seat's
 * payment untouched. Once the older refund settles, the retried cancel owes and
 * pays the remainder exactly once. A cancel whose inline drive dies after the
 * commit leaves only its own markers, which a later drive pays exactly once.
 */
import "./harness-cancel-route";
import prisma from "../../../lib/prisma";
import { seedHost } from "./harness";

import { cancelFutureEngagementsForUser } from "../../../lib/moderation/cancel-user-engagements";
import {
  driveRefundOwed,
  markerFromRow,
  REFUND_OWED_SELECT,
} from "../../../lib/payments/operations/refund-owed";
import {
  CLASS_UNDER_WAY as SHAPE,
  hostCancels,
  seatClassBuyer,
  seedClassUnderWay,
} from "./harness-class-series";
import {
  refundOnRows,
  refundedPaise,
  refundOnRowsEachTest,
} from "./harness-refunds";

const refundDoor = jest.requireMock(
  "../../../lib/payments/operations/booking-refund",
) as { refundBookingPayment: jest.Mock };

const UNIT = SHAPE.price / SHAPE.sessions;
const UNDELIVERED = UNIT * (SHAPE.sessions - SHAPE.delivered);

refundOnRowsEachTest();

const seatBuyer = (cls: { appointmentId: string }) =>
  seatClassBuyer(cls, SHAPE);

/** Another door's refund of one session, owed on the payment and still retrying. */
async function competingMarker(paymentId: string, occurrenceId: string) {
  const key = `occ:${occurrenceId}:pay:${paymentId}`;
  await prisma.payment.update({
    where: { id: paymentId },
    data: {
      refundOwedKey: key,
      refundOwedPaise: BigInt(UNIT),
      refundOwedReason: "session cancelled, no make-up",
      refundOwedAt: new Date(),
      refundOwedAttempts: 0,
    },
  });
  return key;
}

/** Drives whatever marker the payment holds now, as the retry sweep would. */
async function driveHeld(paymentId: string) {
  const row = await prisma.payment.findUniqueOrThrow({
    where: { id: paymentId },
    select: REFUND_OWED_SELECT,
  });
  const marker = markerFromRow(row);
  if (marker) await driveRefundOwed(marker);
}

const markerOf = async (paymentId: string) =>
  (
    await prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
      select: { refundOwedKey: true },
    })
  ).refundOwedKey;

/** The class, its sessions and its seats are exactly as they were before the refused cancel. */
async function expectNothingCommitted(cls: {
  classId: string;
  appointmentId: string;
}) {
  const row = await prisma.class.findUniqueOrThrow({
    where: { id: cls.classId },
    select: { status: true },
  });
  expect(row.status).toBe("SCHEDULED");
  const live = await prisma.appointmentOccurrence.count({
    where: {
      appointmentId: cls.appointmentId,
      completionStatus: "SCHEDULED",
      deletedAt: null,
    },
  });
  expect(live).toBe(SHAPE.sessions - SHAPE.delivered);
  const seated = await prisma.appointmentParticipant.count({
    where: {
      appointmentId: cls.appointmentId,
      role: "CONSULTEE",
      status: "CONFIRMED",
    },
  });
  expect(seated).toBe(2);
}

describe("a whole-event cancel against another door's refund marker", () => {
  it("refuses the host's cancel with nothing committed, then pays the remainder exactly once after the older refund settles", async () => {
    const host = await seedHost();
    const cls = await seedClassUnderWay(host, SHAPE);
    const clear = await seatBuyer(cls);
    const held = await seatBuyer(cls);
    const heldKey = await competingMarker(
      held.paymentId,
      cls.occurrenceIds[SHAPE.delivered],
    );

    const refused = await hostCancels(host, cls.appointmentId);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: "REFUND_IN_PROGRESS",
      error: expect.stringMatching(/class couldn't be cancelled yet/),
    });
    await expectNothingCommitted(cls);
    expect(await markerOf(clear.paymentId)).toBeNull();
    expect(await markerOf(held.paymentId)).toBe(heldKey);
    expect(refundDoor.refundBookingPayment).not.toHaveBeenCalled();

    // The older refund settles; the retried cancel owns both seats.
    await driveHeld(held.paymentId);
    expect(await refundedPaise(held.paymentId)).toBe(UNIT);
    expect(await markerOf(held.paymentId)).toBeNull();

    const retried = await hostCancels(host, cls.appointmentId);
    expect(retried.status).toBe(200);
    expect(await refundedPaise(clear.paymentId)).toBe(UNDELIVERED);
    // The session refunded on its own is not owed again: the remainder only.
    expect(await refundedPaise(held.paymentId)).toBe(UNDELIVERED);
    const heldRefunds = await prisma.refund.findMany({
      where: { paymentId: held.paymentId },
      select: { dedupeKey: true, amountPaise: true },
      orderBy: { createdAt: "asc" },
    });
    expect(
      heldRefunds.map((r) => [r.dedupeKey, Number(r.amountPaise)]),
    ).toEqual([
      [heldKey, UNIT],
      [`event-cancel:${cls.classId}:pay:${held.paymentId}`, UNDELIVERED - UNIT],
    ]);
    expect(await markerOf(clear.paymentId)).toBeNull();
    expect(await markerOf(held.paymentId)).toBeNull();
  });

  it("refuses the moderation cancel of the host's class with nothing committed", async () => {
    const host = await seedHost();
    await prisma.user.update({
      where: { id: host.userId },
      data: { consultantProfileId: host.consultantProfileId },
    });
    const admin = await seedHost();
    const cls = await seedClassUnderWay(host, SHAPE);
    const clear = await seatBuyer(cls);
    const held = await seatBuyer(cls);
    const heldKey = await competingMarker(
      held.paymentId,
      cls.occurrenceIds[SHAPE.delivered],
    );

    const refused = await cancelFutureEngagementsForUser(host.userId, {
      initiatedByUserId: admin.userId,
    });
    expect(refused.engagementsCancelled).toBe(0);
    expect(refused.failures).toEqual([
      expect.objectContaining({ kind: "class-event", id: cls.classId }),
    ]);
    await expectNothingCommitted(cls);
    expect(await markerOf(clear.paymentId)).toBeNull();
    expect(await markerOf(held.paymentId)).toBe(heldKey);

    await driveHeld(held.paymentId);
    const rerun = await cancelFutureEngagementsForUser(host.userId, {
      initiatedByUserId: admin.userId,
    });
    expect(rerun.engagementsCancelled).toBe(1);
    expect(rerun.failures).toEqual([]);
    expect(await markerOf(clear.paymentId)).toBeNull();
    expect(await markerOf(held.paymentId)).toBeNull();
  });

  it("a cancel whose inline drive dies after the commit leaves only its own markers, paid once by a later drive", async () => {
    const host = await seedHost();
    const cls = await seedClassUnderWay(host, SHAPE);
    const a = await seatBuyer(cls);
    const b = await seatBuyer(cls);

    refundDoor.refundBookingPayment.mockRejectedValue(
      new Error("gateway unreachable"),
    );
    const committed = await hostCancels(host, cls.appointmentId);
    expect(committed.status).toBe(200);
    for (const seat of [a, b]) {
      expect(await markerOf(seat.paymentId)).toBe(
        `event-cancel:${cls.classId}:pay:${seat.paymentId}`,
      );
      expect(await refundedPaise(seat.paymentId)).toBe(0);
    }

    refundDoor.refundBookingPayment.mockImplementation(refundOnRows);
    for (const seat of [a, b]) {
      await driveHeld(seat.paymentId);
      await driveHeld(seat.paymentId);
      expect(await refundedPaise(seat.paymentId)).toBe(UNDELIVERED);
      expect(await markerOf(seat.paymentId)).toBeNull();
    }
  });
});
