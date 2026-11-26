/**
 * @jest-environment node
 */

/**
 * The consultant Appointments read is bounded: "recent" is every live row
 * (capped) plus the first page of past rows, "older" pages the rest of the
 * past rows through one `(createdAt, id)` keyset, and the server hands back
 * the next cursor from the keyset order, never from the display order.
 */

import prisma from "@/lib/prisma";
import {
  getConsultantAppointments,
  readConsultantAppointmentsPage,
} from "@/lib/data/consultant-appointments";
import {
  CONSULTANT_APPOINTMENTS_PAGE,
  CONSULTANT_APPOINTMENTS_RECENT_CAP,
  CONSULTANT_APPOINTMENTS_RECENT_PAST,
  decodeAppointmentsCursor,
} from "@/lib/appointments/window";

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { appointment: { findMany: jest.fn() }, $queryRaw: jest.fn() },
}));

const findMany = prisma.appointment.findMany as jest.Mock;
const queryRaw = prisma.$queryRaw as unknown as jest.Mock;
const NOW = new Date("2026-10-27T12:00:00Z");
const base = {
  consultantProfileId: "cp-1",
  scope: { kind: "personal" } as const,
  now: NOW,
};

type Row = {
  id: string;
  createdAt: Date;
  live: boolean;
  occurrences: { startsAt: Date }[];
  _count: { participants: number; occurrences: number };
};
type Where = {
  AND?: Where[];
  OR?: Where[];
  occurrences?: { some?: { endsAt?: unknown }; none?: { endsAt?: unknown } };
  createdAt?: { lt?: Date };
  id?: { in?: string[] };
};

/**
 * 600 past rows created a minute apart, several sharing a millisecond (the
 * column holds microseconds), each with a session time unrelated to its
 * creation order, plus three live rows.
 */
const PAST: Row[] = Array.from({ length: 600 }, (_, i) => ({
  id: `a-${String(i).padStart(3, "0")}`,
  // Rows 100-104 share one millisecond.
  createdAt: new Date(
    Date.UTC(2025, 0, 1) + (i >= 100 && i <= 104 ? 100 : i) * 60_000,
  ),
  live: false,
  _count: { participants: 0, occurrences: 0 },
  occurrences: [
    {
      startsAt: new Date(Date.UTC(2025, 6, 1) + ((i * 7919) % 600) * 3_600_000),
    },
  ],
}));
const LIVE: Row[] = ["l-1", "l-2", "l-3"].map((id, i) => ({
  id,
  createdAt: new Date(Date.UTC(2026, 9, 1 + i)),
  live: true,
  _count: { participants: 0, occurrences: 0 },
  occurrences: [],
}));
const ROWS = [...PAST, ...LIVE];

/** Honours the live / past split, the keyset band, the order, skip and take. */
function matches(row: Row, where: Where): boolean {
  if (where.AND && !where.AND.every((w) => matches(row, w))) return false;
  const first = where.OR?.[0];
  if (first?.occurrences?.some?.endsAt) return row.live;
  if (where.occurrences?.none?.endsAt) return !row.live;
  if (first?.createdAt) {
    const [older, band] = where.OR as [Where, Where];
    return (
      row.createdAt.getTime() < older.createdAt!.lt!.getTime() ||
      band.id!.in!.includes(row.id)
    );
  }
  return true;
}
const newestFirst = (a: Row, b: Row) =>
  b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1);

beforeEach(() => {
  jest.clearAllMocks();
  // The cursor row's millisecond, and the rows in it the row-value comparison puts after it.
  queryRaw.mockImplementation(async (sql: { values: unknown[] }) => {
    const cursor = ROWS.find((r) => r.id === sql.values[0]);
    if (!cursor) return [];
    const ms = cursor.createdAt.getTime();
    return [
      {
        start: new Date(ms),
        ids: ROWS.filter(
          (r) => r.createdAt.getTime() === ms && r.id < cursor.id,
        ).map((r) => r.id),
      },
    ];
  });
  findMany.mockImplementation(
    async (args: { where: Where; take?: number; skip?: number }) =>
      ROWS.filter((r) => matches(r, args.where))
        .sort(newestFirst)
        .slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? ROWS.length)),
  );
});

describe("consultant appointments window", () => {
  it("recent = every live row plus the newest past page, each read capped", async () => {
    const page = await readConsultantAppointmentsPage(base);
    const [live, past] = findMany.mock.calls.map(([args]) => args);
    expect(live.take).toBe(CONSULTANT_APPOINTMENTS_RECENT_CAP);
    expect(past.take).toBe(CONSULTANT_APPOINTMENTS_RECENT_PAST);
    expect(past.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
    expect(page.rows).toHaveLength(3 + CONSULTANT_APPOINTMENTS_RECENT_PAST);
    // The cursor is the oldest-created past row read, not the last by session time.
    expect(decodeAppointmentsCursor(page.nextCursor)?.id).toBe("a-100");
  });

  it("Load older walks every remaining past row once, ties included", async () => {
    const recent = await readConsultantAppointmentsPage(base);
    const seen = recent.rows.map((r) => r.id);
    let before: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const page = await readConsultantAppointmentsPage({
        ...base,
        window: "older",
        before: decodeAppointmentsCursor(before),
      });
      seen.push(...page.rows.map((r) => r.id));
      before = page.nextCursor;
      if (!before) break;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(ROWS.length);
    const firstOlder = findMany.mock.calls.find(([args]) => args.skip);
    expect(firstOlder?.[0].skip).toBe(CONSULTANT_APPOINTMENTS_RECENT_PAST - 1);
  });

  it("an older page holds at most one page and stops when the past runs out", async () => {
    const page = await readConsultantAppointmentsPage({
      ...base,
      window: "older",
      before: { createdAt: PAST[150].createdAt, id: PAST[150].id },
    });
    expect(page.rows.length).toBeLessThanOrEqual(CONSULTANT_APPOINTMENTS_PAGE);
    const last = await readConsultantAppointmentsPage({
      ...base,
      window: "older",
      before: { createdAt: PAST[3].createdAt, id: PAST[3].id },
    });
    expect(last.rows.map((r) => r.id).sort()).toEqual([
      "a-000",
      "a-001",
      "a-002",
    ]);
    expect(last.nextCursor).toBeNull();
  });

  it("leaves event-scoped reads to their own filter", async () => {
    await getConsultantAppointments({
      ...base,
      eventIds: { subscriptionId: "sub-1" },
    });
    const [args] = findMany.mock.calls[0];
    expect(args.take).toBeUndefined();
    expect(args.orderBy).toBeUndefined();
  });
});
