/**
 * An earnings write that holds for an unpaid member overage races the overage
 * failing: whichever commits first, the earnings end free once the overage no
 * longer owes the parent anything.
 */
import "./harness-cancel-route";
import prisma from "../../../lib/prisma";
import {
  futureAt,
  gate,
  HOUR_MS,
  seedConsultee,
  seedHost,
  seedOneToOne,
  untilLockWaiter,
} from "./harness";
import {
  earningsOf,
  released,
  seedUnpaidMemberOverage,
} from "./harness-overage";

const parked = { gate: null as null | ReturnType<typeof gate> };
jest.mock("../../../lib/payments/payouts/earnings-holds", () => {
  const actual = jest.requireActual(
    "../../../lib/payments/payouts/earnings-holds",
  );
  return {
    ...actual,
    // The writer parks after it has decided to hold, before it writes the hold.
    placeEarningsHolds: async (...args: unknown[]) => {
      const g = parked.gate;
      parked.gate = null;
      if (g) await g.park();
      return actual.placeEarningsHolds(...args);
    },
  };
});

import { handleOverageMemberFailure } from "../../../lib/payments/webhooks/overage-handlers";
import {
  createEarningsFromPayment,
  resolvePaymentForEarnings,
} from "../../../lib/payments/payouts";

it("an overage failing while the earnings writer holds for it leaves the earnings free", async () => {
  const host = await seedHost();
  const buyer = await seedConsultee();
  const startsAt = futureAt(4, 9);
  const booking = await seedOneToOne(
    "consultation",
    host,
    buyer,
    { startsAt, endsAt: new Date(startsAt.getTime() + HOUR_MS) },
    {
      status: "APPROVED",
      isTentative: false,
      payment: { status: "SUCCEEDED", expiresAt: null },
    },
  );
  const parent = booking.payment!;
  const side = await seedUnpaidMemberOverage(parent, buyer.userId);
  const resolved = await resolvePaymentForEarnings(
    { id: parent.id },
    "CONSULTATION",
  );

  parked.gate = gate();
  const writerGate = parked.gate;
  // The deferred writer (the capture's post-commit retry, the heal sweep).
  const writer = createEarningsFromPayment({
    payment: resolved!.paymentForEarnings,
    appointmentType: resolved!.earningsAppointmentType,
    teamAt: parent.createdAt,
  });
  await writerGate.arrived;
  const failure = handleOverageMemberFailure(side.paymentIntent);
  // Either the failure finishes on its own or it waits behind the writer.
  const waiter = untilLockWaiter(3_000).catch(() => undefined);
  await Promise.race([failure, waiter]);
  writerGate.open();
  await Promise.all([writer, failure, waiter]);

  expect(
    (
      await prisma.overageEvent.findFirstOrThrow({
        where: { paymentId: side.id },
      })
    ).chargeStatus,
  ).toBe("FAILED");
  const earnings = await earningsOf(parent.id);
  expect(earnings).toHaveLength(1);
  expect(earnings[0]).toMatchObject(released);
});
