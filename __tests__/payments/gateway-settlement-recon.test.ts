/**
 * @jest-environment node
 */

/**
 * The daily settlement recon: a payment line with no booked fee gets one from
 * the line, a mismatched refund is reported once, a top-up or org-invoice refund
 * matches its journal, and a fully read day posts one `settlement:` journal.
 */

type Line = {
  entityId: string;
  type: string;
  settlementId: string | null;
  settledAt: Date | null;
  creditPaise: bigint;
  debitPaise: bigint;
  status: string;
  matchedKind?: string;
  matchedId?: string | null;
  note?: string | null;
};

const mockLines: Line[] = [];
const mockPages: unknown[][] = [];
const mockPost = jest.fn().mockResolvedValue({ created: true });
const mockReport = jest.fn();
/** Σ DEBIT per journal idempotency key. */
const mockJournals = new Map<string, number>([
  ["topup-refund:rfnd_t", 5_000],
  ["topup-refund-shortfall:rfnd_t", 3_000],
  ["invoice-refund:rfnd_i", 7_000],
  ["invoice-refund:rfnd_iw", 6_000],
  ["topup-refund:rfnd_t2", 2_000],
  ["invoice-refund:rfnd_i2", 1_500],
  ["topup-refund:rfnd_neg", 2_000],
]);
const mockTopUps = [
  {
    id: "tu1",
    providerPaymentId: "pay_t",
    amountPaise: 9_000,
    status: "CONFIRMED",
  },
  {
    id: "tu2",
    providerPaymentId: "pay_tx",
    amountPaise: 9_000,
    status: "CONFIRMED",
  },
  {
    id: "tu3",
    providerPaymentId: "pay_tf",
    amountPaise: 9_000,
    status: "FAILED",
  },
];
const mockInvoices = [{ id: "inv1", providerPaymentId: "pay_i" }];
type PayIdWhere = { where: { providerPaymentId: { in: string[] } } };
function mockByPayId<T extends { providerPaymentId: string }>(
  rows: T[],
  { where }: PayIdWhere,
): T[] {
  return rows.filter((r) =>
    where.providerPaymentId.in.includes(r.providerPaymentId),
  );
}

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
      findMany: jest.fn(
        async ({ where }: { where: { entityId: { in: string[] } } }) =>
          mockLines.filter((l) => where.entityId.in.includes(l.entityId)),
      ),
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
    walletTopUp: {
      findMany: jest.fn(async (a: PayIdWhere) => mockByPayId(mockTopUps, a)),
    },
    organizationInvoice: {
      findMany: jest.fn(async (a: PayIdWhere) => mockByPayId(mockInvoices, a)),
    },
    refund: {
      findMany: jest.fn(async () => [
        { id: "r1", refundId: "rfnd_1", amountPaise: 9_000 },
      ]),
    },
    dispute: { findMany: jest.fn(async () => []) },
    ledgerTransaction: {
      findMany: jest.fn(
        async ({ where }: { where: { idempotencyKey: { in: string[] } } }) =>
          where.idempotencyKey.in.flatMap((k) => {
            const debit = mockJournals.get(k);
            return debit === undefined
              ? []
              : [{ idempotencyKey: k, entries: [{ amountPaise: debit }] }];
          }),
      ),
    },
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

  const first = await runReconcileGatewaySettlements(Date.now(), now);
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
  const second = await runReconcileGatewaySettlements(Date.now(), now);
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

it("matches top-up and org-invoice refunds by their journal, keeping a missed one visible", async () => {
  mockReport.mockClear();
  const now = new Date("2026-11-20T02:30:00Z");
  const settledAt = Math.floor(Date.parse("2026-11-19T10:00:00+05:30") / 1000);
  const refund = (entity_id: string, payment_id: string, amount: number) => ({
    entity_id,
    payment_id,
    amount,
    type: "refund",
    settlement_id: "setl_2",
    settled_at: settledAt,
    debit: amount,
  });
  mockPages.push([
    refund("rfnd_t", "pay_t", 5_000),
    refund("rfnd_i", "pay_i", 7_000),
    refund("rfnd_tx", "pay_tx", 4_000),
    refund("rfnd_iw", "pay_i", 6_500),
    refund("rfnd_tf", "pay_tf", 1_000),
    refund("rfnd_u", "pay_unknown", 1_000),
  ]);

  const result = await runReconcileGatewaySettlements(Date.now(), now);
  const stored = (id: string) => {
    const l = mockLines.find((x) => x.entityId === id);
    return l && [l.matchedKind, l.matchedId, l.status, l.note];
  };
  expect(stored("rfnd_t")).toEqual(["TOPUP", "tu1", "MATCHED", null]);
  expect(stored("rfnd_i")).toEqual(["INVOICE", "inv1", "MATCHED", null]);
  expect(stored("rfnd_tx")).toEqual([
    "TOPUP",
    "tu2",
    "AMOUNT_MISMATCH",
    "gateway 4000 vs ours unbooked",
  ]);
  expect(stored("rfnd_iw")).toEqual([
    "INVOICE",
    "inv1",
    "AMOUNT_MISMATCH",
    "gateway 6500 vs ours 6000",
  ]);
  expect(stored("rfnd_tf")).toEqual(["NONE", null, "UNMATCHED", null]);
  expect(stored("rfnd_u")).toEqual(["NONE", null, "UNMATCHED", null]);
  expect(result.byStatus).toEqual({
    MATCHED: 2,
    AMOUNT_MISMATCH: 2,
    FEE_MISMATCH: 0,
    UNMATCHED: 2,
  });
  expect(mockReport).toHaveBeenCalledTimes(1);

  // Partial refunds: each further refund on the same payment matches its own journal only.
  mockReport.mockClear();
  const later = new Date("2026-12-20T02:30:00Z");
  const laterAt = Math.floor(Date.parse("2026-12-19T10:00:00+05:30") / 1000);
  const partialPage = () => [
    { ...refund("rfnd_t2", "pay_t", 2_000), settled_at: laterAt },
    { ...refund("rfnd_i2", "pay_i", 1_500), settled_at: laterAt },
  ];
  mockPages.push(partialPage());
  const partialRun = await runReconcileGatewaySettlements(Date.now(), later);
  expect(stored("rfnd_t2")).toEqual(["TOPUP", "tu1", "MATCHED", null]);
  expect(stored("rfnd_i2")).toEqual(["INVOICE", "inv1", "MATCHED", null]);
  expect(partialRun.byStatus).toEqual({
    MATCHED: 2,
    AMOUNT_MISMATCH: 0,
    FEE_MISMATCH: 0,
    UNMATCHED: 0,
  });
  expect(mockReport).not.toHaveBeenCalled();

  // Replaying the same page stores nothing and counts nothing.
  const before = mockLines.length;
  mockPages.push(partialPage());
  const replay = await runReconcileGatewaySettlements(Date.now(), later);
  expect(replay.inserted).toBe(0);
  expect(mockLines).toHaveLength(before);
  expect(replay.byStatus).toEqual({
    MATCHED: 0,
    AMOUNT_MISMATCH: 0,
    FEE_MISMATCH: 0,
    UNMATCHED: 0,
  });
  expect(mockReport).not.toHaveBeenCalled();
});

it("never matches a zero or negative refund line, even against a booked journal", async () => {
  mockReport.mockClear();
  const now = new Date("2027-01-20T02:30:00Z");
  const settledAt = Math.floor(Date.parse("2027-01-19T10:00:00+05:30") / 1000);
  const line = (entity_id: string, amount: number) => ({
    entity_id,
    payment_id: "pay_t",
    amount,
    type: "refund",
    settlement_id: "setl_3",
    settled_at: settledAt,
    debit: amount,
  });
  mockPages.push([line("rfnd_zero", 0), line("rfnd_neg", -2_000)]);

  const result = await runReconcileGatewaySettlements(Date.now(), now);

  const stored = (id: string) => mockLines.find((x) => x.entityId === id);
  expect(stored("rfnd_zero")).toMatchObject({
    status: "AMOUNT_MISMATCH",
    note: "gateway 0 vs ours unbooked",
  });
  expect(stored("rfnd_neg")).toMatchObject({
    status: "AMOUNT_MISMATCH",
    note: "gateway -2000 vs ours 2000",
  });
  expect(result.byStatus).toMatchObject({ MATCHED: 0, AMOUNT_MISMATCH: 2 });
  expect(mockReport).toHaveBeenCalledTimes(1);
});
