/**
 * @jest-environment node
 */

/**
 * A host-cancelled class session keeps its row (no deletedAt) for make-up and refund
 * accounting, but its time is free, so the grid paints it available.
 */

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $queryRaw: jest.fn(),
    consultantProfile: { findUnique: jest.fn(), count: jest.fn() },
    appointment: { findMany: jest.fn() },
    membership: { findFirst: jest.fn() },
  },
}));
jest.mock("../../lib/auth-server", () => ({
  __esModule: true,
  getSession: jest.fn(async () => null),
}));

import { NextRequest } from "next/server";
import { DayOfWeek } from "@prisma/client";
import { GET } from "../../app/api/scheduling/availability-with-allocation/[consultantId]/route";
import prisma from "@/lib/prisma";
import { OCCUPYING_OCCURRENCE_WHERE } from "@/utils/scheduling-engine/occupancyPolicy";
import { makeWeeklyAvailabilitySlot } from "../fixtures/booking.mockData";

type Row = Record<string, unknown>;

/** Just enough of Prisma's where semantics for the occurrence clauses the grid sends. */
function matches(where: Row, row: Row): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === "AND") return (cond as Row[]).every((c) => matches(c, row));
    if (key === "OR") return (cond as Row[]).some((c) => matches(c, row));
    const value = row[key];
    if (cond === null) return value === null || value === undefined;
    if (typeof cond !== "object" || cond instanceof Date) return value === cond;
    const ops = cond as Record<string, unknown>;
    const t = value instanceof Date ? value.getTime() : value;
    const ms = (v: unknown) => (v instanceof Date ? v.getTime() : v);
    return (
      (!("not" in ops) || value !== ops.not) &&
      (!("lt" in ops) || (t as number) < (ms(ops.lt) as number)) &&
      (!("lte" in ops) || (t as number) <= (ms(ops.lte) as number)) &&
      (!("gt" in ops) || (t as number) > (ms(ops.gt) as number)) &&
      (!("gte" in ops) || (t as number) >= (ms(ops.gte) as number))
    );
  });
}

const CONSULTANT_ID = "consultant-1";
const session = (completion: "SCHEDULED" | "CANCELLED") => ({
  id: "occ-1",
  startsAt: new Date("2026-09-07T10:00:00.000Z"),
  endsAt: new Date("2026-09-07T11:00:00.000Z"),
  deletedAt: null,
  completionStatus: completion,
  hostCancelledAt:
    completion === "CANCELLED" ? new Date("2026-09-01T09:00:00.000Z") : null,
});

async function gridFor(completion: "SCHEDULED" | "CANCELLED") {
  const appointment = {
    id: "apt-class",
    class: { status: "SCHEDULED" },
    payment: [],
    occurrences: [session(completion)],
  };
  (prisma.appointment.findMany as jest.Mock).mockImplementation(
    async (args: { include?: { occurrences?: { where?: Row } } }) => {
      const where = args.include?.occurrences?.where ?? {};
      const occurrences = appointment.occurrences.filter((o) =>
        matches(where, o),
      );
      return occurrences.length > 0 ? [{ ...appointment, occurrences }] : [];
    },
  );
  const res = await GET(
    new NextRequest(
      `https://x.test/api/scheduling/availability-with-allocation/${CONSULTANT_ID}?startDateInUtc=2026-09-07T00:00:00.000Z&endDateInUtc=2026-09-08T00:00:00.000Z&timezone=UTC`,
    ),
    { params: Promise.resolve({ consultantId: CONSULTANT_ID }) },
  );
  const { data } = await res.json();
  return (data["2026-09-07"] as Row[]).filter(
    (s) => s.startsAt === "2026-09-07T10:00:00.000Z",
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  (prisma.$queryRaw as jest.Mock).mockResolvedValue([
    { profileUpdatedAt: new Date(), slotRowCount: 1, scheduleType: "WEEKLY" },
  ]);
  (prisma.consultantProfile.findUnique as jest.Mock).mockResolvedValue({
    id: CONSULTANT_ID,
    userId: "user-consultant",
    scheduleType: "WEEKLY",
    availabilityWindowsWeekly: [
      makeWeeklyAvailabilitySlot(DayOfWeek.MONDAY, 9, 12),
    ],
    availabilityWindowsCustom: [],
  });
});

it("the shared clause drops a host-cancelled row and keeps a RESCHEDULED hold", () => {
  expect(matches(OCCUPYING_OCCURRENCE_WHERE, session("CANCELLED"))).toBe(false);
  expect(matches(OCCUPYING_OCCURRENCE_WHERE, session("SCHEDULED"))).toBe(true);
  expect(
    matches(OCCUPYING_OCCURRENCE_WHERE, {
      ...session("SCHEDULED"),
      completionStatus: "RESCHEDULED",
    }),
  ).toBe(true);
});

it("the grid paints a host-cancelled session's time available, a live one booked", async () => {
  expect(await gridFor("CANCELLED")).toEqual([
    expect.objectContaining({ isAllocated: false, bookingStatus: "available" }),
  ]);
  expect(await gridFor("SCHEDULED")).toEqual([
    expect.objectContaining({ isAllocated: true }),
  ]);
});
