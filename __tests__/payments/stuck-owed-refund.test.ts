/**
 * @jest-environment node
 */

/**
 * A refund marker that spent its attempts must have an exit: an ops hand
 * refund clears it (and only a stuck one), and the needs-human queue lists it
 * until it is gone.
 */
const mockPaymentFindMany = jest.fn();

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: { findMany: (...a: unknown[]) => mockPaymentFindMany(...a) },
  },
}));
jest.mock("@/lib/enterprise/system-events", () => ({
  recordSystemErrorSafe: jest.fn(),
}));
jest.mock("@/lib/payments/operations/booking-refund", () => ({
  refundBookingPayment: jest.fn(),
}));

import type { PrismaLike } from "@/lib/prisma";
import { readStuckOwedRefunds } from "@/lib/backoffice/needs-human";
import {
  clearStuckRefundOwed,
  MAX_REFUND_OWED_ATTEMPTS,
} from "@/lib/payments/operations/refund-owed";

const STAMPED_AT = new Date("2026-05-01T00:00:00Z");

function fakeDb(
  row: {
    refundOwedKey: string | null;
    refundOwedAttempts: number;
    refundOwedPaise?: number | null;
  },
  refundedSincePaise = 0,
) {
  const updates: unknown[] = [];
  const aggregates: unknown[] = [];
  const db = {
    payment: {
      findUnique: jest.fn(async () => ({
        refundOwedPaise: null,
        refundOwedAt: STAMPED_AT,
        ...row,
      })),
      updateMany: jest.fn(async (args: unknown) => {
        updates.push(args);
        return { count: 1 };
      }),
    },
    refund: {
      aggregate: jest.fn(async (args: unknown) => {
        aggregates.push(args);
        return { _sum: { amountPaise: refundedSincePaise } };
      }),
    },
  };
  return {
    db: db as unknown as Pick<PrismaLike, "payment" | "refund">,
    updates,
    aggregates,
  };
}

describe("clearStuckRefundOwed", () => {
  it("clears a marker that spent its attempts, by CAS on its key", async () => {
    const { db, updates } = fakeDb({
      refundOwedKey: "incident:inc-1:occ-1:u-1",
      refundOwedAttempts: MAX_REFUND_OWED_ATTEMPTS,
    });
    expect(await clearStuckRefundOwed(db, "pay-1", { full: true })).toEqual({
      cleared: "incident:inc-1:occ-1:u-1",
    });
    expect(updates).toEqual([
      expect.objectContaining({
        where: {
          id: "pay-1",
          refundOwedKey: "incident:inc-1:occ-1:u-1",
          refundOwedAttempts: { gte: MAX_REFUND_OWED_ATTEMPTS },
        },
      }),
    ]);
  });

  it("never touches a marker still retrying", async () => {
    const { db, updates } = fakeDb({
      refundOwedKey: "cancel:appt-1:pay-1",
      refundOwedAttempts: 1,
    });
    expect(await clearStuckRefundOwed(db, "pay-1", { full: true })).toBeNull();
    expect(updates).toEqual([]);
  });

  it("a partial hand refund smaller than the debt leaves the marker owed", async () => {
    const { db, updates } = fakeDb(
      {
        refundOwedKey: "cancel:appt-1:pay-1",
        refundOwedAttempts: MAX_REFUND_OWED_ATTEMPTS,
        refundOwedPaise: 500_000,
      },
      10_000,
    );
    expect(await clearStuckRefundOwed(db, "pay-1", { full: false })).toEqual({
      stillOwed: { key: "cancel:appt-1:pay-1", paise: 500_000 },
    });
    expect(updates).toEqual([]);
  });

  it("hand refunds since the marker that add up to the debt clear it", async () => {
    const { db, updates, aggregates } = fakeDb(
      {
        refundOwedKey: "cancel:appt-1:pay-1",
        refundOwedAttempts: MAX_REFUND_OWED_ATTEMPTS,
        refundOwedPaise: 500_000,
      },
      500_000,
    );
    expect(await clearStuckRefundOwed(db, "pay-1", { full: false })).toEqual({
      cleared: "cancel:appt-1:pay-1",
    });
    expect(updates).toHaveLength(1);
    expect(aggregates).toEqual([
      expect.objectContaining({
        where: {
          paymentId: "pay-1",
          status: "SUCCEEDED",
          createdAt: { gte: STAMPED_AT },
        },
      }),
    ]);
  });

  it("a marker owing the full balance clears only on a full refund", async () => {
    const row = {
      refundOwedKey: "plan-end:sub-1:pay:pay-1",
      refundOwedAttempts: MAX_REFUND_OWED_ATTEMPTS,
      refundOwedPaise: null,
    };
    const partial = fakeDb(row, 9_999_999);
    expect(
      await clearStuckRefundOwed(partial.db, "pay-1", { full: false }),
    ).toEqual({ stillOwed: { key: "plan-end:sub-1:pay:pay-1", paise: null } });
    expect(partial.updates).toEqual([]);
    const full = fakeDb(row);
    expect(
      await clearStuckRefundOwed(full.db, "pay-1", { full: true }),
    ).toEqual({ cleared: "plan-end:sub-1:pay:pay-1" });
  });
});

describe("needs-human lists stuck markers from the payments that hold them", () => {
  it("asks for a spent or dispute-held marker, however it was found", async () => {
    mockPaymentFindMany.mockResolvedValue([]);
    await readStuckOwedRefunds();
    expect(mockPaymentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          refundOwedKey: { not: null },
          deletedAt: null,
          OR: [
            { refundOwedAttempts: { gte: MAX_REFUND_OWED_ATTEMPTS } },
            { disputes: { some: expect.anything() } },
          ],
        },
      }),
    );
  });

  it("lists each payment once, a second marker on the same payment included", async () => {
    const at = new Date("2026-05-02T00:00:00Z");
    mockPaymentFindMany.mockResolvedValue([
      {
        id: "pay-1",
        createdAt: at,
        refundOwedKey: "plan-end:sub-1:pay:pay-1",
        refundOwedPaise: 30_000,
        refundOwedAt: at,
        refundOwedAttempts: MAX_REFUND_OWED_ATTEMPTS,
        disputes: [],
      },
      {
        id: "pay-2",
        createdAt: at,
        refundOwedKey: "cancel:appt-2:pay-2",
        refundOwedPaise: null,
        refundOwedAt: at,
        refundOwedAttempts: 0,
        disputes: [{ id: "dsp-1" }],
      },
    ]);
    const items = await readStuckOwedRefunds();
    expect(items.map((i) => [i.paymentId, i.kind])).toEqual([
      ["pay-1", "stuck-owed-refund"],
      ["pay-2", "stuck-owed-refund"],
    ]);
    expect(items[0].message).toContain("₹300.00");
    expect(items[0].message).toContain("plan-end:sub-1:pay:pay-1");
    expect(items[1].message).toContain("live dispute");
    expect(items[1].message).toContain("its full balance");
  });
});
