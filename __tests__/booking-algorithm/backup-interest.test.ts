/**
 * @jest-environment node
 */

/**
 * #1778 — backup interest: three WAITING rows at most, one row per window,
 * a release notifies each waiting learner once, and a booking marks only the
 * booker's own row.
 */

jest.mock("../../lib/novu/stage-bell", () => ({ stageBell: jest.fn() }));
jest.mock("../../lib/email/senders/booking", () => ({
  stageWindowOpenedEmail: jest.fn(async () => []),
}));

type Row = {
  id: string;
  userId: string;
  consultantProfileId: string;
  windowStart: Date;
  windowEnd: Date;
  status: string;
  planKind: string;
  planId: string | null;
  consultantProfile: { user: { name: string } };
};
const rows: Row[] = [];
const matches = (r: Row, where: Record<string, unknown>) =>
  Object.entries(where).every(([k, v]) => {
    const value = (r as Record<string, unknown>)[k];
    if (v && typeof v === "object" && "in" in v)
      return (v as { in: unknown[] }).in.includes(value);
    if (v && typeof v === "object" && ("lt" in v || "gt" in v)) {
      const c = v as { lt?: Date; gt?: Date };
      const t = (value as Date).getTime();
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
        consultantProfile: { user: { name: "Expert" } },
      } as Row;
      rows.push(row);
      return row;
    },
    findMany: async ({ where }: { where: Record<string, unknown> }) =>
      rows.filter((r) => matches(r, where)),
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
  const client = { windowBackupInterest: table };
  return {
    __esModule: true,
    default: {
      ...client,
      $transaction: async (fn: (t: unknown) => unknown) => fn(client),
    },
  };
});

import {
  markBackupInterestBooked,
  registerBackupInterest,
  stageBackupInterestNotices,
} from "@/lib/booking/backup-interest";
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
