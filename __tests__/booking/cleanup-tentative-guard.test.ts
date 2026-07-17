/**
 * @jest-environment node
 */

/**
 * #829 — the tentative-slot cleanup must never delete a slot that was
 * confirmed (or paid) between its scan and its delete. The delete's WHERE
 * re-states isTentative + no-SUCCEEDED-payment, so a concurrent capture
 * webhook's flip makes the row stop matching (re-evaluated under the row
 * lock) instead of being destroyed.
 */

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    slotOfAppointment: {
      findMany: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    $disconnect: jest.fn(),
  },
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: jest.fn((_j: string, _o: unknown, fn: () => unknown) => fn()),
  CronLockHeldError: class CronLockHeldError extends Error {},
  CronLockUnavailableError: class CronLockUnavailableError extends Error {},
  LONG_JOB_TTL_MS: 35 * 60 * 1000,
}));

import prisma from "../../lib/prisma";
import { cleanupTentativeSlots } from "@/scripts/appointments/cleanup-tentative-slots";

const mocked = prisma as unknown as {
  slotOfAppointment: { findMany: jest.Mock; deleteMany: jest.Mock };
};

beforeEach(() => jest.clearAllMocks());

describe("#829 — cleanup delete re-states the tentative + unpaid guards", () => {
  it("carries isTentative + no-SUCCEEDED-payment in the deleteMany WHERE", async () => {
    mocked.slotOfAppointment.findMany.mockResolvedValue([
      {
        id: "slot-1",
        appointmentId: "appt-1",
        createdAt: new Date("2026-05-01T00:00:00Z"),
        updatedAt: new Date("2026-05-01T00:00:00Z"),
        startsAt: new Date("2026-05-02T10:00:00Z"),
        endsAt: new Date("2026-05-02T11:00:00Z"),
        appointment: { payment: [], consultation: null, subscription: null },
      },
    ]);
    mocked.slotOfAppointment.deleteMany.mockResolvedValue({ count: 1 });

    await cleanupTentativeSlots();

    expect(mocked.slotOfAppointment.deleteMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: { in: ["slot-1"] },
        isTentative: true,
        appointment: {
          payment: { none: { paymentStatus: "SUCCEEDED" } },
        },
      }),
    });
  });

  it("deletes nothing when the scan finds nothing", async () => {
    mocked.slotOfAppointment.findMany.mockResolvedValue([]);
    await cleanupTentativeSlots();
    expect(mocked.slotOfAppointment.deleteMany).not.toHaveBeenCalled();
  });
});
