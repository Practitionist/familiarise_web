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

function fakeDb(
  opts: {
    own?: "PENDING" | "SUCCEEDED";
    owed?: number | null;
    casWins?: boolean;
  } = {},
) {
  const updates: unknown[] = [];
  const db = {
    payment: {
      findUnique: jest.fn(async () => ({
        refundOwedKey: "cancel:appt-1:pay-1",
        refundOwedPaise: opts.owed === undefined ? 500_000 : opts.owed,
        refundOwedReason: "cancellation",
      })),
      updateMany: jest.fn(async (args: unknown) => {
        updates.push(args);
        return { count: opts.casWins === false ? 0 : 1 };
      }),
    },
    refund: {
      findUnique: jest.fn(async () => (opts.own ? { status: opts.own } : null)),
    },
  };
  return { db: db as unknown as Pick<Tx, "payment" | "refund">, updates };
}

const hand = (handPaise: number, refundableBeforePaise = 1_000_000) => ({
  kind: "amount" as const,
  handPaise,
  refundableBeforePaise,
});
const CAS = {
  id: "pay-1",
  refundOwedKey: "cancel:appt-1:pay-1",
  refundOwedPaise: 500_000,
};

describe("settleOwedByHand", () => {
  it("clears a marker the hand refund covers, by CAS on its key and owed amount", async () => {
    const { db, updates } = fakeDb();
    expect(await settleOwedByHand(db, "pay-1", hand(500_000))).toMatchObject({
      settledPaise: 500_000,
      stillOwedPaise: 0,
      note: "The owed ₹5000.00 is fully settled.",
    });
    expect(updates).toEqual([
      {
        where: CAS,
        data: expect.objectContaining({
          refundOwedKey: null,
          refundOwedNextAt: null,
        }),
      },
    ]);
  });

  it("reduces a marker by a smaller hand refund, leaving its attempts and backoff alone", async () => {
    const { db, updates } = fakeDb();
    expect(await settleOwedByHand(db, "pay-1", hand(200_000))).toMatchObject({
      settledPaise: 200_000,
      stillOwedPaise: 300_000,
      note: "Settled ₹2000.00 of the owed ₹5000.00; ₹3000.00 still owed and retrying.",
    });
    expect(updates).toEqual([
      { where: CAS, data: { refundOwedPaise: 300_000 } },
    ]);
  });

  it("reads a full-balance marker as the balance before the hand refund", async () => {
    const { db, updates } = fakeDb({ owed: null });
    await settleOwedByHand(db, "pay-1", hand(200_000, 500_000));
    expect(updates).toEqual([
      {
        where: { ...CAS, refundOwedPaise: null },
        data: { refundOwedPaise: 300_000 },
      },
    ]);
  });

  it("answers nothing settled when the CAS loses a race", async () => {
    const { db } = fakeDb({ casWins: false });
    expect(await settleOwedByHand(db, "pay-1", hand(200_000))).toBeNull();
  });

  it("refuses while the marker's own refund is in flight", async () => {
    const { db, updates } = fakeDb({ own: "PENDING" });
    await expect(
      settleOwedByHand(db, "pay-1", hand(500_000)),
    ).rejects.toMatchObject({ code: "OWED_REFUND_IN_FLIGHT" });
    expect(updates).toEqual([]);
  });

  it("refuses a partial credit return against a whole credit restoration", async () => {
    const { db, updates } = fakeDb({ owed: null });
    await expect(
      settleOwedByHand(db, "pay-1", { kind: "credits-part" }),
    ).rejects.toMatchObject({ code: "OWED_RESTORATION_WHOLE" });
    expect(updates).toEqual([]);
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
