/**
 * @jest-environment node
 */

// The rating prompt settles at most one of the learner's ended rooms per page
// load, only one already past its rejoin grace, and within one deadline.
const findMany = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { meeting: { findMany: (...a: unknown[]) => findMany(...a) } },
}));
const settle = jest.fn(async () => ({ kind: "unavailable" }));
jest.mock("../../lib/meetings/settle-attendance", () => ({
  ...jest.requireActual("../../lib/meetings/settle-attendance"),
  settleOccurrenceAttendance: (...a: unknown[]) => settle(...(a as [])),
}));

import {
  ON_DEMAND_SETTLE_BUDGET_MS,
  settleRecentAttendance,
} from "@/lib/reviews";

it("reads one ended room past its rejoin grace and settles it", async () => {
  const now = new Date("2026-11-23T07:00:00Z");
  const endsAt = new Date("2026-11-23T05:30:00Z");
  const meeting = {
    id: "m-1",
    streamCallId: "occurrence-occ-1",
    extendedSeconds: 0,
    attendanceSettledAt: null,
  };
  findMany.mockResolvedValue([
    { ...meeting, occurrence: { id: "occ-1", endsAt } },
  ]);

  const before = Date.now();
  await settleRecentAttendance("learner-1", "apt-1", now);

  const [query] = findMany.mock.calls[0];
  expect(query.take).toBe(1);
  expect(query.where).toMatchObject({
    endedAt: { not: null },
    attendanceSettledAt: null,
    occurrence: {
      appointmentId: "apt-1",
      endsAt: { lt: new Date("2026-11-23T06:30:00Z") },
      appointment: { participants: { some: { userId: "learner-1" } } },
    },
  });
  // One deadline bounds the whole Stream read, leaving the request time for its own queries.
  const [target, opts] = settle.mock.calls[0] as unknown as [
    unknown,
    { now: Date; deadlineAt: number },
  ];
  expect(target).toEqual({ occurrenceId: "occ-1", endsAt, meeting });
  expect(opts.now).toBe(now);
  expect(opts.deadlineAt).toBeGreaterThanOrEqual(
    before + ON_DEMAND_SETTLE_BUDGET_MS,
  );
  expect(opts.deadlineAt).toBeLessThanOrEqual(
    Date.now() + ON_DEMAND_SETTLE_BUDGET_MS,
  );
});
