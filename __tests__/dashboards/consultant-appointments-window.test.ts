/**
 * @jest-environment node
 */

/**
 * #1703 B12 — the consultant Appointments read is bounded by default (last 12
 * months + future + unscheduled), unbounded on `window: "all"`, and never
 * bounded when an event id or a date range already narrows it.
 */

import prisma from "@/lib/prisma";
import { getConsultantAppointments } from "@/lib/data/consultant-appointments";
import { recentWindowStart } from "@/lib/appointments/window";

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { appointment: { findMany: jest.fn() } },
}));

const findMany = prisma.appointment.findMany as jest.Mock;

const base = {
  consultantProfileId: "cp-1",
  scope: { kind: "personal" } as const,
};

describe("consultant appointments window", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    findMany.mockResolvedValue([]);
  });

  it("bounds the default read to the recent window plus rows with no live occurrence", async () => {
    await getConsultantAppointments(base);
    const where = findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([
      {
        occurrences: {
          some: { deletedAt: null, endsAt: { gte: expect.any(Date) } },
        },
      },
      // `none: {}` dropped a row whose only occurrences were soft-deleted.
      { occurrences: { none: { deletedAt: null } } },
    ]);
    const gte: Date = where.OR[0].occurrences.some.endsAt.gte;
    expect(
      Math.abs(gte.getTime() - recentWindowStart().getTime()),
    ).toBeLessThan(60_000);
  });

  it("leaves 'all' and event-scoped reads unbounded", async () => {
    await getConsultantAppointments({ ...base, window: "all" });
    expect(findMany.mock.calls[0][0].where.OR).toBeUndefined();

    await getConsultantAppointments({
      ...base,
      eventIds: { subscriptionId: "sub-1" },
    });
    expect(findMany.mock.calls[1][0].where.OR).toBeUndefined();
  });
});
