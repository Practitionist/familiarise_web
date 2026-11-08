/**
 * @jest-environment node
 */

/**
 * Slot backup interest: three open rows at most, one row per window, a release
 * notifies each eligible learner at most once per cooldown bucket, a booking
 * marks only the booker's own row, and settled rows are purged after retention.
 */

jest.mock("../../lib/novu/stage-bell", () => ({ stageBell: jest.fn() }));
jest.mock("../../lib/email/senders/booking", () => ({
  stageWindowOpenedEmail: jest.fn(async () => []),
  whenText: (d: Date) => d.toISOString(),
}));

type Row = {
  id: string;
  userId: string;
  consultantProfileId: string;
  windowStart: Date;
  windowEnd: Date;
  status: string;
  notifiedAt: Date | null;
  planKind: string;
  planId: string | null;
  consultantProfile: { user: { name: string } };
};
const rows: Row[] = [];
type Where = Record<string, unknown>;
const matches = (r: Row, where: Where): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (k === "OR") return (v as Where[]).some((w) => matches(r, w));
    if (k === "AND") return (v as Where[]).every((w) => matches(r, w));
    const value = (r as Record<string, unknown>)[k];
    if (v && typeof v === "object" && "in" in v)
      return (v as { in: unknown[] }).in.includes(value);
    if (v && typeof v === "object" && ("lt" in v || "gt" in v)) {
      if (!(value instanceof Date)) return false;
      const c = v as { lt?: Date; gt?: Date };
      const t = value.getTime();
      return (!c.lt || t < c.lt.getTime()) && (!c.gt || t > c.gt.getTime());
    }
    return value === v;
  });
jest.mock("../../lib/prisma", () => {
  const table = {
    findUnique: async ({
      where,
    }: {
      where: Record<string, Record<string, unknown>>;
    }) => {
      const k = Object.values(where)[0];
      return (
        rows.find(
          (r) =>
            r.userId === k.userId &&
            r.consultantProfileId === k.consultantProfileId &&
            r.windowStart.getTime() === (k.windowStart as Date).getTime(),
        ) ?? null
      );
    },
    count: async ({ where }: { where: Record<string, unknown> }) =>
      rows.filter((r) => matches(r, where)).length,
    upsert: async ({
      create,
    }: {
      create: Omit<Row, "id" | "status" | "consultantProfile">;
    }) => {
      const row = {
        ...create,
        id: `bi-${rows.length + 1}`,
        status: "WAITING",
        notifiedAt: null,
        consultantProfile: { user: { name: "Expert" } },
      } as Row;
      rows.push(row);
      return row;
    },
    findMany: async ({ where, take }: { where: Where; take?: number }) =>
      rows.filter((r) => matches(r, where)).slice(0, take ?? rows.length),
    findFirst: async ({ where }: { where: Where }) =>
      rows.find((r) => matches(r, where)) ?? null,
    deleteMany: async ({ where }: { where: Where }) => {
      const keep = rows.filter((r) => !matches(r, where));
      const count = rows.length - keep.length;
      rows.splice(0, rows.length, ...keep);
      return { count };
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Partial<Row>;
    }) => {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    },
  };
  const client = {
    windowBackupInterest: table,
    user: { findUnique: async () => ({ timezone: "Asia/Kolkata" }) },
  };
  return {
    __esModule: true,
    default: {
      ...client,
      $transaction: async (fn: (t: unknown) => unknown) => fn(client),
    },
  };
});

import {
  expireBackupInterest,
  hasLapsedBackupInterest,
  markBackupInterestBooked,
  registerBackupInterest,
  stageBackupInterestNotices,
} from "@/lib/booking/backup-interest";
import {
  INTEREST_RENOTIFY_COOLDOWN_MS,
  INTEREST_RETENTION_MS,
  renoticeBucket,
} from "@/lib/booking/interest/lifecycle";
import prisma from "@/lib/prisma";

const at = (h: number) => new Date(Date.UTC(2030, 0, 1, h));
const register = (userId: string, h: number) =>
  registerBackupInterest({
    userId,
    consultantProfileId: "cp-1",
    windowStart: at(h),
    windowEnd: at(h + 1),
    planKind: "CONSULTATION",
    planId: "plan-1",
  });

beforeEach(() => {
  rows.length = 0;
  jest.clearAllMocks();
});

it("a fourth WAITING window is refused; the same window twice is one row", async () => {
  await register("u-1", 9);
  await register("u-1", 9);
  await register("u-1", 10);
  await register("u-1", 11);
  expect(rows).toHaveLength(3);
  await expect(register("u-1", 12)).rejects.toMatchObject({
    code: "BACKUP_INTEREST_CAP",
  });
});

it("a release notifies two waiting learners once; a booking marks only the booker", async () => {
  await register("u-1", 9);
  await register("u-2", 9);
  const window = {
    consultantProfileId: "cp-1",
    windowStart: at(9),
    windowEnd: at(10),
  };
  const tx = prisma as never;
  await stageBackupInterestNotices(tx, window);
  await stageBackupInterestNotices(tx, window);
  const { stageBell } = jest.requireMock("../../lib/novu/stage-bell");
  expect(stageBell).toHaveBeenCalledTimes(2);
  expect(rows.map((r) => r.status)).toEqual(["NOTIFIED", "NOTIFIED"]);

  await markBackupInterestBooked(tx, "u-2", window);
  expect(rows.map((r) => r.status)).toEqual(["NOTIFIED", "BOOKED"]);
});

it("the sweep arm expires only open rows whose window has passed", async () => {
  await register("u-1", 9);
  rows[0].windowEnd = new Date(Date.now() - 1000);
  await expireBackupInterest(new Date(), 10);
  expect(rows[0].status).toBe("EXPIRED");
});

it("a notified row hears again only after the cooldown, once per bucket", async () => {
  await register("u-1", 9);
  const window = {
    consultantProfileId: "cp-1",
    windowStart: at(9),
    windowEnd: at(10),
  };
  const tx = prisma as never;
  const t0 = new Date(Date.UTC(2029, 11, 1, 6));
  const { stageBell } = jest.requireMock("../../lib/novu/stage-bell");
  await stageBackupInterestNotices(tx, window, t0);
  await stageBackupInterestNotices(
    tx,
    window,
    new Date(t0.getTime() + INTEREST_RENOTIFY_COOLDOWN_MS - 1),
  );
  expect(stageBell).toHaveBeenCalledTimes(1);

  const t1 = new Date(t0.getTime() + INTEREST_RENOTIFY_COOLDOWN_MS + 1);
  await stageBackupInterestNotices(tx, window, t1);
  await stageBackupInterestNotices(tx, window, t1);
  const keys = stageBell.mock.calls.map(
    (c: [unknown, { dedupeKey: string }]) => c[1].dedupeKey,
  );
  expect(keys).toEqual([
    `window-opened:bi-1:${renoticeBucket(t0)}`,
    `window-opened:bi-1:${renoticeBucket(t1)}`,
  ]);
  expect(rows[0].notifiedAt).toEqual(t1);
});

it("settled rows past retention are purged and the idle probe sees them", async () => {
  const now = new Date(Date.UTC(2030, 5, 1));
  await register("u-1", 9);
  await register("u-2", 9);
  const old = new Date(now.getTime() - INTEREST_RETENTION_MS - 1000);
  Object.assign(rows[0], { status: "BOOKED", windowEnd: old });
  Object.assign(rows[1], { status: "EXPIRED", windowEnd: now });
  const db = prisma as never;
  expect(await hasLapsedBackupInterest(db, now)).toBe(true);
  expect(await expireBackupInterest(now, 10)).toEqual({
    expired: 0,
    purged: 1,
  });
  expect(rows.map((r) => r.userId)).toEqual(["u-2"]);
  expect(await hasLapsedBackupInterest(db, now)).toBe(false);
});
