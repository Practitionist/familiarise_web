/**
 * @jest-environment node
 */

/**
 * An owed refund always has an exit: an operator's hand refund settles it in
 * the refund's own transaction, a hand refund that fails gives it back once,
 * and the needs-human queue lists a stuck one until it is gone.
 */
const mockPaymentFindMany = jest.fn();

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: { findMany: (...a: unknown[]) => mockPaymentFindMany(...a) },
  },
}));
const mockRecordSystemError = jest.fn();
jest.mock("@/lib/enterprise/system-events", () => ({
  recordSystemErrorSafe: jest.fn(),
  recordSystemError: (...a: unknown[]) => mockRecordSystemError(...a),
}));
jest.mock("@/lib/payments/operations/booking-refund", () => ({
  refundBookingPayment: jest.fn(),
}));

import type { Tx } from "@/lib/prisma";
import { readStuckOwedRefunds } from "@/lib/backoffice/needs-human";
import {
  MAX_REFUND_OWED_ATTEMPTS,
  restoreOwedOnFailedRefund,
  settleOwedByHand,
} from "@/lib/payments/operations/refund-owed";

function fakeDb(
  opts: {
    own?: "PENDING" | "SUCCEEDED";
    owed?: number | null;
    attempts?: number;
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
        refundOwedAttempts: opts.attempts ?? 1,
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

  it("tells the operator a remainder whose retries are spent needs a hand refund", async () => {
    const { db } = fakeDb({ attempts: MAX_REFUND_OWED_ATTEMPTS });
    expect((await settleOwedByHand(db, "pay-1", hand(200_000)))?.note).toBe(
      "Settled ₹2000.00 of the owed ₹5000.00; ₹3000.00 still owed, and its automatic retries are spent: refund it by hand.",
    );
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

  it("settles nothing for a zero or negative hand amount", async () => {
    for (const handPaise of [0, -100]) {
      const { db, updates } = fakeDb();
      expect(await settleOwedByHand(db, "pay-1", hand(handPaise))).toBeNull();
      expect(updates).toEqual([]);
    }
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

/** A FAILED hand refund on a ₹100 payment and the payment's marker, as one transaction sees them. */
function failedHandRefund(opts: {
  settledPaise: number;
  marker: { key: string; paise: number } | null;
  refundedElsewherePaise?: number;
  /** Another hand refund moves the marker to this amount just before the first write. */
  movedTo?: number;
}) {
  const refund = {
    paymentId: "pay-1",
    status: "FAILED",
    updatedAt: new Date(1),
    metadata: {
      source: "app",
      settledOwed: {
        key: "cancel:appt-1:pay-1",
        reason: "cancellation",
        owedPaise: 5_000,
        settledPaise: opts.settledPaise,
        stillOwedPaise: 5_000 - opts.settledPaise,
        note: "",
      },
    } as Record<string, unknown>,
  };
  const payment = {
    amount: 10_000,
    paymentStatus: "SUCCEEDED",
    deletedAt: null,
    refundOwedKey: opts.marker?.key ?? null,
    refundOwedPaise: opts.marker?.paise ?? null,
    refundOwedAttempts: 1,
    refundOwedNextAt: null as Date | null,
    refunds: opts.refundedElsewherePaise
      ? [{ amountPaise: opts.refundedElsewherePaise, status: "SUCCEEDED" }]
      : [],
    disputes: [],
  };
  const tx = {
    refund: {
      findUnique: jest.fn(async () => ({ ...refund })),
      updateMany: jest.fn(
        async (a: {
          where: { updatedAt: Date };
          data: { metadata: Record<string, unknown> };
        }) => {
          if (a.where.updatedAt.getTime() !== refund.updatedAt.getTime())
            return { count: 0 };
          refund.metadata = a.data.metadata;
          refund.updatedAt = new Date(refund.updatedAt.getTime() + 1);
          return { count: 1 };
        },
      ),
    },
    payment: {
      findUnique: jest.fn(async () => ({ ...payment })),
      updateMany: jest.fn(
        async (a: {
          where: { refundOwedKey: string | null; refundOwedPaise?: number };
          data: Record<string, unknown>;
        }) => {
          if (opts.movedTo !== undefined) {
            payment.refundOwedPaise = opts.movedTo;
            opts.movedTo = undefined;
          }
          if (
            a.where.refundOwedKey !== payment.refundOwedKey ||
            ("refundOwedPaise" in a.where &&
              a.where.refundOwedPaise !== payment.refundOwedPaise)
          )
            return { count: 0 };
          Object.assign(payment, a.data);
          return { count: 1 };
        },
      ),
    },
  };
  return { tx: tx as unknown as Tx, refund, payment };
}

describe("restoreOwedOnFailedRefund", () => {
  it("grows a partly reduced marker back by what the hand refund settled", async () => {
    const { tx, payment, refund } = failedHandRefund({
      settledPaise: 2_000,
      marker: { key: "cancel:appt-1:pay-1", paise: 3_000 },
    });
    await restoreOwedOnFailedRefund(tx, "rf-1");
    expect(payment).toMatchObject({
      refundOwedKey: "cancel:appt-1:pay-1",
      refundOwedPaise: 5_000,
      refundOwedAttempts: 1,
    });
    expect(refund.metadata).toMatchObject({
      settledOwedRestored: true,
      settledOwedRestoredPaise: 2_000,
    });
  });

  it("gives back against the debt as it stands after another hand refund", async () => {
    // A settled 1,000 of 5,000 (to 4,000); B then settled 1,000 more (to 3,000); A failed.
    const { tx, payment } = failedHandRefund({
      settledPaise: 1_000,
      marker: { key: "cancel:appt-1:pay-1", paise: 3_000 },
      refundedElsewherePaise: 1_000,
      movedTo: 2_000,
    });
    await restoreOwedOnFailedRefund(tx, "rf-1");
    // B moved it again mid-restore; the re-read still adds back exactly A's 1,000.
    expect(payment.refundOwedPaise).toBe(3_000);
  });

  it("re-stamps a cleared marker under a new key, after the grace", async () => {
    const { tx, payment } = failedHandRefund({
      settledPaise: 5_000,
      marker: null,
    });
    await restoreOwedOnFailedRefund(tx, "rf-1");
    expect(payment).toMatchObject({
      refundOwedKey: "cancel:appt-1:pay-1:restored:rf-1",
      refundOwedPaise: 5_000,
      refundOwedAttempts: 0,
    });
    expect(payment.refundOwedNextAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("gives it back once, however often the failure is replayed", async () => {
    const { tx, payment } = failedHandRefund({
      settledPaise: 2_000,
      marker: { key: "cancel:appt-1:pay-1", paise: 3_000 },
    });
    await restoreOwedOnFailedRefund(tx, "rf-1");
    await restoreOwedOnFailedRefund(tx, "rf-1");
    expect(payment.refundOwedPaise).toBe(5_000);
  });

  it("caps a re-stamp at what is still refundable", async () => {
    const { tx, payment, refund } = failedHandRefund({
      settledPaise: 5_000,
      marker: null,
      refundedElsewherePaise: 7_500,
    });
    await restoreOwedOnFailedRefund(tx, "rf-1");
    expect(payment.refundOwedPaise).toBe(2_500);
    expect(refund.metadata).toMatchObject({ settledOwedRestoredPaise: 2_500 });
  });

  it("caps the give-back at the refundable balance", async () => {
    const { tx, payment, refund } = failedHandRefund({
      settledPaise: 5_000,
      marker: null,
      refundedElsewherePaise: 10_000,
    });
    await restoreOwedOnFailedRefund(tx, "rf-1");
    expect(payment.refundOwedKey).toBeNull();
    expect(refund.metadata).toMatchObject({
      settledOwedRestored: true,
      settledOwedRestoredPaise: 0,
    });
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
        refundOwedPaise: 15_000_000,
        refundOwedAt: at,
        refundOwedAttempts: MAX_REFUND_OWED_ATTEMPTS,
        disputes: [],
        user: { name: "Priya Shah" },
        appointment: {
          appointmentType: "SUBSCRIPTION",
          consultation: null,
          subscription: { subscriptionPlan: { title: "Weekly coaching" } },
          webinar: null,
          class: null,
          trial: null,
        },
      },
      {
        id: "pay-2",
        createdAt: at,
        refundOwedKey: "cancel:appt-2:pay-2",
        refundOwedPaise: null,
        refundOwedAt: at,
        refundOwedAttempts: 0,
        disputes: [{ id: "dsp-1" }],
        user: { name: null },
        appointment: null,
      },
    ]);
    const items = await readStuckOwedRefunds();
    expect(items.map((i) => [i.paymentId, i.kind])).toEqual([
      ["pay-1", "stuck-owed-refund"],
      ["pay-2", "stuck-owed-refund"],
    ]);
    expect(items[0].message).toMatch(
      /^Priya Shah is owed a refund of ₹1,50,000\.00 on Weekly coaching/,
    );
    expect(items[0].message).not.toContain("pay-1");
    expect(items[0].message).not.toContain("plan-end:");
    expect(items[1].message).toContain("live dispute");
    expect(items[1].message).toContain("the full balance");
    for (const item of items) {
      expect(item.message).toMatch(
        / Its earnings stay held until this is settled\.$/,
      );
    }
  });
});
