/**
 * @jest-environment node
 */

// Invariant: after a re-plan or a move, a class's stored scheduling period
// starts at its first live session and reaches at least its last.

jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

import { followClassSessions } from "@/lib/booking/allocation/event-data";
import type { Tx } from "@/lib/prisma";

it("moves the period start to the first live session and widens its end", async () => {
  const first = new Date("2030-02-14T15:00:00.000Z");
  const last = new Date("2030-03-20T16:00:00.000Z");
  const updateMany = jest.fn().mockResolvedValue({ count: 1 });
  const tx = {
    appointmentOccurrence: {
      findFirst: jest
        .fn()
        .mockResolvedValueOnce({ startsAt: first })
        .mockResolvedValueOnce({ endsAt: last }),
    },
    class: { updateMany },
  };

  await followClassSessions(tx as unknown as Tx, "class-1");

  expect(updateMany).toHaveBeenNthCalledWith(1, {
    where: { id: "class-1" },
    data: { schedulingPeriodStartsAt: first },
  });
  expect(updateMany).toHaveBeenNthCalledWith(2, {
    where: {
      id: "class-1",
      OR: [
        { schedulingPeriodEndsAt: null },
        { schedulingPeriodEndsAt: { lt: last } },
      ],
    },
    data: { schedulingPeriodEndsAt: last },
  });
});
