/**
 * @jest-environment node
 */

/**
 * Class-end settlement: a class that completes with sessions sold but never
 * placed stamps each live paid seat owed floor(paid × unplaced / sessions sold),
 * keyed `class-end:<classId>:pay:<paymentId>`, in the completing commit.
 * A missed session (host-cancelled or voided) keeps its place: its own unit
 * refund or make-up already answers for it.
 */

jest.mock("../../lib/payments/operations/booking-refund", () => ({
  refundBookingPayment: jest.fn(),
}));
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

import type { Tx } from "@/lib/prisma";
import {
  classEndRefundPaise,
  occurrenceRefundsPaise,
  seatLedgerFrom,
  type LedgerOccurrence,
} from "@/lib/booking/class-series";
import { stampClassEndRefundsOwed } from "@/lib/payments/operations/event-refunds";

const DAY = 86_400_000;
const NOW = new Date("2026-11-09T12:00:00Z");
const JOINED = new Date(NOW.getTime() - 60 * DAY);

/** `count` sessions held one a day from `fromDay` days after the seat joined. */
function sessions(
  count: number,
  status: LedgerOccurrence["completionStatus"] = "COMPLETED",
  fromOrdinal = 1,
): LedgerOccurrence[] {
  return Array.from({ length: count }, (_, i) => {
    const startsAt = new Date(JOINED.getTime() + (fromOrdinal + i) * DAY);
    return {
      ordinal: fromOrdinal + i,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 3_600_000),
      completionStatus: status,
      movedAt: null,
    };
  });
}

describe("the seat ledger's unplaced count and the class-end amount", () => {
  it("10 sold, 8 delivered: 2 unplaced, ₹100 seat gets floor(10,000 × 2 / 10) = 2,000 paise", () => {
    const ledger = seatLedgerFrom({
      N: 10,
      amountPaise: 10_000,
      joinedAt: JOINED,
      occurrences: sessions(8),
      now: NOW,
      sessionsPurchased: 10,
    });
    expect(ledger.unplaced).toBe(2);
    expect(classEndRefundPaise(ledger, 10_000)).toBe(BigInt(2_000));
  });

  it("floors in the buyer's disfavour only by the sub-paisa remainder: 9,999 × 1 / 3 = 3,333", () => {
    const ledger = seatLedgerFrom({
      N: 3,
      amountPaise: 9_999,
      joinedAt: JOINED,
      occurrences: sessions(2),
      now: NOW,
      sessionsPurchased: 3,
    });
    expect(ledger.unplaced).toBe(1);
    expect(classEndRefundPaise(ledger, 9_999)).toBe(BigInt(3_333));
  });

  it("a host-cancelled session and its make-up share one ordinal and are never unplaced", () => {
    const cancelled = {
      ...sessions(1, "CANCELLED", 9)[0],
      hostCancelledAt: new Date(NOW.getTime() - 5 * DAY),
    };
    const madeUp = sessions(1, "COMPLETED", 9)[0];
    const voided = {
      ...sessions(1, "VOIDED", 10)[0],
      voidedAt: new Date(NOW.getTime() - 2 * DAY),
    };
    const ledger = seatLedgerFrom({
      N: 10,
      amountPaise: 10_000,
      joinedAt: JOINED,
      occurrences: [...sessions(8), cancelled, madeUp, voided],
      now: NOW,
      sessionsPurchased: 10,
    });
    expect(ledger.unplaced).toBe(0);
    expect(classEndRefundPaise(ledger, 10_000)).toBe(BigInt(0));
  });

  it("a released row that was never re-placed counts as unplaced", () => {
    const ledger = seatLedgerFrom({
      N: 4,
      amountPaise: 8_000,
      joinedAt: JOINED,
      occurrences: [...sessions(3), ...sessions(1, "RESCHEDULED", 4)],
      now: NOW,
      sessionsPurchased: 4,
    });
    expect(ledger.unplaced).toBe(1);
    expect(classEndRefundPaise(ledger, 8_000)).toBe(BigInt(2_000));
  });

  it("a mid-series joiner is refunded against the sessions it bought, not N", () => {
    // Bought sessions 5–10 of 10 for ₹60; sessions 5–9 ran, 10 never placed.
    const before = sessions(4, "COMPLETED", -4);
    const ledger = seatLedgerFrom({
      N: 10,
      amountPaise: 6_000,
      joinedAt: JOINED,
      occurrences: [...before, ...sessions(5, "COMPLETED", 5)],
      now: NOW,
      sessionsPurchased: 6,
    });
    expect(ledger.heldCount).toBe(6);
    expect(ledger.unplaced).toBe(1);
    expect(classEndRefundPaise(ledger, 6_000)).toBe(BigInt(1_000));
  });
});

describe("occurrenceRefundsPaise reads the class-end prefix", () => {
  it("counts a class-end refund as sessions already returned on the payment", async () => {
    const findMany = jest.fn(async () => [{ amountPaise: 2_000 }]);
    const total = await occurrenceRefundsPaise(
      { refund: { findMany } } as unknown as Pick<Tx, "refund">,
      "pay-a",
    );
    expect(total).toBe(2_000);
    const calls = findMany.mock.calls as unknown as [
      { where: { OR: { dedupeKey: { startsWith: string } }[] } },
    ][];
    expect(calls[0][0].where.OR).toContainEqual({
      dedupeKey: { startsWith: "class-end:", endsWith: ":pay:pay-a" },
    });
  });
});

type SeatRow = {
  id: string;
  userId: string;
  amount: number;
  paymentIntent: string;
  refunds: { amountPaise: number; status: string }[];
  sessionsPurchased: number;
};

/** A completing transaction over one class wrapper and its seats. */
function fakeTx(opts: {
  seats: SeatRow[];
  occurrences: LedgerOccurrence[];
  classEndRefunds?: { paymentId: string; amountPaise: number }[];
  stampedRows?: number;
}) {
  const executeRaw = jest.fn(async () => opts.stampedRows ?? opts.seats.length);
  const systemEvent = jest.fn(async () => ({ id: "se" }));
  const tx = {
    payment: {
      findMany: jest.fn(async () =>
        opts.seats.map((s) => ({
          ...s,
          currency: "INR",
          createdAt: JOINED,
          appointmentId: "appt-1",
          disputes: [],
          refundOwedKey: null,
        })),
      ),
      // Another door's retrying marker, as the held-marker refusal reads it.
      findUnique: jest.fn(async () => ({
        refundOwedKey: "occ:occ-9:pay:pay-a",
        refundOwedAttempts: 0,
        disputes: [],
      })),
    },
    appointmentParticipant: {
      findMany: jest.fn(async () =>
        opts.seats.map((s) => ({
          userId: s.userId,
          paymentId: s.id,
          createdAt: JOINED,
          sessionsPurchased: s.sessionsPurchased,
        })),
      ),
    },
    appointment: {
      findUnique: jest.fn(async () => ({
        class: { classPlan: { totalSessions: 10 } },
      })),
    },
    appointmentOccurrence: { findMany: jest.fn(async () => opts.occurrences) },
    refund: {
      findMany: jest.fn(async (args: { where: { dedupeKey?: unknown } }) => {
        const key = args.where.dedupeKey as { startsWith?: string } | undefined;
        if (key?.startsWith?.startsWith("class-end:cls-1:")) {
          return opts.classEndRefunds ?? [];
        }
        return [];
      }),
    },
    referralCreditUsage: {
      findMany: jest.fn(async () => [{ paymentId: "pay-c", amount: 10_000 }]),
    },
    systemEvent: { create: systemEvent, findFirst: jest.fn(async () => null) },
    $executeRaw: executeRaw,
  };
  return { tx: tx as unknown as Tx, executeRaw, systemEvent };
}

/** The (ids, keys, amounts) the batch stamp wrote. */
function stamped(executeRaw: jest.Mock) {
  const sql = executeRaw.mock.calls[0][0] as { values: unknown[] };
  return sql.values.slice(0, 3);
}

describe("stampClassEndRefundsOwed on the completing transaction", () => {
  const card = (id: string, amount: number, extra?: Partial<SeatRow>) => ({
    id,
    userId: `u-${id}`,
    amount,
    paymentIntent: `order_${id}`,
    refunds: [],
    sessionsPurchased: 10,
    ...extra,
  });

  it("stamps every live card seat its exact unplaced share under the class-end key", async () => {
    const { tx, executeRaw } = fakeTx({
      seats: [card("pay-a", 10_000), card("pay-b", 12_345)],
      occurrences: sessions(8),
    });
    const settlement = await stampClassEndRefundsOwed(tx, "cls-1");
    expect(stamped(executeRaw)).toEqual([
      ["pay-a", "pay-b"],
      ["class-end:cls-1:pay:pay-a", "class-end:cls-1:pay:pay-b"],
      // floor(10,000 × 2 / 10) and floor(12,345 × 2 / 10)
      [2_000, 2_469],
    ]);
    expect(settlement).toEqual({ owed: 2, owedPaise: 4_469, escalated: 0 });
  });

  it("nets out a class-end refund already paid and clamps to the refundable balance", async () => {
    const { tx, executeRaw } = fakeTx({
      seats: [
        card("pay-a", 10_000),
        // ₹95 of ₹100 already refunded by support: only 500 paise are left.
        card("pay-b", 10_000, {
          refunds: [{ amountPaise: 9_500, status: "SUCCEEDED" }],
        }),
      ],
      occurrences: sessions(8),
      classEndRefunds: [{ paymentId: "pay-a", amountPaise: 1_500 }],
    });
    await stampClassEndRefundsOwed(tx, "cls-1");
    expect(stamped(executeRaw)).toEqual([
      ["pay-a", "pay-b"],
      ["class-end:cls-1:pay:pay-a", "class-end:cls-1:pay:pay-b"],
      [500, 500],
    ]);
  });

  it("stamps nothing when every sold session was placed", async () => {
    const { tx, executeRaw } = fakeTx({
      seats: [card("pay-a", 10_000)],
      occurrences: sessions(10),
    });
    expect(await stampClassEndRefundsOwed(tx, "cls-1")).toEqual({
      owed: 0,
      owedPaise: 0,
      escalated: 0,
    });
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it("queues a credit seat owed part of its value for a human in the same commit", async () => {
    const { tx, executeRaw, systemEvent } = fakeTx({
      seats: [card("pay-c", 0, { paymentIntent: "free_pay-c" })],
      occurrences: sessions(8),
    });
    const settlement = await stampClassEndRefundsOwed(tx, "cls-1");
    expect(settlement.escalated).toBe(1);
    expect(executeRaw).not.toHaveBeenCalled();
    expect(systemEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          correlationId: "partial-credit:pay-c",
        }),
      }),
    );
  });

  it("refuses the completion when another door's marker holds an owed seat", async () => {
    const { tx } = fakeTx({
      seats: [card("pay-a", 10_000)],
      occurrences: sessions(8),
      stampedRows: 0,
    });
    await expect(stampClassEndRefundsOwed(tx, "cls-1")).rejects.toMatchObject({
      httpStatus: 409,
    });
  });
});
