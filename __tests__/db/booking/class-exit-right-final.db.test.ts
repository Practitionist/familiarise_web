/**
 * The class exit right is derived from the misses, so an ops correction that
 * removes a miss (an un-void of a session that was not the host's fault) can
 * withdraw a right the learner has not used yet. A right already used is final:
 * the learner's exit refund stays, and a replayed exit is a no-op rather than a
 * fresh check. Real Postgres, the real seat-leave door.
 */
import prisma from "../../../lib/prisma";
import { HOUR_MS, seedHost } from "./harness";

jest.mock("../../../lib/auth-helpers", () =>
  jest.requireActual("./harness-session").authAsSessionUser(),
);
jest.mock("../../../lib/rate-limit", () =>
  jest.requireActual("./harness-session").rateLimitOff(),
);
jest.mock("../../../lib/novu", () =>
  jest.requireActual("../../fixtures/noop-module").noopModule(),
);
jest.mock("../../../lib/stream/access-revocation", () =>
  jest.requireActual("../../fixtures/noop-module").noopModule(),
);

import { leaveEventSeat } from "../../../lib/booking/seat-leave";
import {
  seatClassBuyer,
  seedClassUnderWay,
  type ClassShape,
} from "./harness-class-series";
import { refundOnRows, refundedPaise } from "./harness-refunds";

const refundDoor = jest.requireMock(
  "../../../lib/payments/operations/booking-refund",
) as { refundBookingPayment: jest.Mock };

/** Ten sessions at ₹100, three already delivered: the exit right needs 3 misses. */
const SHAPE: ClassShape = { price: 10_000, sessions: 10, delivered: 3 };

beforeEach(() => {
  refundDoor.refundBookingPayment.mockReset();
  refundDoor.refundBookingPayment.mockImplementation(refundOnRows);
});

const exit = (classId: string, userId: string) =>
  leaveEventSeat({
    kind: "class",
    eventId: classId,
    userId,
    actorUserId: userId,
    isSelfLeave: true,
    exit: true,
  });

it("an ops un-void withdraws an unused exit right; a used one stays final", async () => {
  const host = await seedHost();
  const cls = await seedClassUnderWay(host, SHAPE);
  const used = await seatClassBuyer(cls, SHAPE);
  const unused = await seatClassBuyer(cls, SHAPE);
  // Three upcoming sessions voided as host-absent within the last three days.
  const voided = cls.occurrenceIds.slice(SHAPE.delivered, SHAPE.delivered + 3);
  for (const [i, id] of voided.entries()) {
    await prisma.appointmentOccurrence.update({
      where: { id },
      data: {
        completionStatus: "VOIDED",
        voidedAt: new Date(Date.now() - (i + 1) * 24 * HOUR_MS),
        outcome: "HOST_ABSENT",
      },
    });
  }

  expect(await exit(cls.classId, used.userId)).not.toBeNull();
  const paidOnExit = await refundedPaise(used.paymentId);
  expect(paidOnExit).toBeGreaterThan(0);

  // Ops overturns one void: the session was held after all.
  await prisma.appointmentOccurrence.update({
    where: { id: voided[2] },
    data: { completionStatus: "COMPLETED", voidedAt: null, outcome: "HELD" },
  });

  await expect(exit(cls.classId, unused.userId)).rejects.toMatchObject({
    code: "EXIT_NOT_AVAILABLE",
  });
  expect(await refundedPaise(unused.paymentId)).toBe(0);

  // The used right is not re-checked: a replay finds no seat and moves nothing.
  expect(await exit(cls.classId, used.userId)).toBeNull();
  expect(await refundedPaise(used.paymentId)).toBe(paidOnExit);
});

