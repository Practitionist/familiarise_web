/**
 * @jest-environment node
 */

/**
 * The availability grid fed rows the database should never hold: an inverted
 * session, a multi-year one, off-grid ones and a 10k-session series. The route
 * answers 200, paints off-grid time on whole atoms without double-painting,
 * bounds a multi-year row to the window, and reports the impossible rows once
 * per request instead of once per row.
 */

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $queryRaw: jest.fn(),
    consultantProfile: { findUnique: jest.fn(), count: jest.fn() },
    appointment: { findMany: jest.fn() },
    membership: { findFirst: jest.fn() },
    subscription: { findFirst: jest.fn() },
    appointmentOccurrence: { aggregate: jest.fn(), findMany: jest.fn() },
  },
}));

jest.mock("../../lib/auth-server", () => ({
  __esModule: true,
  getSession: jest.fn(async () => null),
}));

jest.mock("../../lib/appointments/report-anomalies", () => ({
  __esModule: true,
  scheduleAnomalyReport: jest.fn(),
}));

import { NextRequest } from "next/server";
import { GET } from "../../app/api/scheduling/availability-with-allocation/[consultantId]/route";
import prisma from "@/lib/prisma";
import { scheduleAnomalyReport } from "@/lib/appointments/report-anomalies";

const CONSULTANT_ID = "consultant-1";
const URL_BASE = `https://x.test/api/scheduling/availability-with-allocation/${CONSULTANT_ID}`;
const NOW = new Date("2026-09-01T00:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY_QUERY =
  "startDateInUtc=2026-09-07T00:00:00.000Z&endDateInUtc=2026-09-08T00:00:00.000Z&timezone=UTC";
const params = Promise.resolve({ consultantId: CONSULTANT_ID });

const mockedMarker = prisma.$queryRaw as unknown as jest.Mock;
const mockedProfile = prisma.consultantProfile.findUnique as jest.Mock;
const mockedAppointments = prisma.appointment.findMany as jest.Mock;
const mockedReport = scheduleAnomalyReport as jest.Mock;

type Cell = { startsAt: string; endsAt: string; bookingStatus: string };

const at = (iso: string) => new Date(iso);

function booking(
  id: string,
  occurrences: Array<{ id: string; startsAt: Date; endsAt: Date }>,
) {
  return {
    id,
    consultation: { status: "APPROVED", bookingSource: "DIRECT_CHECKOUT" },
    subscription: null,
    payment: [],
    occurrences,
  };
}

async function cellsOf(res: Response): Promise<Cell[]> {
  const body = (await res.json()) as { data: Record<string, Cell[]> };
  return Object.values(body.data).flat();
}

function expectNoOverlap(cells: Cell[]) {
  const sorted = [...cells].sort((a, b) =>
    a.startsAt.localeCompare(b.startsAt),
  );
  for (let i = 1; i < sorted.length; i++) {
    expect(Date.parse(sorted[i].startsAt)).toBeGreaterThanOrEqual(
      Date.parse(sorted[i - 1].endsAt),
    );
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers({
    now: NOW,
    doNotFake: [
      "hrtime",
      "nextTick",
      "performance",
      "queueMicrotask",
      "setImmediate",
      "clearImmediate",
      "setInterval",
      "clearInterval",
      "setTimeout",
      "clearTimeout",
    ],
  });
  mockedMarker.mockResolvedValue([
    {
      profileUpdatedAt: new Date("2026-08-01T10:00:00.000Z"),
      consultantDeletedAt: null,
      availabilityUpdatedAt: new Date("2026-08-01T11:00:00.000Z"),
      availabilityRowCount: 1,
      paymentsUpdatedAt: null,
      slotsUpdatedAt: null,
      slotRowCount: 0,
      collaboratorsUpdatedAt: null,
      requestsUpdatedAt: null,
      nextHoldExpiry: null,
    },
  ]);
  mockedProfile.mockResolvedValue({
    id: CONSULTANT_ID,
    userId: "user-consultant",
    deletedAt: null,
    scheduleType: "CUSTOM",
    availabilityWindowsWeekly: [],
    availabilityWindowsCustom: [
      {
        id: "custom-1",
        startsAt: at("2026-09-07T08:00:00.000Z"),
        endsAt: at("2026-09-07T12:00:00.000Z"),
      },
    ],
  });
});

afterEach(() => {
  jest.useRealTimers();
});

it("answers 200, keeps real off-grid time busy, and reports impossible rows once", async () => {
  mockedAppointments.mockResolvedValue([
    booking("appt-1", [
      // Inverted: never painted.
      {
        id: "inverted",
        startsAt: at("2026-09-07T09:00:00.000Z"),
        endsAt: at("2026-09-07T08:00:00.000Z"),
      },
      // Off the grid inside the published window: its atoms read booked.
      {
        id: "off-grid",
        startsAt: at("2026-09-07T10:17:00.000Z"),
        endsAt: at("2026-09-07T11:05:00.000Z"),
      },
      // Off the grid outside the window: one orphan cell per atom it touches.
      {
        id: "off-grid-evening",
        startsAt: at("2026-09-07T18:45:00.000Z"),
        endsAt: at("2026-09-07T19:15:00.000Z"),
      },
    ]),
  ]);

  const res = await GET(new NextRequest(`${URL_BASE}?${DAY_QUERY}`), {
    params,
  });
  expect(res.status).toBe(200);
  const cells = await cellsOf(res);
  expectNoOverlap(cells);

  const status = (hhmm: string) =>
    cells.find((c) => c.startsAt.slice(11, 16) === hhmm)?.bookingStatus;
  // 08:00–09:00 is free: the inverted row claimed nothing.
  expect(status("08:00")).toBe("available");
  expect(status("08:30")).toBe("available");
  expect(status("10:00")).not.toBe("available");
  expect(status("10:30")).not.toBe("available");
  expect(status("11:00")).not.toBe("available");
  expect(status("18:30")).toBe("fully-booked");
  expect(status("19:00")).toBe("fully-booked");

  expect(mockedReport).toHaveBeenCalledTimes(1);
  expect(mockedReport).toHaveBeenCalledWith(
    [{ kind: "ENDS_BEFORE_START", id: "inverted" }],
    "availability-grid",
  );
});

it("bounds a multi-year session to the window drawn", async () => {
  mockedAppointments.mockResolvedValue([
    booking("appt-2", [
      {
        id: "multi-year",
        startsAt: at("2024-01-01T00:00:00.000Z"),
        endsAt: at("2030-01-01T00:00:00.000Z"),
      },
    ]),
  ]);

  const res = await GET(new NextRequest(`${URL_BASE}?${DAY_QUERY}`), {
    params,
  });
  expect(res.status).toBe(200);
  const cells = await cellsOf(res);
  expectNoOverlap(cells);
  // The whole day is busy, one cell per atom, and nothing outside the window.
  expect(cells).toHaveLength(48);
  expect(cells.every((c) => c.bookingStatus !== "available")).toBe(true);
  expect(
    cells.every(
      (c) =>
        c.startsAt >= "2026-09-07T00:00:00.000Z" &&
        c.endsAt <= "2026-09-08T00:00:00.000Z",
    ),
  ).toBe(true);
  expect(mockedReport).toHaveBeenCalledWith(
    [{ kind: "OVERLONG_SESSION", id: "multi-year" }],
    "availability-grid",
  );
}, 15_000);

it("survives a 10k-session series overlapping the window", async () => {
  const start = Date.parse("2026-09-07T00:00:00.000Z");
  const series = Array.from({ length: 10_000 }, (_, i) => ({
    id: `s${i}`,
    // Every session overlaps the drawn day: 10k rows piled on 24 hours.
    startsAt: new Date(start + (i % 48) * 30 * 60 * 1000),
    endsAt: new Date(start + (i % 48) * 30 * 60 * 1000 + HOUR),
  }));
  mockedAppointments.mockResolvedValue([booking("appt-3", series)]);

  const res = await GET(new NextRequest(`${URL_BASE}?${DAY_QUERY}`), {
    params,
  });
  expect(res.status).toBe(200);
  const cells = await cellsOf(res);
  expectNoOverlap(cells);
  expect(cells.every((c) => c.bookingStatus !== "available")).toBe(true);
  expect(mockedReport).toHaveBeenCalledWith([], "availability-grid");
}, 15_000);
