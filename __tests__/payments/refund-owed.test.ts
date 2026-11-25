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
  refundOwedNextAt: Date | null;
  disputed: boolean;
};
type RefundRow = {
  id: string;
  paymentId: string;
  dedupeKey: string | null;
  amountPaise: number;
  status: "SUCCEEDED" | "PENDING" | "FAILED";
  failedNotifiedAt?: Date | null;
  createdAt?: Date;
  refundId?: string | null;
};

const mockRows = new Map<string, Row>();
const mockRefunds: RefundRow[] = [];
const mockRefundBookingPayment = jest.fn();
const mockRecordSystemError = jest.fn(async () => undefined);
const mockRecordSystemEvent = jest.fn(async () => undefined);

const longAgo = () => new Date(Date.now() - 7 * 60 * 60_000);
/** The marker's backoff ran out. */
const elapse = (id: string) => {
  mockRows.get(id)!.refundOwedNextAt = new Date(Date.now() - 1);
};

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
    refundOwedNextAt: null,
    disputed: false,
  };
  mockRows.set(id, row);
  return row;
}

type Where = Record<string, unknown> & {
  id?: string | { in: string[] };
  refundOwedKey?: string | null | { not: null };
  refundOwedAttempts?: number | { lt: number };
  OR?: { refundOwedNextAt: null | { lte: Date } }[];
  refundOwedAt?: { lt: Date };
  disputes?: unknown;
  refunds?: unknown;
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
  // The sweep's backoff claim: no next-drive time, or one already passed.
  const due = (c: { refundOwedNextAt: null | { lte: Date } }) =>
    c.refundOwedNextAt === null
      ? row.refundOwedNextAt === null
      : row.refundOwedNextAt !== null &&
        row.refundOwedNextAt <= c.refundOwedNextAt.lte;
  if (where.OR && !where.OR.some(due)) return false;
  if (
    where.refundOwedAt &&
    !(row.refundOwedAt && row.refundOwedAt < where.refundOwedAt.lt)
  )
    return false;
  if (where.disputes && row.disputed) return false;
  // The owed cohort leaves a payment with a PENDING refund to reconcile.
  if (
    where.refunds &&
    mockRefunds.some((r) => r.paymentId === row.id && r.status === "PENDING")
  )
    return false;
  return true;
}

const view = (row: Row) => ({
  ...row,
  refunds: mockRefunds
    .filter((r) => r.paymentId === row.id)
    .map((r) => ({ amountPaise: r.amountPaise, status: r.status })),
  disputes: [],
});

const mockDb = {
  payment: {
    // A snapshot, as Prisma returns: a later write does not change what was read.
    findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
      const row = mockRows.get(where.id);
      return row ? { ...row } : null;
    }),
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
  refund: {
    // Credit-seat claims read nothing; the failed-refund notifier reads FAILED rows.
    findMany: jest.fn(async ({ where }: { where: { status?: unknown } }) =>
      where.status === "FAILED"
        ? mockRefunds
            .filter((r) => r.status === "FAILED" && !r.failedNotifiedAt)
            .map((r) => ({
              createdAt: new Date(),
              ...r,
              currency: "INR",
              metadata: null,
              failureReason: null,
              failedAt: null,
              payment: {
                userId: "payer",
                organizationId: null,
                refundOwedKey: mockRows.get(r.paymentId)?.refundOwedKey ?? null,
                refundOwedAt: mockRows.get(r.paymentId)?.refundOwedAt ?? null,
              },
            }))
        : [],
    ),
    findUnique: jest.fn(
      async ({ where }: { where: { dedupeKey?: string; id?: string } }) =>
        mockRefunds.find((x) =>
          where.id ? x.id === where.id : x.dedupeKey === where.dedupeKey,
        ) ?? null,
    ),
    updateMany: jest.fn(async ({ where }: { where: { id: string } }) => {
      const r = mockRefunds.find((x) => x.id === where.id);
      if (r) r.failedNotifiedAt = new Date();
      return { count: r ? 1 : 0 };
    }),
  },
  // One tenured payee waiting on the stamp (no new-expert days).
  consultantEarnings: {
    updateMany: jest.fn(async () => ({ count: 1 })),
    findMany: jest.fn(async () => [{ consultantProfileId: "cp-1" }]),
    findFirst: jest.fn(async () => ({ createdAt: new Date(0) })),
    aggregate: jest.fn(async () => ({
      _sum: { consultantSharePaise: 9e9, refundedShareAmount: 0 },
    })),
  },
  organizationEarnings: { updateMany: jest.fn(async () => ({ count: 0 })) },
  referralCreditUsage: { findMany: jest.fn(async () => []) },
  // Every seated payment still holds a live seat.
  appointmentParticipant: {
    findMany: jest.fn(async () =>
      [...mockRows.values()].map((r) => ({ userId: "u", paymentId: r.id })),
    ),
  },
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
    RefundGatewayError: class extends Error {
      constructor(
        message: string,
        readonly gatewayCode?: string,
        readonly refundRowId?: string,
      ) {
        super(message);
      }
    },
    findDedupedRefund: async (key: string) => {
      const r = mockRefunds.find(
        (x) => x.dedupeKey === key && x.status !== "FAILED",
      );
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
const mockSendRefundFailedEmail = jest.fn(async () => []);
jest.mock("../../lib/payments", () => ({
  getRefund: jest.fn(),
  listRefunds: jest.fn(),
}));
jest.mock("../../lib/novu/service", () => ({
  notifyRefundFailed: jest.fn(async () => undefined),
  notifyRefundProcessed: jest.fn(async () => undefined),
}));
jest.mock("../../lib/email", () => ({
  stageRefundFailedEmail: (...a: unknown[]) =>
    mockSendRefundFailedEmail(...(a as [])),
  stageRefundProcessedEmail: jest.fn(async () => []),
  prepareRefundFailedEmail: jest.fn(async () => null),
  prepareRefundProcessedEmail: jest.fn(async () => null),
  EMAIL_BUDGET_MS: { JOB: 1, REQUEST: 1 },
  MONEY_EMAIL_TYPES: { REFUND_FAILED: "REFUND_FAILED" },
}));
jest.mock("../../lib/payments/webhooks/handlers", () => ({
  releaseBlockedBookingHold: jest.fn(),
  settleAutoRefundMarker: jest.fn(),
}));

import { refundWholeEventPayments } from "../../lib/payments/operations/event-refunds";
import {
  driveRefundOwed,
  failRefund,
  refuseIfOwedAlreadySent,
  settleOwedByHand,
} from "../../lib/payments/operations/refund-owed";
import { retryAutoRefunds } from "../../scripts/payments/retry-auto-refunds";
import { notifyFailedRefunds } from "../../scripts/refunds/reconcile-pending-refunds";

/** The front door: one Refund per key, and a drive only while its marker holds. */
function settles() {
  mockRefundBookingPayment.mockImplementation(
    async (input: {
      paymentId: string;
      amountPaise?: number;
      dedupeKey: string;
      owedMarker?: { key: string; amountPaise: number | null };
    }) => {
      const row = mockRows.get(input.paymentId)!;
      const held = input.owedMarker;
      if (held) {
        const { RefundValidationError } = jest.requireMock<{
          RefundValidationError: new (message: string, code: string) => Error;
        }>("../../lib/payments/operations/refund");
        if (row.refundOwedKey !== held.key)
          throw new RefundValidationError("gone", "OWED_MARKER_SETTLED");
        if (row.refundOwedPaise !== held.amountPaise)
          throw new RefundValidationError("changed", "OWED_MARKER_CHANGED");
      }
      const amountPaise = input.amountPaise ?? row.amount;
      const refund = {
        id: `rf_${mockRefunds.length + 1}`,
        paymentId: row.id,
        dedupeKey: input.dedupeKey,
        amountPaise,
        status: "SUCCEEDED" as const,
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

  it("spends no attempt on an ambiguous gateway error whose refund is still PENDING", async () => {
    seat("p1", 10_000);
    const owed = marker("p1", 5_000);
    mockRows.get("p1")!.refundOwedAttempts = 2;
    const { RefundGatewayError } = jest.requireMock<{
      RefundGatewayError: new (
        message: string,
        gatewayCode?: string,
        refundRowId?: string,
      ) => Error;
    }>("../../lib/payments/operations/refund");
    mockRefundBookingPayment.mockImplementationOnce(
      async (input: { paymentId: string; dedupeKey: string }) => {
        mockRefunds.push({
          id: "rf_ambiguous",
          paymentId: input.paymentId,
          dedupeKey: input.dedupeKey,
          amountPaise: 5_000,
          status: "PENDING",
        });
        throw new RefundGatewayError("timeout", undefined, "rf_ambiguous");
      },
    );

    const outcome = await driveRefundOwed({ ...owed, attempts: 2 });
    expect(outcome).toEqual({
      kind: "refunded",
      refund: {
        refundId: "rf_ambiguous",
        amountRefundedPaise: 5_000,
        status: "PENDING",
      },
    });
    expect(mockRows.get("p1")).toMatchObject({
      refundOwedKey: "cancel:appt:p1",
      refundOwedAttempts: 2,
    });
    expect(mockRecordSystemError).not.toHaveBeenCalled();
  });
});

describe("a drive whose own refund is still PENDING", () => {
  it("spends no attempt when the settle fails after the gateway took the refund", async () => {
    seat("p1", 10_000);
    const owed = marker("p1", 5_000);
    mockRows.get("p1")!.refundOwedAttempts = 2;
    mockRefundBookingPayment.mockImplementationOnce(
      async (input: { paymentId: string; dedupeKey: string }) => {
        // The gateway accepted it; the settling transaction then failed.
        mockRefunds.push({
          id: "rf_taken",
          paymentId: input.paymentId,
          dedupeKey: input.dedupeKey,
          amountPaise: 5_000,
          status: "PENDING",
        });
        throw new Error("cascade transaction failed");
      },
    );

    expect(await driveRefundOwed({ ...owed, attempts: 2 })).toMatchObject({
      kind: "refunded",
      refund: { refundId: "rf_taken", status: "PENDING" },
    });
    expect(mockRows.get("p1")!.refundOwedAttempts).toBe(2);
    expect(mockRecordSystemError).not.toHaveBeenCalled();
  });

  it("does not take another payment's PENDING refund under the same key as its own", async () => {
    seat("p1", 10_000);
    const owed = marker("p1", 5_000);
    // An incident key names no payment: a sibling payment's refund took it while this drive ran.
    mockRefundBookingPayment.mockImplementationOnce(async () => {
      mockRefunds.push({
        id: "rf_other",
        paymentId: "p2",
        dedupeKey: owed.key,
        amountPaise: 5_000,
        status: "PENDING",
      });
      throw new Error("cascade transaction failed");
    });

    expect(await driveRefundOwed({ ...owed, attempts: 0 })).toMatchObject({
      kind: "failed",
    });
  });
});

describe("a drive's own refund confirmed FAILED", () => {
  /** The front door reserves under the key; `failNow` fails it in-flight, as a refusal does. */
  function reservesThenThrows(failNow: boolean) {
    const { RefundGatewayError } = jest.requireMock<{
      RefundGatewayError: new (message: string, gatewayCode?: string) => Error;
    }>("../../lib/payments/operations/refund");
    mockRefundBookingPayment.mockImplementationOnce(
      async (input: { paymentId: string; dedupeKey: string }) => {
        const row: RefundRow = {
          id: `rf_${mockRefunds.length + 1}`,
          paymentId: input.paymentId,
          dedupeKey: input.dedupeKey,
          amountPaise: 5_000,
          status: "PENDING",
        };
        mockRefunds.push(row);
        if (failNow) await failRow(row);
        throw new RefundGatewayError("gateway refund failed");
      },
    );
  }
  /** The failing transaction, as reconcile or the front door runs it. */
  const failRow = (row: RefundRow) =>
    failRefund(row.id, async () => {
      row.status = "FAILED";
      return { count: 1 };
    });
  /** The key frees once its refund failed, as the front door's replay check does. */
  const freeKey = () =>
    mockRefunds.forEach((r) => {
      if (r.status === "FAILED") r.dedupeKey = null;
    });

  it("counts a refusal once, in the transaction that failed it, not again in the drive", async () => {
    seat("p1", 10_000);
    const owed = marker("p1", 5_000);
    reservesThenThrows(true);

    expect((await driveRefundOwed({ ...owed, attempts: 0 })).kind).toBe(
      "failed",
    );
    expect(mockRows.get("p1")!.refundOwedAttempts).toBe(1);
  });

  it("an ambiguous answer reconcile later fails counts, so three cycles page once", async () => {
    seat("p1", 10_000);
    const owed = marker("p1", 5_000);
    for (let cycle = 0; cycle < 3; cycle += 1) {
      reservesThenThrows(false);
      const attempts = mockRows.get("p1")!.refundOwedAttempts;
      expect((await driveRefundOwed({ ...owed, attempts })).kind).toBe(
        "refunded",
      );
      await failRow(mockRefunds[mockRefunds.length - 1]);
      freeKey();
    }
    expect(mockRows.get("p1")).toMatchObject({
      refundOwedKey: "cancel:appt:p1",
      refundOwedAttempts: 3,
      refundOwedNextAt: null,
    });
    expect(mockRecordSystemError).toHaveBeenCalledTimes(1);
    expect((await retryAutoRefunds()).owed.scanned).toBe(0);
    // Each failed attempt of a refund still owed is claimed silently: no notice per cycle.
    expect((await notifyFailedRefunds()).notified).toBe(0);
    expect(mockSendRefundFailedEmail).not.toHaveBeenCalled();
  });
});

describe("a hand refund once the owed refund already went out", () => {
  function ownRefundSucceeded() {
    seat("p1", 10_000);
    marker("p1", 5_000);
    Object.assign(mockRows.get("p1")!, { refundOwedAttempts: 3 });
    mockRefunds.push({
      id: "rf_own",
      paymentId: "p1",
      dedupeKey: "cancel:appt:p1",
      amountPaise: 5_000,
      status: "SUCCEEDED",
      createdAt: new Date("2026-11-02T06:30:00.000Z"),
      refundId: "rfnd_gw_123",
    });
  }
  /** The refusal names what went out, when, and its reference, and warns before a second payment. */
  const ALREADY_SENT_COPY =
    "₹50.00 already went back to the buyer on 2 Nov 2026 (refund rfnd_gw_123), so nothing is owed on this payment. Only submit again if you mean to refund more on top of this.";

  it("is refused inside the refund transaction, so nothing is paid twice", async () => {
    ownRefundSucceeded();
    await expect(
      settleOwedByHand(mockDb as never, "p1", { kind: "whole" }),
    ).rejects.toMatchObject({
      code: "OWED_REFUND_ALREADY_SENT",
      message: ALREADY_SENT_COPY,
    });
  });

  it("is refused before the transaction, and the stale marker is cleared", async () => {
    ownRefundSucceeded();
    await expect(
      refuseIfOwedAlreadySent("p1", mockRows.get("p1")!.refundOwedKey),
    ).rejects.toMatchObject({
      code: "OWED_REFUND_ALREADY_SENT",
      message: ALREADY_SENT_COPY,
    });
    expect(mockRows.get("p1")).toMatchObject({
      refundOwedKey: null,
      refundOwedAttempts: 0,
    });
    // The next attempt is an ordinary refund.
    await expect(
      refuseIfOwedAlreadySent("p1", mockRows.get("p1")!.refundOwedKey),
    ).resolves.toBeUndefined();
  });

  it("lets a hand refund through while the owed refund has not gone out", async () => {
    seat("p1", 10_000);
    marker("p1", 5_000);
    await expect(
      refuseIfOwedAlreadySent("p1", mockRows.get("p1")!.refundOwedKey),
    ).resolves.toBeUndefined();
    expect(mockRows.get("p1")!.refundOwedKey).toBe("cancel:appt:p1");
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

  it("refunds the disputed seat its stamped share once the dispute is won, spending no attempt while it waited", async () => {
    seat("d1", 8_000).disputed = true;
    const ledgers = new Map([
      [
        "d1",
        { unitPaise: BigInt(1_000), deliveredHeld: 3, occRefundedPaise: 0 },
      ],
    ]);
    await refundWholeEventPayments("class", "cls1", "cancelled", "u1", {
      ledgers: ledgers as never,
    });
    await retryAutoRefunds();
    expect(mockRefunds).toHaveLength(0);
    expect(mockRows.get("d1")!.refundOwedAttempts).toBe(0);

    mockRows.get("d1")!.disputed = false;
    const won = await retryAutoRefunds();

    expect(won.owed.refunded).toBe(1);
    expect(mockRefunds).toEqual([
      expect.objectContaining({
        paymentId: "d1",
        amountPaise: 5_000,
        dedupeKey: "event-cancel:cls1:pay:d1",
      }),
    ]);
    expect(mockRows.get("d1")!.refundOwedKey).toBeNull();
  });

  it("clears the disputed seat's marker with nothing refunded once the dispute is lost", async () => {
    seat("d1", 8_000).disputed = true;
    await refundWholeEventPayments("webinar", "web1", "cancelled", "u1");
    expect(mockRows.get("d1")!.refundOwedKey).toBe("event-cancel:web1:pay:d1");

    // The bank already returned the money, so the front door has nothing left to refund.
    mockRows.get("d1")!.disputed = false;
    const { RefundValidationError } = jest.requireMock<{
      RefundValidationError: new (message: string, code: string) => Error;
    }>("../../lib/payments/operations/refund");
    mockRefundBookingPayment.mockRejectedValue(
      new RefundValidationError("charged back", "ALREADY_FULLY_REFUNDED"),
    );
    const lost = await retryAutoRefunds();

    expect(lost.owed.settled).toBe(1);
    expect(mockRefunds).toHaveLength(0);
    expect(mockRows.get("d1")!.refundOwedKey).toBeNull();
    expect(mockRows.get("d1")!.refundOwedAttempts).toBe(0);
    // Nothing is left for a later run to drive or to page about.
    expect((await retryAutoRefunds()).owed.scanned).toBe(0);
  });
});

/** One gateway attempt that leaves a refund row of `status` and throws. */
function failsOnce(status: "FAILED" | "PENDING") {
  mockRefundBookingPayment.mockImplementationOnce(
    async (input: { paymentId: string; dedupeKey: string }) => {
      mockRefunds.push({
        id: `rf_${mockRefunds.length + 1}`,
        paymentId: input.paymentId,
        dedupeKey: input.dedupeKey,
        amountPaise: 5_000,
        status,
      });
      throw new Error(status === "FAILED" ? "BAD_REQUEST_ERROR" : "timeout");
    },
  );
}

/** Each drive writes one FAILED refund row, as the front door does on a definitive refusal. */
function gatewayFails(gatewayCode: string | undefined) {
  const { RefundGatewayError } = jest.requireMock<{
    RefundGatewayError: new (message: string, gatewayCode?: string) => Error;
  }>("../../lib/payments/operations/refund");
  mockRefundBookingPayment.mockImplementation(
    async (input: { paymentId: string; dedupeKey: string }) => {
      mockRefunds.push({
        id: `rf_${mockRefunds.length + 1}`,
        paymentId: input.paymentId,
        dedupeKey: input.dedupeKey,
        amountPaise: 5_000,
        status: "FAILED",
      });
      throw new RefundGatewayError("gateway refund failed", gatewayCode);
    },
  );
}

describe("a gateway that does not know the payment", () => {
  it("retires a 404 on its first attempt with one FAILED refund and one page", async () => {
    seat("p1", 10_000);
    marker("p1", 5_000);
    gatewayFails("GATEWAY_NOT_FOUND");

    const first = await retryAutoRefunds();
    expect(first.owed.stuck).toEqual(["p1"]);
    expect((await retryAutoRefunds()).owed.scanned).toBe(0);
    expect(mockRows.get("p1")!.refundOwedAttempts).toBe(3);
    expect(mockRefunds.filter((r) => r.status === "FAILED")).toHaveLength(1);
    expect(mockRecordSystemError).toHaveBeenCalledTimes(1);
  });

  it("keeps retrying a 5xx until the attempt budget is spent", async () => {
    seat("p1", 10_000);
    marker("p1", 5_000);
    gatewayFails("SERVER_ERROR");

    expect((await retryAutoRefunds()).owed.stuck).toEqual([]);
    expect(mockRows.get("p1")!.refundOwedAttempts).toBe(1);
    elapse("p1");
    expect((await retryAutoRefunds()).owed.scanned).toBe(1);
    expect(mockRecordSystemError).not.toHaveBeenCalled();
  });
});

describe("a failed gateway attempt", () => {
  it("re-drives a definitive refusal on the next sweep and clears on success", async () => {
    seat("p1", 10_000);
    marker("p1", 5_000);
    failsOnce("FAILED");

    expect((await retryAutoRefunds()).owed.failed).toBe(1);
    expect(mockRows.get("p1")!.refundOwedKey).toBe("cancel:appt:p1");
    elapse("p1");
    expect((await retryAutoRefunds()).owed.refunded).toBe(1);
    expect(mockRows.get("p1")!.refundOwedKey).toBeNull();
    const moved = mockRefunds.filter((r) => r.status === "SUCCEEDED");
    expect(moved.map((r) => r.amountPaise)).toEqual([5_000]);
  });

  it("leaves an ambiguous attempt to reconcile, never re-driving it", async () => {
    seat("p1", 10_000);
    marker("p1", 5_000);
    failsOnce("PENDING");

    await retryAutoRefunds();
    elapse("p1");
    expect((await retryAutoRefunds()).owed.scanned).toBe(0);
    expect(mockRefundBookingPayment).toHaveBeenCalledTimes(1);
  });

  it("does not tell the payer a refund failed while the payment still owes it", async () => {
    seat("p1", 10_000);
    marker("p1", 5_000);
    mockRefunds.push(
      {
        id: "rf_attempt",
        paymentId: "p1",
        dedupeKey: null,
        amountPaise: 5_000,
        status: "FAILED",
      },
      // A failure from before the door stamped the marker is not its attempt.
      {
        id: "rf_earlier",
        paymentId: "p1",
        dedupeKey: null,
        amountPaise: 1_000,
        status: "FAILED",
        createdAt: new Date(Date.now() - 24 * 60 * 60_000),
      },
    );

    const result = await notifyFailedRefunds();
    expect(result.notified).toBe(1);
    expect(mockSendRefundFailedEmail).toHaveBeenCalledTimes(1);
    expect(mockSendRefundFailedEmail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ amountPaise: 1_000 }),
      null,
    );
    // Claimed silently, so a later success never sends a stale failure email.
    expect(mockRefunds[0].failedNotifiedAt).toBeInstanceOf(Date);
  });
});

describe("owed-refund backoff", () => {
  const HOUR = 60 * 60_000;
  const waitOf = (id: string, from: number) =>
    mockRows.get(id)!.refundOwedNextAt!.getTime() - from;

  it("waits 1 h, then 4 h, between failed drives and pages once at the cap", async () => {
    seat("p1", 10_000);
    marker("p1", 5_000);
    gatewayFails("SERVER_ERROR");

    let at = Date.now();
    await retryAutoRefunds();
    expect(mockRows.get("p1")!.refundOwedAttempts).toBe(1);
    expect(waitOf("p1", at)).toBeGreaterThanOrEqual(HOUR);
    expect(waitOf("p1", at)).toBeLessThan(HOUR + 60_000);
    // Inside the backoff the sweep does not claim the marker.
    expect((await retryAutoRefunds()).owed.scanned).toBe(0);
    expect(mockRefundBookingPayment).toHaveBeenCalledTimes(1);

    elapse("p1");
    at = Date.now();
    await retryAutoRefunds();
    expect(mockRows.get("p1")!.refundOwedAttempts).toBe(2);
    expect(waitOf("p1", at)).toBeGreaterThanOrEqual(4 * HOUR);
    expect(waitOf("p1", at)).toBeLessThan(4 * HOUR + 60_000);
    expect(mockRecordSystemError).not.toHaveBeenCalled();

    elapse("p1");
    expect((await retryAutoRefunds()).owed.stuck).toEqual(["p1"]);
    expect(mockRows.get("p1")).toMatchObject({
      refundOwedKey: "cancel:appt:p1",
      refundOwedAttempts: 3,
      refundOwedNextAt: null,
    });
    expect(mockRecordSystemError).toHaveBeenCalledTimes(1);
    expect((await retryAutoRefunds()).owed.scanned).toBe(0);
  });

  it("writes nothing for a drive that read a stale attempt count", async () => {
    seat("p1", 10_000);
    const owed = marker("p1", 5_000);
    const nextAt = new Date(Date.now() + HOUR);
    Object.assign(mockRows.get("p1")!, {
      refundOwedAttempts: 2,
      refundOwedNextAt: nextAt,
    });
    gatewayFails("SERVER_ERROR");

    const outcome = await driveRefundOwed({ ...owed, attempts: 1 });
    expect(outcome.kind).toBe("failed");
    expect(mockRows.get("p1")).toMatchObject({
      refundOwedAttempts: 2,
      refundOwedNextAt: nextAt,
    });
    expect(mockRecordSystemError).not.toHaveBeenCalled();
  });

  it("clears the next-drive time with the marker", async () => {
    seat("p1", 10_000);
    marker("p1", 5_000);
    mockRows.get("p1")!.refundOwedNextAt = new Date(Date.now() - 1);

    expect((await retryAutoRefunds()).owed.refunded).toBe(1);
    expect(mockRows.get("p1")).toMatchObject({
      refundOwedKey: null,
      refundOwedNextAt: null,
    });
  });
});

describe("a hand refund during the backoff", () => {
  /** The marker side of the operator's refund transaction, as the front door runs it. */
  const handRefund = (id: string, handPaise: number) =>
    settleOwedByHand(mockDb as never, id, {
      kind: "amount",
      handPaise,
      refundableBeforePaise: 10_000,
    });

  /** One failed sweep drive: attempt 1, next drive an hour out. */
  async function failedOnce() {
    seat("p1", 10_000);
    const owed = marker("p1", 5_000);
    mockRefundBookingPayment.mockRejectedValueOnce(new Error("gateway 503"));
    await retryAutoRefunds();
    return owed;
  }

  it("clears a fully covered marker in its own transaction, and the sweep then does nothing", async () => {
    await failedOnce();
    expect((await handRefund("p1", 5_000))?.stillOwedPaise).toBe(0);
    expect(mockRows.get("p1")).toMatchObject({
      refundOwedKey: null,
      refundOwedAttempts: 0,
      refundOwedNextAt: null,
    });
    elapse("p1");
    expect((await retryAutoRefunds()).owed.scanned).toBe(0);
    expect(mockRefunds).toHaveLength(0);
  });

  it("reduces a partly covered marker, and the sweep later pays only the remainder", async () => {
    await failedOnce();
    const backoff = mockRows.get("p1")!.refundOwedNextAt;
    expect((await handRefund("p1", 2_000))?.note).toBe(
      "Settled ₹20.00 of the owed ₹50.00; ₹30.00 still owed and retrying.",
    );
    expect(mockRows.get("p1")).toMatchObject({
      refundOwedKey: "cancel:appt:p1",
      refundOwedPaise: 3_000,
      refundOwedAttempts: 1,
      refundOwedNextAt: backoff,
    });
    expect((await retryAutoRefunds()).owed.scanned).toBe(0);
    elapse("p1");
    expect((await retryAutoRefunds()).owed.refunded).toBe(1);
    expect(mockRefunds.map((r) => r.amountPaise)).toEqual([3_000]);
    expect(mockRows.get("p1")!.refundOwedKey).toBeNull();
  });

  it("stops the door's own drive once a hand refund changed its marker", async () => {
    seat("p1", 10_000);
    // The marker as the cancel door stamped it and is about to drive it.
    const owed = marker("p1", 5_000);
    await handRefund("p1", 2_000);
    expect((await driveRefundOwed(owed)).kind).toBe("blocked");
    await handRefund("p1", 3_000);
    expect((await driveRefundOwed(owed)).kind).toBe("settled");
    expect(mockRefunds).toHaveLength(0);
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
        where: expect.objectContaining({
          paymentId: "t1",
          holdUntil: null,
          consultantProfileId: "cp-1",
        }),
        data: { holdUntil: expect.any(Date) },
      }),
    );
  });

  it("surfaces markers older than six hours once, reading the persisted amount", async () => {
    seat("p1", 10_000);
    marker("p1", 4_000);
    // Three hours old: still inside the backoff, so not yet surfaced.
    seat("p2", 10_000);
    marker("p2", 4_000);
    mockRows.get("p2")!.refundOwedAt = new Date(Date.now() - 3 * 60 * 60_000);
    mockRefundBookingPayment.mockRejectedValue(new Error("gateway 503"));

    const result = await retryAutoRefunds();
    expect(result.owed.failed).toBe(2);
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
