/**
 * @jest-environment node
 */

/**
 * The daily settlement recon: a payment line with no booked fee gets one from
 * the line, a mismatched refund is reported once, and a fully read day posts one
 * `settlement:` journal moving Σ(credit − debit) from GATEWAY_CLEARING to CASH.
 */

type Line = {
  entityId: string;
  type: string;
  settlementId: string | null;
  settledAt: Date | null;
  creditPaise: bigint;
  debitPaise: bigint;
  status: string;
};

const mockLines: Line[] = [];
const mockPages: unknown[][] = [];
const mockPost = jest.fn().mockResolvedValue({ created: true });
const mockReport = jest.fn();

const mockInRange = (l: Line, where: { settledAt?: { gte: Date; lt: Date } }) =>
  !where.settledAt ||
  (l.settledAt !== null &&
    l.settledAt >= where.settledAt.gte &&
    l.settledAt < where.settledAt.lt);

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    gatewaySettlementLine: {
      count: jest.fn(
        async ({ where }) =>
          mockLines.filter((l) => mockInRange(l, where)).length,
      ),
      findMany: jest.fn(async () => []),
      createMany: jest.fn(async ({ data }: { data: Line[] }) => {
        mockLines.push(...data);
        return { count: data.length };
      }),
      groupBy: jest.fn(async ({ where }) => {
        const sums = new Map<string, { c: bigint; d: bigint }>();
        for (const l of mockLines.filter(
          (x) => mockInRange(x, where) && x.settlementId,
        )) {
          const s = sums.get(l.settlementId as string) ?? {
            c: BigInt(0),
            d: BigInt(0),
          };
          sums.set(l.settlementId as string, {
            c: s.c + l.creditPaise,
            d: s.d + l.debitPaise,
          });
        }
        return [...sums].map(([settlementId, s]) => ({
          settlementId,
          _sum: { creditPaise: s.c, debitPaise: s.d },
        }));
      }),
    },
    payment: {
      findMany: jest.fn(async () => [
        { id: "p1", gatewayPaymentId: "pay_1", amount: 100_000 },
      ]),
    },
    walletTopUp: { findMany: jest.fn(async () => []) },
    organizationInvoice: { findMany: jest.fn(async () => []) },
    refund: {
      findMany: jest.fn(async () => [
        { id: "r1", refundId: "rfnd_1", amountPaise: 9_000 },
      ]),
    },
    dispute: { findMany: jest.fn(async () => []) },
    ledgerTransaction: { findMany: jest.fn(async () => []) },
  },
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: (_n: string, _o: unknown, fn: () => Promise<unknown>) => fn(),
}));
jest.mock("../../lib/payments/core/razorpay", () => ({
  getRazorpayClient: () => ({
    settlements: {
      reports: jest.fn(async () => ({ items: mockPages.shift() ?? [] })),
    },
  }),
  withRazorpaySdkTimeout: (_op: string, fn: () => Promise<unknown>) => fn(),
}));
jest.mock("../../lib/payments/ledger/post", () => ({
  postLedgerTxn: (...a: unknown[]) => mockPost(...a),
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryMessage: (...a: unknown[]) => mockReport(...a),
}));

import { runReconcileGatewaySettlements } from "../../jobs/reconcile/reconcile-gateway-settlements";

it("books the missing fee, flags the mismatch once, and settles the net to CASH", async () => {
  // 2026-10-20 08:00 IST; "yesterday" is 2026-10-19 IST.
  const now = new Date("2026-10-20T02:30:00Z");
  const settledAt = Math.floor(Date.parse("2026-10-19T10:00:00+05:30") / 1000);
  const base = { settlement_id: "setl_1", settled_at: settledAt };
  mockPages.push([
    {
      ...base,
      entity_id: "pay_1",
      type: "payment",
      amount: 100_000,
      fee: 2_360,
      tax: 360,
      credit: 97_640,
      debit: 0,
    },
    {
      ...base,
      entity_id: "rfnd_1",
      type: "refund",
      amount: 10_000,
      fee: 0,
      tax: 0,
      credit: 0,
      debit: 10_000,
    },
  ]);

  const first = await runReconcileGatewaySettlements(now);
  expect(first).toMatchObject({ inserted: 2, feesPosted: 1, done: false });
  expect(first.byStatus).toMatchObject({ MATCHED: 1, AMOUNT_MISMATCH: 1 });
  expect(mockPost).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      idempotencyKey: "gatewayfee:pay_1",
      postings: [
        {
          account: { kind: "GATEWAY_FEE" },
          direction: "DEBIT",
          amountPaise: 2_000,
        },
        {
          account: { kind: "GST_INPUT_CREDIT" },
          direction: "DEBIT",
          amountPaise: 360,
        },
        {
          account: { kind: "GATEWAY_CLEARING" },
          direction: "CREDIT",
          amountPaise: 2_360,
        },
      ],
    }),
  );
  expect(mockReport).toHaveBeenCalledTimes(1);

  // Both days now read empty: the day is complete and its settlement posts once.
  mockPost.mockClear();
  const second = await runReconcileGatewaySettlements(now);
  expect(second).toMatchObject({ settlementsPosted: 1, done: true });
  expect(mockPost).toHaveBeenCalledTimes(1);
  expect(mockPost).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      idempotencyKey: "settlement:setl_1",
      postings: [
        { account: { kind: "CASH" }, direction: "DEBIT", amountPaise: 87_640 },
        {
          account: { kind: "GATEWAY_CLEARING" },
          direction: "CREDIT",
          amountPaise: 87_640,
        },
      ],
    }),
  );
});
