/**
 * A capture blocked as a double-booking loser tombstones its own hold in the
 * capture commit, so the tentative-clear sweep can never confirm it while the
 * refund is still pending, and one overlapping row never aborts the sweep.
 */
import prisma from "../../../lib/prisma";
import {
  futureAt,
  HOUR_MS,
  overlappingOccupyingPairs,
  seedConsultee,
  seedHost,
  seedOneToOne,
} from "./harness";

// The gateway refund times out: the loser's money is owed, not yet returned.
// Every other export resolves lazily to the real module.
jest.mock("../../../lib/payments/operations/refund", () => {
  const failing = jest.fn(async () => {
    throw new Error("gateway timeout");
  });
  return new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === "__esModule") return true;
        if (prop === "refundPayment") return failing;
        return jest.requireActual("../../../lib/payments/operations/refund")[
          prop
        ];
      },
    },
  );
});

import { handlePaymentSuccess } from "../../../lib/payments/webhooks/handlers";
import { reconcileOccurrenceAvailability } from "../../../scripts/appointments/reconcile-occurrence-availability";

it("tombstones the loser's hold in the capture commit and the sweep leaves it alone", async () => {
  const host = await seedHost();
  const startsAt = futureAt(9, 11);
  const window = { startsAt, endsAt: new Date(startsAt.getTime() + HOUR_MS) };
  await seedOneToOne("subscription", host, await seedConsultee(), window, {
    status: "APPROVED",
    isTentative: false,
  });
  const loser = await seedConsultee();
  const hold = await seedOneToOne("consultation", host, loser, window, {
    status: "APPROVED_PENDING_PAYMENT",
    bookingSource: "REQUEST_SUBMITTED",
    isTentative: true,
    payment: { status: "PENDING" },
  });
  const payment = hold.payment!;

  await handlePaymentSuccess(
    payment.paymentIntent,
    hold.captureMetadata,
    Number(payment.amount),
  );

  const row = await prisma.appointmentOccurrence.findUniqueOrThrow({
    where: { id: hold.occurrenceId },
  });
  expect(row.deletedAt).not.toBeNull();
  const paid = await prisma.payment.findUniqueOrThrow({
    where: { id: payment.id },
  });
  expect(paid.paymentStatus).toBe("SUCCEEDED");
  expect(paid.description ?? "").toMatch(/^Auto-refund pending:/);

  await reconcileOccurrenceAvailability();

  const after = await prisma.appointmentOccurrence.findUniqueOrThrow({
    where: { id: hold.occurrenceId },
  });
  expect(after.isTentative).toBe(true);
  expect(await overlappingOccupyingPairs(host.consultantProfileId)).toBe(0);
});
