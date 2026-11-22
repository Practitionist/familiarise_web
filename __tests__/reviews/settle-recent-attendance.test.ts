/**
 * @jest-environment node
 */

// The rating prompt settles at most one of the learner's ended rooms per page
// load, and only one already past its rejoin grace, so a Stream outage costs a
// page one read at most.
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

import { settleRecentAttendance } from "@/lib/reviews";

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
  expect(settle).toHaveBeenCalledWith(
    { occurrenceId: "occ-1", endsAt, meeting },
    { now },
  );
});
