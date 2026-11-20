/**
 * @jest-environment node
 */

/**
 * Home's "sessions delivered" counts a session exactly when the plan's
 * entitlement counts it as delivered: confirmed, or past and parked for a
 * human. A voided, cancelled, released or still-scheduled session is not one.
 */

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { appointmentOccurrence: { count: jest.fn() } },
}));

import prisma from "@/lib/prisma";
import { isCompletedOccurrence } from "@/lib/booking/entitlement";
import { readSessionsDelivered } from "@/lib/data/consultant-needs-you";

const count = prisma.appointmentOccurrence.count as jest.Mock;
const ALL_STATUSES = [
  "SCHEDULED",
  "COMPLETED",
  "UNVERIFIED",
  "CANCELLED",
  "RESCHEDULED",
  "VOIDED",
];

it("counts the statuses the entitlement counts as delivered, this month and in all", async () => {
  count.mockResolvedValueOnce(9).mockResolvedValueOnce(4);
  const startOfMonth = new Date("2026-11-01T00:00:00.000Z");
  await expect(readSessionsDelivered("cp-1", startOfMonth)).resolves.toEqual({
    lifetime: 9,
    thisMonth: 4,
  });
  expect(count).toHaveBeenCalledTimes(2);
  for (const [{ where }] of count.mock.calls) {
    const counted: string[] = where.completionStatus.in;
    expect([...counted].sort()).toEqual(
      ALL_STATUSES.filter((completionStatus) =>
        isCompletedOccurrence({ completionStatus }),
      ).sort(),
    );
    expect(where.deletedAt).toBeNull();
  }
  expect(count.mock.calls[1][0].where.startsAt).toEqual({ gte: startOfMonth });
});
