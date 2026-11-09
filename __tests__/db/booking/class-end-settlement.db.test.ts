/**
 * Class-end settlement on real Postgres: a class sold as 10 sessions that
 * completes with only 8 placed stamps each live card seat owed exactly the
 * 2 unplaced sessions in the completing commit, holds its earnings behind the
 * marker, and a re-run never stamps or refunds twice.
 */
import prisma from "../../../lib/prisma";
import { seedHost } from "./harness";

jest.mock("../../../lib/novu", () =>
  jest.requireActual("../../fixtures/noop-module").noopModule(),
);
jest.mock("../../../lib/novu/service", () =>
  jest.requireActual("../../fixtures/noop-module").noopModule(),
);
jest.mock("../../../lib/novu/stage-then-attempt", () => ({
  __esModule: true,
  flushNotificationsAfter: jest.fn(async () => undefined),
}));
jest.mock("../../../lib/booking/session-outcome-sweep", () => ({
  ...jest.requireActual("../../../lib/booking/session-outcome-sweep"),
  alertStaleNeedsHuman: jest.fn(async () => undefined),
}));

import { autoCompleteAppointments } from "../../../scripts/appointments/auto-complete-appointments";
import {
  driveRefundOwed,
  markerFromRow,
  REFUND_OWED_SELECT,
} from "../../../lib/payments/operations/refund-owed";
import { seatClassBuyer, seedClassUnderWay } from "./harness-class-series";
import { refundedPaise, refundOnRowsEachTest } from "./harness-refunds";

refundOnRowsEachTest();

const SHAPE = { price: 10_000, sessions: 10, delivered: 8 };

/** A class sold as 10 sessions whose 8 placed sessions all ran (10 to 3 days ago); 2 were never placed. */
async function seedShortClass() {
  const host = await seedHost();
  const cls = await seedClassUnderWay(host, SHAPE);
  // Drop the two future rows the seed placed: those sessions were never scheduled.
  await prisma.appointmentOccurrence.deleteMany({
    where: { appointmentId: cls.appointmentId, completionStatus: "SCHEDULED" },
  });
  return cls;
}

describe("class-end settlement", () => {
  it("stamps 2,000 paise per ₹100 seat in the completing commit and refunds it once", async () => {
    const cls = await seedShortClass();
    const a = await seatClassBuyer(cls, SHAPE);
    const b = await seatClassBuyer(cls, SHAPE);

    await autoCompleteAppointments({ startedAt: Date.now() });

    const done = await prisma.class.findUniqueOrThrow({
      where: { id: cls.classId },
      select: { status: true },
    });
    expect(done.status).toBe("COMPLETED");
    for (const seat of [a, b]) {
      const row = await prisma.payment.findUniqueOrThrow({
        where: { id: seat.paymentId },
        select: REFUND_OWED_SELECT,
      });
      expect(row.refundOwedKey).toBe(
        `class-end:${cls.classId}:pay:${seat.paymentId}`,
      );
      expect(Number(row.refundOwedPaise)).toBe(2_000);
      const marker = markerFromRow(row);
      expect(marker).not.toBeNull();
      if (marker) await driveRefundOwed(marker);
      expect(await refundedPaise(seat.paymentId)).toBe(2_000);
    }

    // A second run finds the class COMPLETED: no new marker, no second refund.
    await autoCompleteAppointments({ startedAt: Date.now() });
    for (const seat of [a, b]) {
      const row = await prisma.payment.findUniqueOrThrow({
        where: { id: seat.paymentId },
        select: { refundOwedKey: true },
      });
      expect(row.refundOwedKey).toBeNull();
      expect(await refundedPaise(seat.paymentId)).toBe(2_000);
    }
  });

  it("stamps nothing for a class whose every sold session was placed", async () => {
    const host = await seedHost();
    // All ten sessions were held, ten days ago through yesterday.
    const cls = await seedClassUnderWay(host, { ...SHAPE, delivered: 10 });
    const seat = await seatClassBuyer(cls, SHAPE);

    await autoCompleteAppointments({ startedAt: Date.now() });

    const row = await prisma.payment.findUniqueOrThrow({
      where: { id: seat.paymentId },
      select: { refundOwedKey: true },
    });
    expect(row.refundOwedKey).toBeNull();
    expect(await refundedPaise(seat.paymentId)).toBe(0);
  });
});
