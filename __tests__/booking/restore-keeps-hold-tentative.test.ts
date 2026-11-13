/**
 * @jest-environment node
 */

// Invariant: a restore puts each released session back as the release found
// it — an unpaid hold stays tentative, a confirmed session comes back firm.

const transitionOccurrenceCompletion = jest.fn(
  async (_tx: unknown, args: { where: { id: { in: string[] } } }) =>
    args.where.id.in.length,
);
jest.mock("../../lib/booking/transitions", () => ({
  ...jest.requireActual("../../lib/booking/transitions"),
  transitionOccurrenceCompletion: (tx: unknown, args: never) =>
    transitionOccurrenceCompletion(tx, args),
}));
jest.mock("../../lib/payments/payouts/earnings-hold", () => ({
  restoreEarningsHold: jest.fn(),
}));

import { restoreRescheduledBooking } from "@/lib/booking/reschedule-restore";
import type { Tx } from "@/lib/prisma";

it("restores the hold tentative and the confirmed session firm", async () => {
  const tx = {
    rescheduleRequest: {
      findUnique: jest.fn(async () => ({
        releasedSessions: [
          { ordinal: 1, startsAt: "2030-01-01T10:00:00.000Z" },
          {
            ordinal: 2,
            startsAt: "2030-01-08T10:00:00.000Z",
            tentative: true,
          },
        ],
      })),
      updateMany: jest.fn(),
    },
  };

  const restored = await restoreRescheduledBooking(
    tx as unknown as Tx,
    {
      id: "req-1",
      appointmentId: "appt-1",
      createdAt: new Date(),
      originStatus: null,
      releasedOccurrenceIds: ["firm-1", "hold-2"],
      appointment: null,
    },
    { actorUserId: "u-1", reason: "reschedule withdrawn", op: "test" },
  );

  expect(restored).toBe(2);
  expect(
    transitionOccurrenceCompletion.mock.calls.map(([, args]) => args),
  ).toEqual([
    expect.objectContaining({
      where: { id: { in: ["firm-1"] } },
      data: { isTentative: false },
    }),
    expect.objectContaining({
      where: { id: { in: ["hold-2"] } },
      data: { isTentative: true },
    }),
  ]);
});
