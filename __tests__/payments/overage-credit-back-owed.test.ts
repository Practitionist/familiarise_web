/**
 * @jest-environment node
 */

/**
 * A full refund of a booking with several CHARGE_MEMBER side-payments refunds
 * one of them in the request; the parent's cascade stamped every one
 * refund-owed, so retryRefundsOwed drains the rest and retries a failed attempt.
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

import { refundMemberOverageSidePayment } from "../../lib/payments/operations/refund";
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

const due = { overagePaymentIds: SIDES };

describe("member overage credit-back on a full parent refund", () => {
  it("refunds one side-payment inline and leaves the rest to the sweep, each under its key", async () => {
    await refundMemberOverageSidePayment({
      parentPaymentId: PARENT,
      due,
      initiatedByUserId: null,
    });
    expect(mockRefunds.map((r) => r.paymentId)).toEqual(["side-1"]);
    expect(mockRows.get("side-1")!.refundOwedKey).toBeNull();
    expect(mockRows.get("side-3")!.refundOwedKey).toBe(keyOf("side-3"));

    const swept = await retryAutoRefunds({ limit: 10 });
    expect(swept.owed.refunded).toBe(2);
    expect(mockRefunds.map((r) => r.dedupeKey)).toEqual(SIDES.map(keyOf));
    expect([...mockRows.values()].every((r) => !r.refundOwedKey)).toBe(true);

    // Replaying the inline drive and the sweep moves no money twice.
    await refundMemberOverageSidePayment({
      parentPaymentId: PARENT,
      due,
      initiatedByUserId: null,
    });
    await retryAutoRefunds({ limit: 10 });
    expect(mockRefunds).toHaveLength(3);
  });

  it("keeps a failed inline attempt as a counted debt the sweep retries, reported once", async () => {
    mockRefundBookingPayment.mockRejectedValueOnce(new Error("gateway 503"));
    await refundMemberOverageSidePayment({
      parentPaymentId: PARENT,
      due,
      initiatedByUserId: null,
    });
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
