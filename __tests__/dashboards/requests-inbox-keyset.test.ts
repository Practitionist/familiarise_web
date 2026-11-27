/**
 * @jest-environment node
 */

// Invariant: a time sort over one source pages every request through a SQL
// keyset cursor (no row lost or repeated past any scan size), totals are
// separate counts, and ranked windows (every multi-source view) say when
// they show only part of the view.

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultation: { findMany: jest.fn(), count: jest.fn() },
    subscription: { findMany: jest.fn(), count: jest.fn() },
    trial: { findMany: jest.fn(), count: jest.fn() },
    $queryRaw: jest.fn(),
  },
}));

import prisma from "@/lib/prisma";
import { readRequestsInbox } from "@/lib/data/requests-inbox";
import {
  INBOX_RANKED_WINDOW,
  decodeInboxCursor,
  nextInboxSearch,
  readInboxParams,
} from "@/lib/dashboard/requests-inbox-state";

import { CP, NOW } from "../fixtures/requests-inbox";

const m = prisma as unknown as Record<string, Record<string, jest.Mock>>;

const person = (id: string) => ({
  id,
  user: { id: `u-${id}`, name: `Learner ${id}`, image: null },
});

/**
 * 205 PENDING and 205 REJECTED requests, one a minute, the oldest 205 minutes
 * ago; rows 40-60 share one millisecond, so a page boundary falls inside it.
 */
const cohort = (prefix: string, status: string) =>
  Array.from({ length: 205 }, (_, i) => ({
    id: `${prefix}-${String(i).padStart(3, "0")}`,
    status,
    requestedAt: new Date(
      NOW.getTime() - (205 - (i >= 40 && i <= 60 ? 40 : i)) * 60_000,
    ),
    bookingSource: "REQUEST_SUBMITTED",
    requestNotes: null,
    consultationPlan: {
      id: "plan-c",
      title: "Career call",
      durationInHours: 1,
      price: 100000,
      priceCurrency: "INR",
      consultantProfile: person(CP),
    },
    requestedBy: person(`ce-${i}`),
    appointment: null,
  }));
const ROWS = [...cohort("c", "PENDING"), ...cohort("r", "REJECTED")];

type Keyset = {
  OR?: [{ requestedAt: { gte?: Date; lt?: Date } }, { id: { in: string[] } }];
};
type Args = {
  where: { AND?: [{ status?: unknown }, Keyset] };
  orderBy: [{ requestedAt: "asc" | "desc" }, { id: "asc" | "desc" }];
  take: number;
};

/** Honours the cohort's status, the keyset WHERE, the order and the take. */
function findMany({ where, orderBy, take }: Args) {
  // None of these rows is a checkout in flight.
  if (JSON.stringify(where).includes('"bookingSource":"DIRECT_CHECKOUT"')) {
    return Promise.resolve([]);
  }
  const [cohort, keyset] = where.AND ?? [{}, {}];
  const status = JSON.stringify(cohort).match(/"status":"(\w+)"/)?.[1];
  const dir = orderBy[0].requestedAt === "asc" ? 1 : -1;
  const after = keyset?.OR;
  return Promise.resolve(
    ROWS.filter((r) => r.status === status)
      .filter((r) => {
        if (!after) return true;
        const t = r.requestedAt.getTime();
        const [outer, band] = after;
        const past = outer.requestedAt.gte
          ? t >= outer.requestedAt.gte.getTime()
          : t < outer.requestedAt.lt!.getTime();
        return past || band.id.in.includes(r.id);
      })
      .sort(
        (a, b) =>
          dir *
          (a.requestedAt.getTime() - b.requestedAt.getTime() ||
            a.id.localeCompare(b.id)),
      )
      .slice(0, take),
  );
}

/** The cursor row's millisecond and the rows in it on the far side of the row. */
function queryRaw(sql: { sql: string; values: unknown[] }) {
  const cursor = ROWS.find((r) => r.id === sql.values[0]);
  if (!cursor) return Promise.resolve([]);
  const ms = cursor.requestedAt.getTime();
  const desc = sql.sql.includes(") < (");
  return Promise.resolve([
    {
      start: new Date(ms),
      ids: ROWS.filter(
        (r) =>
          r.requestedAt.getTime() === ms &&
          (desc ? r.id < cursor.id : r.id > cursor.id),
      ).map((r) => r.id),
    },
  ]);
}

beforeEach(() => {
  jest.clearAllMocks();
  (m.$queryRaw as unknown as jest.Mock).mockImplementation(queryRaw);
  m.consultation.findMany.mockImplementation(findMany);
  m.consultation.count.mockImplementation(({ where }: Args) =>
    Promise.resolve(
      /"status":"(PENDING|REJECTED)"/.test(JSON.stringify(where)) &&
        !JSON.stringify(where).includes('"bookingSource":"DIRECT_CHECKOUT"')
        ? 205
        : 0,
    ),
  );
  for (const model of ["subscription", "trial"]) {
    m[model].findMany.mockResolvedValue([]);
    m[model].count.mockResolvedValue(0);
  }
});

const read = (
  sort: "old" | "new" | "priority",
  after: string | null = null,
  chip?: "declined",
) =>
  readRequestsInbox({
    consultantProfileId: CP,
    type: "consultation",
    chip,
    sort,
    page: 1,
    after,
    limit: 50,
    now: NOW,
  });

describe("inbox keyset paging", () => {
  it("sort=old over one source starts at the oldest request and walks all 205 without repeats", async () => {
    const seen: string[] = [];
    let after: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const page = await read("old", after, "declined");
      expect(page.meta.paging).toBe("cursor");
      seen.push(...page.rows.map((r) => r.id));
      expect(page.meta.total).toBe(205);
      after = page.meta.nextCursor;
      if (!after) break;
    }
    expect(seen[0]).toBe("r-000");
    expect(seen).toHaveLength(205);
    expect(new Set(seen).size).toBe(205);
  });

  it("sort=new over one source reads newest first and pages in SQL, never a 200-row window", async () => {
    const first = await read("new", null, "declined");
    expect(first.rows[0].id).toBe("r-204");
    const call = m.consultation.findMany.mock.calls[0][0];
    expect(call.orderBy).toEqual([{ requestedAt: "desc" }, { id: "desc" }]);
    expect(call.take).toBe(51);
    const cursor = decodeInboxCursor(first.meta.nextCursor);
    expect(cursor?.id).toBe("r-155");
  });

  it("time sorts over several sources page a window: the newest or oldest of each source", async () => {
    const newest = await read("new");
    expect(newest.meta).toMatchObject({
      paging: "ranked",
      nextCursor: null,
      windowSize: INBOX_RANKED_WINDOW,
      total: 205,
    });
    expect(newest.rows[0].id).toBe("c-204");
    const oldest = await read("old");
    expect(oldest.meta.paging).toBe("ranked");
    expect(oldest.rows[0].id).toBe("c-000");
  });

  it("ranked sorts hold the most urgent window and report the true total", async () => {
    const page = await read("priority");
    expect(page.meta.total).toBe(205);
    expect(page.meta.windowSize).toBe(INBOX_RANKED_WINDOW);
    expect(page.meta.nextCursor).toBeNull();
    // The window is the oldest rows: the nearest their 48 h hold.
    expect(page.rows.map((r) => r.id)).toContain("c-000");
    expect(page.meta.bucketTotals).not.toBeNull();
  });

  it("the cursor rides the URL for time sorts only and resets on any change", () => {
    const cursor = "1758369600000.c-155";
    expect(
      readInboxParams(
        (key) =>
          ({ sort: "old", after: cursor })[key as "sort" | "after"] ?? null,
      ).after,
    ).toBe(cursor);
    expect(
      readInboxParams(
        (key) =>
          ({ sort: "priority", after: cursor })[key as "sort" | "after"] ??
          null,
      ).after,
    ).toBeNull();
    expect(nextInboxSearch(`sort=old&after=${cursor}`, { chip: null })).toBe(
      "sort=old",
    );
  });
});

describe("inbox pool bound", () => {
  const ORIGINAL_POOL = process.env.PG_POOL_MAX;
  afterAll(() => {
    process.env.PG_POOL_MAX = ORIGINAL_POOL;
  });

  it("keeps one read in flight on a one-connection pool", async () => {
    process.env.PG_POOL_MAX = "1";
    let inFlight = 0;
    let peak = 0;
    const slow =
      <A, R>(fn: (args: A) => Promise<R>) =>
      async (args: A) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        try {
          return await fn(args);
        } finally {
          inFlight -= 1;
        }
      };
    m.consultation.findMany.mockImplementation(slow(findMany));
    m.consultation.count.mockImplementation(slow(async () => 0));
    for (const model of ["subscription", "trial"]) {
      m[model].findMany.mockImplementation(slow(async () => []));
      m[model].count.mockImplementation(slow(async () => 0));
    }
    await read("priority");
    expect(peak).toBe(1);
  });
});
