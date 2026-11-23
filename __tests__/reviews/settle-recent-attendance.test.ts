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

it("reads one room ended six hours ago and settles it", async () => {
  const now = new Date("2026-11-23T12:00:00Z");
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
  await settleRecentAttendance("learner-1", { appointmentId: "apt-1" }, now);

  const [query] = findMany.mock.calls[0];
  expect(query.take).toBe(5);
  expect(query.where).toMatchObject({
    endedAt: { not: null },
    attendanceSettledAt: null,
    occurrence: {
      appointmentId: "apt-1",
      endsAt: { lt: new Date("2026-11-23T06:00:00Z") },
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

it("passes over an extended room not yet readable, and scopes to a named session", async () => {
  settle.mockClear();
  const now = new Date("2026-11-23T12:00:00Z");
  const extended = {
    id: "m-new",
    streamCallId: "occurrence-new",
    // Booked end 05:50 plus 15 minutes: readable only from 12:05.
    extendedSeconds: 900,
    attendanceSettledAt: null,
    occurrence: { id: "occ-new", endsAt: new Date("2026-11-23T05:50:00Z") },
  };
  const ready = {
    id: "m-old",
    streamCallId: "occurrence-old",
    extendedSeconds: 0,
    attendanceSettledAt: null,
    occurrence: { id: "occ-old", endsAt: new Date("2026-11-23T05:00:00Z") },
  };
  findMany.mockResolvedValue([extended, ready]);

  await settleRecentAttendance(
    "learner-1",
    { appointmentId: "apt-1", occurrenceId: "occ-old" },
    now,
  );

  expect(findMany.mock.calls.at(-1)[0].where.occurrence).toMatchObject({
    appointmentId: "apt-1",
    id: "occ-old",
  });
  expect(settle).toHaveBeenCalledTimes(1);
  expect(settle.mock.calls[0]).toEqual([
    expect.objectContaining({ occurrenceId: "occ-old" }),
    expect.anything(),
  ]);
});
