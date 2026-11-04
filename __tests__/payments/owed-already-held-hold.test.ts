/**
 * @jest-environment node
 */

/**
 * First writer wins on the owed-refund marker, and the losing door's amount is
 * never left untracked: in the door's own transaction it records one
 * needs-human event and holds the payment's unpaid earnings (OPERATOR, keyed
 * on that event). The needs-human list names the payment and the amount to
 * refund by hand until the hold is released.
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
const store = {
  events: [] as Event[],
  holds: [] as { sourceRef: string; releasedAt: Date | null }[],
  refunds: [] as { paymentId: string; dedupeKey: string; createdAt: Date }[],
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    systemEvent: {
      findMany: async (args: {
        where: { correlationId?: { startsWith?: string } };
      }) =>
        args.where.correlationId?.startsWith === "owed-already-held:"
          ? store.events
          : [],
    },
    earningsHold: { findMany: async () => store.holds },
    refund: { findMany: async () => store.refunds },
    referralCreditUsage: { findMany: async () => [] },
    payment: { findMany: async () => [] },
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

const MARKER: RefundOwedMarker = {
  paymentId: "pay-1",
  amountPaise: 25_000,
  key: "consultant-no-show:pay-1",
  reason: "the expert did not join",
};
const CORRELATION = "owed-already-held:pay-1:consultant-no-show:pay-1";

function txWith(opts: { heldKey: string | null; standing?: boolean }) {
  return {
    payment: {
      updateMany: jest.fn(async () => ({ count: opts.heldKey ? 0 : 1 })),
      findUnique: jest.fn(async () => ({
        id: "pay-1",
        refundOwedKey: opts.heldKey,
        refundOwedPaise: 1_000,
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
});

describe("stampOwedOrHeld when another door's marker holds the payment", () => {
  it("records one strict event and holds the consultant and organisation earnings under OPERATOR, keyed on it", async () => {
    const held = await stampOwedOrHeld(
      txWith({ heldKey: "occ:occ-1:pay:pay-1" }),
      MARKER,
    );
    expect(held).toMatchObject({
      heldKey: "occ:occ-1:pay:pay-1",
      heldPaise: 1_000,
    });
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
      txWith({ heldKey: "occ:occ-1:pay:pay-1", standing: true }),
      MARKER,
    );
    expect(mockRecordSystemEvent).not.toHaveBeenCalled();
    expect(mockPlaceEarningsHolds).toHaveBeenCalledTimes(2);
  });

  it("an earning that keeps moving is left unheld rather than failing the door", async () => {
    mockPlaceEarningsHolds.mockRejectedValueOnce(
      new EarningsHoldRaceError("consultant", ["ce-1"]),
    );
    await expect(
      stampOwedOrHeld(txWith({ heldKey: "occ:occ-1:pay:pay-1" }), MARKER),
    ).resolves.toMatchObject({ heldKey: "occ:occ-1:pay:pay-1" });
  });

  it("a door that owns the marker records nothing and holds nothing", async () => {
    expect(await stampOwedOrHeld(txWith({ heldKey: null }), MARKER)).toBeNull();
    expect(mockRecordSystemEvent).not.toHaveBeenCalled();
    expect(mockPlaceEarningsHolds).not.toHaveBeenCalled();
  });
});

describe("the needs-human list of held top-ups", () => {
  const at = new Date("2026-11-04T10:00:00Z");
  const event = (
    createdAt: Date,
    owedPaise: number | null = 25_000,
  ): Event => ({
    id: `evt-${createdAt.getTime()}`,
    message: "note",
    context: {
      paymentId: "pay-1",
      key: MARKER.key,
      heldKey: "occ:occ-1:pay:pay-1",
      owedPaise,
    },
    createdAt,
    correlationId: CORRELATION,
  });

  it("lists one row per door event while its hold is active, with the amount for the refund door", async () => {
    store.events = [event(at), event(new Date(at.getTime() + 60_000))];
    store.holds = [
      { sourceRef: CORRELATION, releasedAt: null },
      { sourceRef: CORRELATION, releasedAt: at },
    ];
    expect(await readOwedAlreadyHeld()).toEqual([
      expect.objectContaining({
        kind: "owed-already-held",
        paymentId: "pay-1",
        amountPaise: 25_000,
        createdAt: at,
        message:
          "Payment pay-1 (occ:occ-1:pay:pay-1): Another refund is still owed on this payment; refund the remaining ₹250.00 by hand, then release the hold.",
      }),
    ]);
    expect((await readRefundNeedsHuman()).map((i) => i.kind)).toContain(
      "owed-already-held",
    );
  });

  it("drops the row once every hold it placed is released", async () => {
    store.events = [event(at)];
    store.holds = [{ sourceRef: CORRELATION, releasedAt: at }];
    expect(await readOwedAlreadyHeld()).toEqual([]);
  });

  it("with no hold placed, lists it until a refund other than the holding marker's lands after it", async () => {
    store.events = [event(at, null)];
    store.refunds = [
      {
        paymentId: "pay-1",
        dedupeKey: "occ:occ-1:pay:pay-1",
        createdAt: new Date(at.getTime() + 1),
      },
    ];
    expect(await readOwedAlreadyHeld()).toEqual([
      expect.objectContaining({
        amountPaise: null,
        message:
          "Payment pay-1 (occ:occ-1:pay:pay-1): Another refund is still owed on this payment; refund the remaining balance by hand.",
      }),
    ]);
    store.refunds.push({
      paymentId: "pay-1",
      dedupeKey: "ops:hand",
      createdAt: new Date(at.getTime() + 2),
    });
    expect(await readOwedAlreadyHeld()).toEqual([]);
  });
});
