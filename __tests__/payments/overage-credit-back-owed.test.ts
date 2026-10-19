/**
 * @jest-environment node
 */

/**
 * A full refund of a booking with CHARGE_MEMBER side-payments refunds none of
 * them in the request: the parent's cascade stamps each refund-owed, and
 * retryRefundsOwed refunds every one and retries a failed attempt.
 */

type Row = {
  id: string;
  refundOwedKey: string | null;
  refundOwedPaise: number | null;
  refundOwedReason: string | null;
  refundOwedAt: Date | null;
  refundOwedAttempts: number;
};

const mockRows = new Map<string, Row>();
const mockRefunds: { paymentId: string; dedupeKey: string }[] = [];
const mockRefundBookingPayment = jest.fn();
const mockReportSentryError = jest.fn();

type Where = {
  id?: string;
  refundOwedKey?: string | { not: null };
  refundOwedAttempts?: number;
  description?: unknown;
};
const matches = (r: Row, w: Where) =>
  !w.description &&
  (w.id === undefined || r.id === w.id) &&
  (w.refundOwedKey === undefined ||
    (typeof w.refundOwedKey === "string"
      ? r.refundOwedKey === w.refundOwedKey
      : r.refundOwedKey !== null)) &&
  (typeof w.refundOwedAttempts !== "number" ||
    r.refundOwedAttempts === w.refundOwedAttempts);

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: {
      findMany: async ({ where }: { where: Where }) =>
        [...mockRows.values()].filter((r) => matches(r, where)),
      updateMany: async ({
        where,
        data,
      }: {
        where: Where;
        data: Partial<Row>;
      }) => {
        const hit = [...mockRows.values()].filter((r) => matches(r, where));
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      },
    },
    refund: {
      findUnique: async ({ where }: { where: { dedupeKey: string } }) => {
        const r = mockRefunds.find((x) => x.dedupeKey === where.dedupeKey);
        return r
          ? {
              id: `rf-${r.paymentId}`,
              amountPaise: 100_000,
              status: "SUCCEEDED",
            }
          : null;
      },
    },
    systemEvent: { findFirst: async () => null },
  },
}));
jest.mock("../../lib/payments/operations/booking-refund", () => ({
  refundBookingPayment: (input: unknown) => mockRefundBookingPayment(input),
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: (...a: unknown[]) => mockReportSentryError(...a),
  reportSentryMessage: jest.fn(),
}));
jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemError: jest.fn(),
  recordSystemErrorSafe: jest.fn(),
  recordSystemEvent: jest.fn(),
  recordSystemEventSafe: jest.fn(),
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: (_k: string, _o: unknown, fn: () => unknown) => fn(),
}));
jest.mock("../../lib/payments/webhooks/handlers", () => ({}));

import { retryAutoRefunds } from "../../scripts/payments/retry-auto-refunds";

const PARENT = "pay-parent";
const SIDES = ["side-1", "side-2", "side-3"];
const keyOf = (id: string) => `overage-credit-back:${PARENT}:${id}`;

/** Each side-payment as the parent's cascade stamped it, past the sweep's grace. */
function stampedSides() {
  for (const id of SIDES) {
    mockRows.set(id, {
      id,
      refundOwedKey: keyOf(id),
      refundOwedPaise: null,
      refundOwedReason: "overage credit-back",
      refundOwedAt: new Date(Date.now() - 60 * 60_000),
      refundOwedAttempts: 0,
    });
  }
}

beforeEach(() => {
  mockRows.clear();
  mockRefunds.length = 0;
  mockReportSentryError.mockClear();
  mockRefundBookingPayment.mockReset();
  mockRefundBookingPayment.mockImplementation(
    async (input: { paymentId: string; dedupeKey: string }) => {
      mockRefunds.push(input);
      return {
        refundId: `rf-${input.paymentId}`,
        amountRefundedPaise: 100_000,
        status: "SUCCEEDED",
      };
    },
  );
  stampedSides();
});

describe("member overage credit-back on a full parent refund", () => {
  it("leaves every side-payment owed, and the sweep refunds each once under its key", async () => {
    expect(mockRefunds).toHaveLength(0);

    const swept = await retryAutoRefunds({ limit: 10 });
    expect(swept.owed.refunded).toBe(3);
    expect(mockRefunds.map((r) => r.dedupeKey)).toEqual(SIDES.map(keyOf));
    expect([...mockRows.values()].every((r) => !r.refundOwedKey)).toBe(true);

    // A replayed sweep finds nothing owed and moves no money.
    expect((await retryAutoRefunds({ limit: 10 })).owed.scanned).toBe(0);
    expect(mockRefunds).toHaveLength(3);
  });

  it("keeps a failed attempt as a counted debt the next sweep retries, reported once per run", async () => {
    mockRefundBookingPayment.mockRejectedValueOnce(new Error("gateway 503"));
    const first = await retryAutoRefunds({ limit: 10 });
    expect(first.owed.failed).toBe(1);
    expect(mockReportSentryError).toHaveBeenCalledTimes(1);
    expect(mockRows.get("side-1")).toMatchObject({
      refundOwedKey: keyOf("side-1"),
      refundOwedAttempts: 1,
    });

    await retryAutoRefunds({ limit: 10 });
    expect(mockRefunds.map((r) => r.paymentId).sort()).toEqual(SIDES);
    expect(mockReportSentryError).toHaveBeenCalledTimes(1);
  });
});
