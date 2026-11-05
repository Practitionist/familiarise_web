/**
 * @jest-environment node
 */

/**
 * First writer wins on the owed-refund marker, and the losing door's amount is
 * never left untracked. In the door's own transaction it records one
 * needs-human event and holds the payment's unpaid earnings (OPERATOR, keyed
 * on that event); a race on the hold rolls the door back. The needs-human row
 * stays open while money is still owed, read from the payment's refunds and
 * balance, never from the hold, then asks for the hold to be released.
 */

const mockRecordSystemEvent = jest.fn(async () => undefined);
const mockPlaceEarningsHolds = jest.fn(async () => ["placed"]);

jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemEvent: (...a: unknown[]) => mockRecordSystemEvent(...(a as [])),
  recordSystemError: jest.fn(async () => undefined),
  recordSystemErrorSafe: jest.fn(async () => undefined),
}));
jest.mock("../../lib/payments/payouts/earnings-holds", () => ({
  ...jest.requireActual("../../lib/payments/payouts/earnings-holds"),
  placeEarningsHolds: (...a: unknown[]) => mockPlaceEarningsHolds(...(a as [])),
}));
jest.mock("../../lib/payments/operations/booking-refund", () => ({
  refundBookingPayment: jest.fn(),
}));
jest.mock("../../lib/payments/operations/refund", () => ({
  findDedupedRefund: jest.fn(async () => null),
  RefundGatewayError: class extends Error {},
  RefundValidationError: class extends Error {},
}));

type Event = {
  id: string;
  message: string;
  context: unknown;
  createdAt: Date;
  correlationId: string;
};
type Refund = {
  paymentId: string;
  dedupeKey: string;
  createdAt: Date;
  amountPaise: number;
  status: string;
  metadata?: unknown;
};
const store = {
  events: [] as Event[],
  holds: [] as { sourceRef: string; releasedAt: Date | null }[],
  refunds: [] as Refund[],
  amount: 100_000,
  /** The holding marker as it stands on the payment now (null once cleared). */
  marker: null as { key: string; paise: number } | null,
};
const mockEventRead = jest.fn();
/** The window's events, oldest first, as the reader asks. */
const inWindow = (gte?: Date) =>
  store.events
    .filter((e) => !gte || e.createdAt >= gte)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    systemEvent: {
      findMany: async (args: {
        where: {
          correlationId?: { startsWith?: string; in?: string[] };
          createdAt?: { gte: Date };
        };
        take?: number;
      }) => {
        const ids = args.where.correlationId?.in;
        if (ids)
          return store.events.filter((e) => ids.includes(e.correlationId));
        mockEventRead(args);
        if (args.where.correlationId?.startsWith !== "owed-already-held:")
          return [];
        return inWindow(args.where.createdAt?.gte).slice(0, args.take);
      },
      count: async (args: { where: { createdAt?: { gte: Date } } }) =>
        inWindow(args.where.createdAt?.gte).length,
    },
    earningsHold: {
      findMany: async () => store.holds.filter((h) => h.releasedAt === null),
    },
    refund: { findMany: async () => store.refunds },
    payment: {
      findMany: async (args: { where: { id?: unknown } }) =>
        args.where.id
          ? [
              {
                id: "pay-1",
                amount: store.amount,
                refundOwedKey: store.marker?.key ?? null,
                refundOwedPaise: store.marker?.paise ?? null,
                refunds: store.refunds,
                disputes: [],
              },
            ]
          : [],
    },
    referralCreditUsage: { findMany: async () => [] },
    supportFinancialRecommendation: { findMany: async () => [] },
  },
}));

import { EarningsHoldRaceError } from "@/lib/payments/payouts/earnings-holds";
import {
  stampOwedOrHeld,
  type RefundOwedMarker,
} from "@/lib/payments/operations/refund-owed";
import {
  readOwedAlreadyHeld,
  readRefundNeedsHuman,
} from "@/lib/backoffice/needs-human";
import type { Tx } from "@/lib/prisma";

const HELD_KEY = "occ:occ-1:pay:pay-1";
const MARKER: RefundOwedMarker = {
  paymentId: "pay-1",
  amountPaise: 25_000,
  key: "consultant-no-show:pay-1",
  reason: "the expert did not join",
};
const CORRELATION = "owed-already-held:pay-1:consultant-no-show:pay-1";

function txWith(opts: {
  heldKey: string | null;
  heldPaise?: number | null;
  standing?: boolean;
  amount?: number;
  /** Refunds already out on the payment (the holding one, when it is in flight). */
  refunds?: { amountPaise: number; status: string }[];
  heldSent?: boolean;
}) {
  return {
    refund: {
      findFirst: jest.fn(async () =>
        opts.heldSent ? { id: "rf-held" } : null,
      ),
    },
    payment: {
      updateMany: jest.fn(async () => ({ count: opts.heldKey ? 0 : 1 })),
      findUnique: jest.fn(async () => ({
        id: "pay-1",
        refundOwedKey: opts.heldKey,
        refundOwedPaise: opts.heldPaise === undefined ? 1_000 : opts.heldPaise,
        amount: opts.amount ?? 100_000,
        refunds: opts.refunds ?? [],
        disputes: [],
      })),
    },
    systemEvent: {
      findFirst: jest.fn(async () => (opts.standing ? { id: "evt-1" } : null)),
    },
    consultantEarnings: { findMany: jest.fn(async () => [{ id: "ce-1" }]) },
    organizationEarnings: { findMany: jest.fn(async () => [{ id: "oe-1" }]) },
  } as unknown as Tx;
}

beforeEach(() => {
  jest.clearAllMocks();
  store.events = [];
  store.holds = [];
  store.refunds = [];
  store.amount = 100_000;
  store.marker = null;
});

describe("stampOwedOrHeld when another door's marker holds the payment", () => {
  it("records one strict event and holds the consultant and organisation earnings under OPERATOR, keyed on it", async () => {
    const held = await stampOwedOrHeld(txWith({ heldKey: HELD_KEY }), MARKER);
    expect(held).toMatchObject({ heldKey: HELD_KEY, heldPaise: 1_000 });
    expect(mockRecordSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: CORRELATION,
        strict: true,
        context: expect.objectContaining({ owedPaise: 25_000 }),
      }),
    );
    const hold = {
      reason: "OPERATOR",
      sourceRef: CORRELATION,
      note: "Another refund is still owed on this payment; refund the remaining ₹250.00 by hand, then release the hold.",
    };
    expect(mockPlaceEarningsHolds).toHaveBeenCalledWith(
      expect.anything(),
      "consultant",
      ["ce-1"],
      hold,
    );
    expect(mockPlaceEarningsHolds).toHaveBeenCalledWith(
      expect.anything(),
      "org",
      ["oe-1"],
      hold,
    );
  });

  it("a replay writes no second event; the keyed hold is placed idempotently", async () => {
    await stampOwedOrHeld(
      txWith({ heldKey: HELD_KEY, standing: true }),
      MARKER,
    );
    expect(mockRecordSystemEvent).not.toHaveBeenCalled();
    expect(mockPlaceEarningsHolds).toHaveBeenCalledTimes(2);
  });

  it("an earning that keeps moving rolls the door back rather than leaving it held without a hold", async () => {
    mockPlaceEarningsHolds.mockRejectedValueOnce(
      new EarningsHoldRaceError("consultant", ["ce-1"]),
    );
    await expect(
      stampOwedOrHeld(txWith({ heldKey: HELD_KEY }), MARKER),
    ).rejects.toBeInstanceOf(EarningsHoldRaceError);
  });

  it("a full-balance holding marker already covers the door: no event, no hold", async () => {
    const held = await stampOwedOrHeld(
      txWith({ heldKey: HELD_KEY, heldPaise: null }),
      MARKER,
    );
    expect(held).toMatchObject({ heldKey: HELD_KEY, heldPaise: null });
    expect(mockRecordSystemEvent).not.toHaveBeenCalled();
    expect(mockPlaceEarningsHolds).not.toHaveBeenCalled();
  });

  it("a full-balance losing door owes what the holding marker leaves", async () => {
    await stampOwedOrHeld(txWith({ heldKey: HELD_KEY }), {
      ...MARKER,
      amountPaise: null,
    });
    expect(mockRecordSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ owedPaise: 99_000 }),
      }),
    );
  });

  it("the top-up is capped at the balance the holding marker leaves; nothing left records nothing", async () => {
    await stampOwedOrHeld(txWith({ heldKey: HELD_KEY, amount: 1_500 }), MARKER);
    expect(mockRecordSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ owedPaise: 500 }),
      }),
    );
    jest.clearAllMocks();
    await stampOwedOrHeld(txWith({ heldKey: HELD_KEY, amount: 1_000 }), MARKER);
    expect(mockRecordSystemEvent).not.toHaveBeenCalled();
    expect(mockPlaceEarningsHolds).not.toHaveBeenCalled();
  });

  it("a holding refund already in flight is not subtracted twice: the door still records and holds", async () => {
    await stampOwedOrHeld(
      txWith({
        heldKey: HELD_KEY,
        heldPaise: 70_000,
        refunds: [{ amountPaise: 70_000, status: "PENDING" }],
        heldSent: true,
      }),
      { ...MARKER, amountPaise: 20_000 },
    );
    expect(mockRecordSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ owedPaise: 20_000 }),
      }),
    );
    expect(mockPlaceEarningsHolds).toHaveBeenCalledTimes(2);
  });

  it("a full-balance door with the holding refund in flight owes the whole remaining balance", async () => {
    await stampOwedOrHeld(
      txWith({
        heldKey: HELD_KEY,
        heldPaise: 30_000,
        refunds: [{ amountPaise: 30_000, status: "PENDING" }],
        heldSent: true,
      }),
      { ...MARKER, amountPaise: null },
    );
    expect(mockRecordSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ owedPaise: 70_000 }),
      }),
    );
  });

  it("a door that owns the marker records nothing and holds nothing", async () => {
    expect(await stampOwedOrHeld(txWith({ heldKey: null }), MARKER)).toBeNull();
    expect(mockRecordSystemEvent).not.toHaveBeenCalled();
    expect(mockPlaceEarningsHolds).not.toHaveBeenCalled();
  });
});

describe("the needs-human list of held top-ups", () => {
  const at = new Date("2026-11-04T10:00:00Z");
  const later = (ms: number) => new Date(at.getTime() + ms);
  const event = (
    createdAt: Date,
    owedPaise: number | null = 25_000,
  ): Event => ({
    id: `evt-${createdAt.getTime()}`,
    message: "note",
    context: {
      paymentId: "pay-1",
      key: MARKER.key,
      heldKey: HELD_KEY,
      owedPaise,
    },
    createdAt,
    correlationId: CORRELATION,
  });
  const refund = (dedupeKey: string, amountPaise: number, ms = 1): Refund => ({
    paymentId: "pay-1",
    dedupeKey,
    createdAt: later(ms),
    amountPaise,
    status: "SUCCEEDED",
  });
  const read = () => readOwedAlreadyHeld(later(86_400_000));

  it("lists one row per door event while money is owed, with the amount for the refund door", async () => {
    store.events = [event(at), event(later(60_000))];
    store.holds = [{ sourceRef: CORRELATION, releasedAt: null }];
    expect(await read()).toEqual([
      expect.objectContaining({
        kind: "owed-already-held",
        paymentId: "pay-1",
        amountPaise: 25_000,
        createdAt: at,
        message: `Payment pay-1 (${HELD_KEY}): Another refund is still owed on this payment; refund the remaining ₹250.00 by hand, then release the hold.`,
      }),
    ]);
    expect((await readRefundNeedsHuman()).map((i) => i.kind)).toContain(
      "owed-already-held",
    );
  });

  it("reads a bounded, index-friendly window of events", async () => {
    await read();
    expect(mockEventRead).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          category: "PAYMENT",
          createdAt: { gte: expect.any(Date) },
        }),
        take: 500,
      }),
    );
  });

  it("an unrelated release of the hold does not close it while money is owed", async () => {
    store.events = [event(at)];
    store.holds = [{ sourceRef: CORRELATION, releasedAt: at }];
    expect(await read()).toEqual([
      expect.objectContaining({
        amountPaise: 25_000,
        message: `Payment pay-1 (${HELD_KEY}): Another refund is still owed on this payment; refund the remaining ₹250.00 by hand.`,
      }),
    ]);
  });

  it("the holding marker's own refund does not count; a partial hand refund lowers what is left", async () => {
    store.events = [event(at)];
    store.refunds = [refund(HELD_KEY, 1_000), refund("ops:part", 10_000, 2)];
    expect(await read()).toEqual([
      expect.objectContaining({ amountPaise: 15_000 }),
    ]);
  });

  it("once topped up it asks for the hold release, and leaves when the hold is gone", async () => {
    store.events = [event(at)];
    store.refunds = [refund("ops:hand", 25_000)];
    store.holds = [{ sourceRef: CORRELATION, releasedAt: null }];
    expect(await read()).toEqual([
      expect.objectContaining({
        amountPaise: null,
        message: `Payment pay-1 (${HELD_KEY}): the top-up is settled; release the hold on its earnings from the Earnings tab.`,
      }),
    ]);
    store.holds = [];
    expect(await read()).toEqual([]);
  });

  it("a hand refund that first settled the still-stamped holding refund pays nothing toward the top-up", async () => {
    // ₹1,000 paid; the holding ₹300 is stuck; the top-up is ₹200. A ₹200 hand refund settles ₹200 of the ₹300.
    store.events = [event(at, 20_000)];
    store.holds = [{ sourceRef: CORRELATION, releasedAt: null }];
    store.marker = { key: HELD_KEY, paise: 10_000 };
    store.refunds = [
      {
        ...refund("ops:hand", 20_000),
        metadata: { settledOwed: { key: HELD_KEY, settledPaise: 20_000 } },
      },
    ];
    expect(await read()).toEqual([
      expect.objectContaining({
        // The top-up, plus the ₹100 older refund the next hand refund settles first.
        amountPaise: 30_000,
        message: `Payment pay-1 (${HELD_KEY}): Another refund is still owed on this payment; refund the remaining ₹200.00 by hand, then release the hold. The older refund of ₹100.00 is still owed and a hand refund settles it first, so refund ₹300.00 in total.`,
      }),
    ]);
  });

  it("only the part of a hand refund beyond what it settled counts toward the top-up", async () => {
    store.events = [event(at, 20_000)];
    store.refunds = [
      {
        ...refund("ops:hand", 30_000),
        metadata: { settledOwed: { key: HELD_KEY, settledPaise: 10_000 } },
      },
    ];
    expect(await read()).toEqual([]);
  });

  it("two losing doors on one payment: a later refund pays the oldest top-up first", async () => {
    const second = "owed-already-held:pay-1:overage-credit:pay-1";
    store.events = [
      event(at, 20_000),
      { ...event(later(60_000), 20_000), id: "evt-2", correlationId: second },
    ];
    store.refunds = [refund("ops:hand", 20_000, 120_000)];
    expect(await read()).toEqual([
      expect.objectContaining({
        id: `owed-held:${second}`,
        amountPaise: 20_000,
      }),
    ]);
  });

  it("a top-up whose hold is still active stays listed past the window", async () => {
    const old = new Date(at.getTime() - 400 * 86_400_000);
    store.events = [event(old)];
    store.holds = [{ sourceRef: CORRELATION, releasedAt: null }];
    expect(await read()).toEqual([
      expect.objectContaining({ amountPaise: 25_000 }),
    ]);
  });

  it("past the read bound, says how many more events are not listed", async () => {
    const second = "owed-already-held:pay-1:overage-credit:pay-1";
    store.events = [
      event(at),
      { ...event(later(60_000)), id: "evt-2", correlationId: second },
    ];
    const rows = await readOwedAlreadyHeld(later(86_400_000), 1);
    expect(rows).toEqual([
      expect.objectContaining({ id: `owed-held:${CORRELATION}` }),
      expect.objectContaining({
        id: "owed-held:more",
        paymentId: null,
        message:
          "1 more held top-up events are not listed yet (oldest first). Settle the rows above, then reload.",
      }),
    ]);
  });

  it("closes when the payment has nothing left to refund", async () => {
    store.events = [event(at)];
    store.amount = 0;
    expect(await read()).toEqual([]);
  });

  it("skips an old event that recorded no amount", async () => {
    store.events = [event(at, null)];
    expect(await read()).toEqual([]);
  });
});
