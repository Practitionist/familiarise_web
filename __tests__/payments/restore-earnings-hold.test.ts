/**
 * @jest-environment node
 */

/**
 * A reschedule pushes the payout hold out; when its proposal ends with the
 * original sessions restored, the hold comes back to what those sessions imply.
 */
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: {} }));

import type { PrismaLike } from "@/lib/prisma";
import {
  computeHoldUntil,
  holdHoursFor,
  restoreEarningsHold,
} from "@/lib/payments/payouts/earnings-hold";

const HOUR = 3_600_000;
const capturedAt = new Date("2026-10-01T10:00:00.000Z");
const sessionEnd = new Date("2026-10-05T11:00:00.000Z");
const pushed = new Date("2026-10-20T10:00:00.000Z");

function fakeDb(holdUntil: Date | null) {
  const consultantUpdates: unknown[] = [];
  const orgUpdates: unknown[] = [];
  const db = {
    appointment: {
      findUnique: jest.fn(async () => ({
        appointmentType: "CONSULTATION",
        payment: [{ id: "pay-1" }],
      })),
    },
    appointmentOccurrence: {
      findFirst: jest.fn(async () => ({ endsAt: sessionEnd })),
    },
    consultantEarnings: {
      findMany: jest.fn(async () => [
        {
          id: "ce-1",
          createdAt: capturedAt,
          holdUntil,
          consultantProfileId: "cp-1",
        },
      ]),
      // An established expert: no new-expert days on top.
      findFirst: jest.fn(async () => ({
        createdAt: new Date("2024-01-01T00:00:00.000Z"),
      })),
      aggregate: jest.fn(async () => ({
        _sum: { consultantSharePaise: 100_000_000, refundedShareAmount: 0 },
      })),
      updateMany: jest.fn(async (args: unknown) => {
        consultantUpdates.push(args);
        return { count: 1 };
      }),
    },
    organizationEarnings: {
      findMany: jest.fn(async () => [
        { id: "oe-1", createdAt: capturedAt, holdUntil },
      ]),
      updateMany: jest.fn(async (args: unknown) => {
        orgUpdates.push(args);
        return { count: 1 };
      }),
    },
  };
  return { db: db as unknown as PrismaLike, consultantUpdates, orgUpdates };
}

const implied = computeHoldUntil({
  capturedAt,
  lastOccurrenceEndsAt: sessionEnd,
  holdHours: holdHoursFor("CONSULTATION"),
});

/** PENDING rows and rows held from PENDING. */
const UNRELEASED = {
  OR: [{ status: "PENDING" }, { status: "HELD", preHoldStatus: "PENDING" }],
};

describe("restoreEarningsHold", () => {
  it("pulls a reschedule's pushed hold back to what the restored session implies", async () => {
    expect(pushed.getTime()).toBeGreaterThan(implied.getTime() + HOUR);
    const { db, consultantUpdates, orgUpdates } = fakeDb(pushed);

    expect(await restoreEarningsHold(db, "appt-1")).toBe(2);
    expect(consultantUpdates).toEqual([
      {
        where: { id: "ce-1", ...UNRELEASED, holdUntil: pushed },
        data: { holdUntil: implied },
      },
    ]);
    expect(orgUpdates).toEqual([
      {
        where: { id: "oe-1", ...UNRELEASED, holdUntil: pushed },
        data: { holdUntil: implied },
      },
    ]);
  });

  it("never moves a hold earlier than the restored session implies", async () => {
    const { db, consultantUpdates, orgUpdates } = fakeDb(implied);
    expect(await restoreEarningsHold(db, "appt-1")).toBe(0);
    expect(consultantUpdates).toEqual([]);
    expect(orgUpdates).toEqual([]);
  });

  it("leaves a settled subscription cycle's tranche to its own hold", async () => {
    const { db } = fakeDb(pushed);
    await restoreEarningsHold(db, "appt-1");
    const where = (db.consultantEarnings.findMany as unknown as jest.Mock).mock
      .calls[0][0].where;
    expect(where.cycleOrdinal).toBeNull();
  });
});
