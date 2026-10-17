/**
 * @jest-environment node
 */

// A refund a door owes is a marker on the payment: stamped in the door's
// commit, driven under its own key after it, and drained by the retry sweep.
// The fake keeps payments and refunds in memory so the drive, the whole-event
// bite and the sweep all read the same state.

type Row = {
  id: string;
  amount: number;
  paymentIntent: string;
  refundOwedKey: string | null;
  refundOwedPaise: number | null;
  refundOwedReason: string | null;
  refundOwedAt: Date | null;
  refundOwedAttempts: number;
  disputed: boolean;
};
type RefundRow = {
  id: string;
  paymentId: string;
  dedupeKey: string;
  amountPaise: number;
};

const mockRows = new Map<string, Row>();
const mockRefunds: RefundRow[] = [];
const mockRefundBookingPayment = jest.fn();
const mockRecordSystemError = jest.fn(async () => undefined);
const mockRecordSystemEvent = jest.fn(async () => undefined);

const longAgo = () => new Date(Date.now() - 3 * 60 * 60_000);

function seat(id: string, amount: number, paymentIntent = `order_${id}`): Row {
  const row: Row = {
    id,
    amount,
    paymentIntent,
    refundOwedKey: null,
    refundOwedPaise: null,
    refundOwedReason: null,
    refundOwedAt: null,
    refundOwedAttempts: 0,
    disputed: false,
  };
  mockRows.set(id, row);
  return row;
}

type Where = Record<string, unknown> & {
  id?: string | { in: string[] };
  refundOwedKey?: string | null | { not: null };
  refundOwedAttempts?: number | { lt: number };
  disputes?: unknown;
  description?: unknown;
};

function matches(row: Row, where: Where): boolean {
  if (where.description) return false;
  if (typeof where.id === "string" && row.id !== where.id) return false;
  if (where.id && typeof where.id === "object" && !where.id.in.includes(row.id))
    return false;
  if (where.refundOwedKey === null && row.refundOwedKey !== null) return false;
  if (
    typeof where.refundOwedKey === "string" &&
    row.refundOwedKey !== where.refundOwedKey
  )
    return false;
  if (
    where.refundOwedKey &&
    typeof where.refundOwedKey === "object" &&
    !row.refundOwedKey
  )
    return false;
  const attempts = where.refundOwedAttempts;
  if (typeof attempts === "number" && row.refundOwedAttempts !== attempts)
    return false;
  if (
    attempts &&
    typeof attempts === "object" &&
    row.refundOwedAttempts >= attempts.lt
  )
    return false;
  if (where.disputes && row.disputed) return false;
  return true;
}

const view = (row: Row) => ({
  ...row,
  refunds: mockRefunds
    .filter((r) => r.paymentId === row.id)
    .map((r) => ({ amountPaise: r.amountPaise, status: "SUCCEEDED" })),
  disputes: [],
});

const mockDb = {
  payment: {
    findMany: jest.fn(
      async ({ where, take }: { where: Where; take?: number }) =>
        [...mockRows.values()]
          .filter((r) => matches(r, where))
          .slice(0, take)
          .map(view),
    ),
    updateMany: jest.fn(
      async ({ where, data }: { where: Where; data: Partial<Row> }) => {
        const hit = [...mockRows.values()].filter((r) => matches(r, where));
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      },
    ),
  },
  dispute: {
    findMany: jest.fn(async () =>
      [...mockRows.values()]
        .filter((r) => r.disputed)
        .map((r) => ({ paymentId: r.id, status: "UNDER_REVIEW" })),
    ),
  },
  refund: { findMany: jest.fn(async () => []) },
  consultantEarnings: { updateMany: jest.fn(async () => ({ count: 1 })) },
  organizationEarnings: { updateMany: jest.fn(async () => ({ count: 0 })) },
  referralCreditUsage: { findMany: jest.fn(async () => []) },
  systemEvent: { findFirst: jest.fn(async () => null) },
  // The batched stamp: one statement whose values are [ids, keys, owed, reasons].
  $executeRaw: jest.fn(async (sql: { values: unknown[] }) => {
    const [ids, keys, owed, reasons] = sql.values as [
      string[],
      string[],
      (number | null)[],
      string[],
    ];
    let count = 0;
    ids.forEach((id, i) => {
      const r = mockRows.get(id);
      if (!r || r.refundOwedKey) return;
      Object.assign(r, {
        refundOwedKey: keys[i],
        refundOwedPaise: owed[i],
        refundOwedReason: reasons[i],
        refundOwedAt: longAgo(),
      });
      count += 1;
    });
    return count;
  }),
  $transaction: jest.fn(
    async (fn: (tx: unknown) => unknown): Promise<unknown> => fn(mockDb),
  ),
};

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  get default() {
    return mockDb;
  },
}));
jest.mock("../../lib/payments/operations/booking-refund", () => ({
  refundBookingPayment: (input: unknown) => mockRefundBookingPayment(input),
}));
jest.mock("../../lib/payments/operations/refund", () => {
  class RefundValidationError extends Error {
    constructor(
      message: string,
      readonly code: string,
    ) {
      super(message);
    }
  }
  return {
    RefundValidationError,
    RefundGatewayError: class extends Error {},
    findDedupedRefund: async (key: string) => {
      const r = mockRefunds.find((x) => x.dedupeKey === key);
      return r
        ? {
            refundId: r.id,
            amountRefundedPaise: r.amountPaise,
            status: "SUCCEEDED",
          }
        : null;
    },
  };
});
jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemError: (...a: unknown[]) => mockRecordSystemError(...(a as [])),
  recordSystemErrorSafe: (...a: unknown[]) =>
    mockRecordSystemError(...(a as [])),
  recordSystemEvent: (...a: unknown[]) => mockRecordSystemEvent(...(a as [])),
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: (_k: string, _o: unknown, fn: () => unknown) => fn(),
}));
jest.mock("../../lib/payments/webhooks/handlers", () => ({
  releaseBlockedBookingHold: jest.fn(),
  settleAutoRefundMarker: jest.fn(),
}));

import { refundWholeEventPayments } from "../../lib/payments/operations/event-refunds";
import { driveRefundOwed } from "../../lib/payments/operations/refund-owed";
import { retryAutoRefunds } from "../../scripts/payments/retry-auto-refunds";

/** The front door: one Refund per key, the credits rail refusing an amount. */
function settles() {
  mockRefundBookingPayment.mockImplementation(
    async (input: {
      paymentId: string;
      amountPaise?: number;
      dedupeKey: string;
    }) => {
      const row = mockRows.get(input.paymentId)!;
      const amountPaise = input.amountPaise ?? row.amount;
      const refund = {
        id: `rf_${mockRefunds.length + 1}`,
        paymentId: row.id,
        dedupeKey: input.dedupeKey,
        amountPaise,
      };
      mockRefunds.push(refund);
      return {
        refundId: refund.id,
        amountRefundedPaise: amountPaise,
        rail: "GATEWAY",
      };
    },
  );
}

beforeEach(() => {
  mockRows.clear();
  mockRefunds.length = 0;
  mockRefundBookingPayment.mockReset();
  mockRecordSystemError.mockClear();
  mockRecordSystemEvent.mockClear();
  settles();
});

const marker = (id: string, amountPaise: number | null) => {
  const r = mockRows.get(id)!;
  Object.assign(r, {
    refundOwedKey: `cancel:appt:${id}`,
    refundOwedPaise: amountPaise,
    refundOwedReason: "cancellation",
    refundOwedAt: longAgo(),
  });
  return {
    paymentId: id,
    amountPaise,
    key: `cancel:appt:${id}`,
    reason: "cancellation",
  };
};

describe("driveRefundOwed", () => {
  it("refunds under the marker's key and clears it; a repeat is a dedupe no-op", async () => {
    seat("p1", 10_000);
    const owed = marker("p1", 5_000);

    expect((await driveRefundOwed(owed)).kind).toBe("refunded");
    expect(mockRefundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        amountPaise: 5_000,
        dedupeKey: "cancel:appt:p1",
      }),
    );
    expect(mockRows.get("p1")!.refundOwedKey).toBeNull();

    expect((await driveRefundOwed(owed)).kind).toBe("replayed");
    expect(mockRefunds).toHaveLength(1);
  });

  it("restores a credits-rail marker in full, with no amount", async () => {
    seat("p1", 0, "free_abc");
    await driveRefundOwed(marker("p1", null));
    expect(mockRefundBookingPayment.mock.calls[0][0]).not.toHaveProperty(
      "amountPaise",
    );
  });

  it("keeps a failed drive's marker, counts it, and pages once at the cap", async () => {
    seat("p1", 10_000);
    mockRefundBookingPayment.mockRejectedValue(new Error("gateway 503"));
    const owed = marker("p1", 5_000);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const outcome = await driveRefundOwed({ ...owed, attempts: attempt });
      expect(outcome.kind).toBe("failed");
    }
    expect(mockRows.get("p1")!.refundOwedKey).toBe("cancel:appt:p1");
    expect(mockRows.get("p1")!.refundOwedAttempts).toBe(3);
    expect(mockRecordSystemError).toHaveBeenCalledTimes(1);
  });
});

describe("whole-event refunds", () => {
  it("stamps every seat, drives ten inline, and the sweep drains the rest, each keyed", async () => {
    for (let i = 1; i <= 25; i += 1) seat(`s${i}`, 1_000);

    const summary = await refundWholeEventPayments(
      "webinar",
      "web1",
      "cancelled",
      "u1",
    );
    expect(summary.refundsIssued).toBe(10);
    expect(summary.deferred).toBe(15);
    expect(summary.alreadyRefunded).toBe(false);

    await retryAutoRefunds({ limit: 10 });
    const last = await retryAutoRefunds({ limit: 10 });
    expect(last.owed.refunded).toBe(5);

    expect(mockRefunds).toHaveLength(25);
    expect(new Set(mockRefunds.map((r) => r.dedupeKey)).size).toBe(25);
    expect(mockRefunds[0].dedupeKey).toBe("event-cancel:web1:pay:s1");
    // A repeat sweep finds nothing left to drive.
    expect((await retryAutoRefunds({ limit: 10 })).owed.scanned).toBe(0);
  });

  it("refunds a class seat only its undelivered share", async () => {
    seat("c1", 10_000);
    const ledgers = new Map([
      [
        "c1",
        { unitPaise: BigInt(2_500), deliveredHeld: 2, occRefundedPaise: 0 },
      ],
    ]);
    await refundWholeEventPayments("class", "cls1", "cancelled", "u1", {
      ledgers: ledgers as never,
    });
    expect(mockRefunds[0].amountPaise).toBe(5_000);
  });

  it("escalates a credit seat delivered part of a series instead of stamping it", async () => {
    seat("f1", 0, "free_abc");
    const ledgers = new Map([
      ["f1", { unitPaise: BigInt(0), deliveredHeld: 1, occRefundedPaise: 0 }],
    ]);
    const summary = await refundWholeEventPayments(
      "class",
      "cls1",
      "cancelled",
      "u1",
      { ledgers: ledgers as never },
    );
    expect(mockRows.get("f1")!.refundOwedKey).toBeNull();
    expect(mockRefundBookingPayment).not.toHaveBeenCalled();
    expect(summary.failures).toEqual([
      expect.objectContaining({ paymentId: "f1" }),
    ]);
  });

  it("holds back a disputed seat, keeping its marker for after the dispute", async () => {
    seat("d1", 1_000).disputed = true;
    seat("d2", 1_000);
    const summary = await refundWholeEventPayments(
      "webinar",
      "web1",
      "cancelled",
      "u1",
    );
    expect(summary.refundsIssued).toBe(1);
    expect(summary.failures[0]).toMatchObject({ paymentId: "d1" });
    expect(mockRows.get("d1")!.refundOwedKey).toBe("event-cancel:web1:pay:d1");
    // The sweep skips a live dispute too.
    expect((await retryAutoRefunds()).owed.scanned).toBe(0);
  });
});

describe("retry-auto-refunds: the owed cohort", () => {
  it("starts a settled trial refund's earnings hold", async () => {
    seat("t1", 0, "free_abc");
    Object.assign(mockRows.get("t1")!, {
      refundOwedKey: "trial-cancel:trial-1:t1",
      refundOwedReason: "trial cancellation",
      refundOwedAt: longAgo(),
    });
    await retryAutoRefunds();
    expect(mockDb.consultantEarnings.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ paymentId: "t1", holdUntil: null }),
      }),
    );
  });

  it("surfaces markers older than two hours once, reading the persisted amount", async () => {
    seat("p1", 10_000);
    marker("p1", 4_000);
    mockRefundBookingPayment.mockRejectedValue(new Error("gateway 503"));

    const result = await retryAutoRefunds();
    expect(result.owed.failed).toBe(1);
    expect(result.owed.aged).toBe(1);
    expect(mockRecordSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        context: {
          owed: [
            expect.objectContaining({ paymentId: "p1", owedPaise: 4_000 }),
          ],
        },
      }),
    );
  });
});
