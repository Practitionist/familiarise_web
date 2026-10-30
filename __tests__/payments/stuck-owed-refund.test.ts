/**
 * @jest-environment node
 */

/**
 * An owed refund always has an exit: an operator's hand refund settles and
 * clears its marker in the refund's own transaction, and the needs-human queue
 * lists a stuck one until it is gone.
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

import type { Tx } from "@/lib/prisma";
import { readStuckOwedRefunds } from "@/lib/backoffice/needs-human";
import {
  MAX_REFUND_OWED_ATTEMPTS,
  settleOwedByHand,
} from "@/lib/payments/operations/refund-owed";

function fakeDb(ownRefundStatus: "PENDING" | "SUCCEEDED" | null = null) {
  const updates: unknown[] = [];
  const db = {
    payment: {
      findUnique: jest.fn(async () => ({
        refundOwedKey: "cancel:appt-1:pay-1",
        refundOwedPaise: 500_000,
        refundOwedReason: "cancellation",
      })),
      updateMany: jest.fn(async (args: unknown) => {
        updates.push(args);
        return { count: 1 };
      }),
    },
    refund: {
      findUnique: jest.fn(async () =>
        ownRefundStatus ? { status: ownRefundStatus } : null,
      ),
    },
  };
  return { db: db as unknown as Pick<Tx, "payment" | "refund">, updates };
}

describe("settleOwedByHand", () => {
  it("clears the marker by CAS on its key, backoff included, and answers what it owed", async () => {
    const { db, updates } = fakeDb();
    expect(await settleOwedByHand(db, "pay-1")).toEqual({
      key: "cancel:appt-1:pay-1",
      owedPaise: 500_000,
      reason: "cancellation",
    });
    expect(updates).toEqual([
      {
        where: { id: "pay-1", refundOwedKey: "cancel:appt-1:pay-1" },
        data: expect.objectContaining({
          refundOwedKey: null,
          refundOwedAttempts: 0,
          refundOwedNextAt: null,
        }),
      },
    ]);
  });

  it("refuses while the marker's own refund is in flight", async () => {
    const { db, updates } = fakeDb("PENDING");
    await expect(settleOwedByHand(db, "pay-1")).rejects.toMatchObject({
      code: "OWED_REFUND_IN_FLIGHT",
    });
    expect(updates).toEqual([]);
  });

  it("clears a marker its own refund already settled without reporting it as settled by hand", async () => {
    const { db, updates } = fakeDb("SUCCEEDED");
    expect(await settleOwedByHand(db, "pay-1")).toBeNull();
    expect(updates).toHaveLength(1);
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
