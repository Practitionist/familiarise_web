/**
 * @jest-environment node
 */

/**
 * A conduct removal that support does not decide in 72 hours refunds the seat
 * for what it was not delivered, measured at the removal: a session that had
 * ended by then keeps its pay, a session under way or later is refunded, and
 * the sessions the class held afterwards were never the seat's.
 */

/** The marker the lapse stamps on the seat's payment, as `stampRefundOwed` writes it. */
const mockStamp = jest.fn(
  async (_args: {
    where: { id: string };
    data: { refundOwedKey: string; refundOwedPaise: number | null };
  }) => ({ count: 1 }),
);
const mockMessages: string[] = [];
const mockSeat = {
  amount: 800_000,
  listPaise: 800_000,
  paymentIntent: "order_1",
  boughtAt: new Date(0),
  sessionsPurchased: 8 as number | null,
  removedAt: new Date(0),
  totalSessions: 8 as number | null,
  occurrences: [] as Record<string, unknown>[],
};

const mockTx = {
  $queryRaw: jest.fn(async () => [{ id: "case-1" }]),
  supportCase: {
    updateMany: jest.fn(async () => ({ count: 1 })),
    findUniqueOrThrow: jest.fn(async () => ({
      appointmentId: "appt-1",
      requesterUserId: "learner-1",
      createdAt: mockSeat.removedAt,
      statutoryDueAt: null,
    })),
    update: jest.fn(async () => ({ messageSeq: 1 })),
  },
  supportCaseEvent: {
    create: jest.fn(async () => ({})),
    // The order the removal ended, as its CREATED event records it.
    findFirst: jest.fn(async () => ({
      fromValue: `removal-order:${mockSeat.paymentIntent}`,
    })),
  },
  supportCaseMessage: {
    create: jest.fn(async (args: { data: { body: string } }) => {
      mockMessages.push(args.data.body);
      return {};
    }),
  },
  payment: {
    findFirst: jest.fn(async () => ({
      id: "pay-1",
      amount: mockSeat.amount,
      originalAmount: mockSeat.listPaise,
      paymentIntent: mockSeat.paymentIntent,
      refundOwedKey: null,
      createdAt: mockSeat.boughtAt,
      refunds: [],
      disputes: [],
    })),
    updateMany: (args: Parameters<typeof mockStamp>[0]) => mockStamp(args),
  },
  appointmentParticipant: {
    findUnique: jest.fn(async () => ({
      createdAt: mockSeat.boughtAt,
      sessionsPurchased: mockSeat.sessionsPurchased,
    })),
  },
  appointment: {
    findMany: jest.fn(async () => [
      {
        id: "appt-1",
        class:
          mockSeat.totalSessions === null
            ? null
            : { classPlan: { totalSessions: mockSeat.totalSessions } },
      },
    ]),
  },
  appointmentOccurrence: {
    findMany: jest.fn(async () => mockSeat.occurrences),
  },
  refund: { findMany: jest.fn(async () => []) },
  systemEvent: { create: jest.fn(async (_args: { data: unknown }) => ({})) },
};

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    $queryRaw: jest.fn(async () => [{ id: "case-1" }]),
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(mockTx)),
    // The drive after the commit clears the marker it refunded.
    payment: { updateMany: jest.fn(async () => ({ count: 1 })) },
  },
  ALLOCATION_TX_MAX_WAIT_MS: 1000,
  ALLOCATION_TX_TIMEOUT_MS: 1000,
}));
// The refund door has its own suites; this one pins what the lapse stamps.
jest.mock("@/lib/payments/operations/booking-refund", () => ({
  refundBookingPayment: jest.fn(async (input: { amountPaise?: number }) => ({
    refundId: "rf-1",
    amountRefundedPaise: input.amountPaise ?? 0,
  })),
}));
jest.mock("@/lib/payments/operations/refund", () => ({
  findDedupedRefund: jest.fn(async () => null),
  RefundGatewayError: class extends Error {},
  RefundValidationError: class extends Error {},
}));

import { sweepConductRemovalDeadlines } from "@/lib/support/conduct-removal-case";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FIRST = new Date("2026-11-02T10:00:00.000Z");
/** When session `n` (1-based) of a daily class starts. */
const startOf = (n: number) => new Date(FIRST.getTime() + (n - 1) * DAY);

/** A daily, hour-long class of `sessions`, with each row's status as the lapse run reads it. */
function dailyClass(sessions: number, lapseAt: Date) {
  return Array.from({ length: sessions }, (_, i) => {
    const startsAt = startOf(i + 1);
    const endsAt = new Date(startsAt.getTime() + HOUR);
    return {
      appointmentId: "appt-1",
      ordinal: i + 1,
      startsAt,
      endsAt,
      completionStatus: endsAt <= lapseAt ? "COMPLETED" : "SCHEDULED",
      movedAt: null,
      hostCancelledAt: null,
      voidedAt: null,
      outcome: null,
    };
  });
}

/** Removes the seat at `removedAt` and runs the lapse 72 hours later. */
async function lapse(opts: {
  removedAt: Date;
  sessions?: number;
  seat?: Partial<typeof mockSeat>;
}) {
  const lapseAt = new Date(opts.removedAt.getTime() + 72 * HOUR);
  Object.assign(mockSeat, {
    amount: 800_000,
    listPaise: 800_000,
    paymentIntent: "order_1",
    boughtAt: new Date(FIRST.getTime() - 20 * DAY),
    sessionsPurchased: 8,
    totalSessions: 8,
    ...opts.seat,
    removedAt: opts.removedAt,
    occurrences: dailyClass(opts.sessions ?? 8, lapseAt),
  });
  await sweepConductRemovalDeadlines({ limit: 5, now: lapseAt, errors: [] });
  const stamped = mockStamp.mock.calls[0]?.[0];
  return stamped
    ? {
        paymentId: stamped.where.id,
        key: stamped.data.refundOwedKey,
        amountPaise: stamped.data.refundOwedPaise,
      }
    : null;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockMessages.length = 0;
});

describe("a lapsed conduct removal on a class of 8 sessions for ₹8,000", () => {
  it("removed after session 3: ₹5,000 back, though the class held three more sessions before the lapse", async () => {
    const marker = await lapse({
      removedAt: new Date(startOf(3).getTime() + 2 * HOUR),
    });

    expect(marker).toMatchObject({
      paymentId: "pay-1",
      amountPaise: 500_000,
      key: "conduct-removal:case-1:pay:pay-1",
    });
    expect(mockMessages).toEqual([
      expect.stringContaining("had not been delivered when you were removed"),
    ]);
  });

  it("removed while session 4 was under way: that session is not delivered, so still ₹5,000", async () => {
    const marker = await lapse({
      removedAt: new Date(startOf(4).getTime() + HOUR / 2),
    });

    expect(marker?.amountPaise).toBe(500_000);
  });

  it("removed before any session: the whole ₹8,000", async () => {
    const marker = await lapse({
      removedAt: new Date(FIRST.getTime() - 2 * DAY),
    });

    expect(marker?.amountPaise).toBe(800_000);
  });

  it("a late joiner who bought sessions 3 to 8 for ₹6,000, removed after session 4: ₹4,000", async () => {
    const marker = await lapse({
      removedAt: new Date(startOf(4).getTime() + 2 * HOUR),
      seat: {
        amount: 600_000,
        sessionsPurchased: 6,
        boughtAt: new Date(startOf(2).getTime() + 2 * HOUR),
      },
    });

    expect(marker?.amountPaise).toBe(400_000);
  });

  it("a seat with no stored session count keeps its ₹1,000 unit: ₹5,000 after session 3", async () => {
    const marker = await lapse({
      removedAt: new Date(startOf(3).getTime() + 2 * HOUR),
      seat: { sessionsPurchased: null },
    });

    expect(marker?.amountPaise).toBe(500_000);
  });
});

describe("a lapsed conduct removal on a credit-funded class seat", () => {
  const credits = { amount: 0, paymentIntent: "free_1" };

  it("removed before any session: the credit is restored whole", async () => {
    const marker = await lapse({
      removedAt: new Date(FIRST.getTime() - 2 * DAY),
      seat: credits,
    });

    expect(marker).toMatchObject({ paymentId: "pay-1", amountPaise: null });
  });

  it("removed after session 3: the credits rail cannot split, so a person returns the rest", async () => {
    const marker = await lapse({
      removedAt: new Date(startOf(3).getTime() + 2 * HOUR),
      seat: credits,
    });

    expect(marker).toBeNull();
    expect(mockTx.systemEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        correlationId: "partial-credit:pay-1",
      }),
    });
  });
});

describe("a lapsed conduct removal on a one-session webinar seat", () => {
  const webinar = {
    amount: 100_000,
    listPaise: 100_000,
    sessionsPurchased: null,
    totalSessions: null,
  };

  it("removed mid-webinar: refunded in full", async () => {
    const marker = await lapse({
      removedAt: new Date(FIRST.getTime() + HOUR / 2),
      sessions: 1,
      seat: webinar,
    });

    expect(marker?.amountPaise).toBe(100_000);
  });

  it("removed after the webinar ended: nothing is owed, and no refund is promised", async () => {
    const marker = await lapse({
      removedAt: new Date(FIRST.getTime() + 2 * HOUR),
      sessions: 1,
      seat: webinar,
    });

    expect(marker).toBeNull();
    expect(mockMessages).toEqual([]);
  });
});
