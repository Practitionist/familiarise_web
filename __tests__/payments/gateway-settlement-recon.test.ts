/**
 * @jest-environment node
 */

/**
 * The daily settlement recon: a payment line with no booked fee gets one from
 * the line, a mismatched refund is reported once, a top-up or org-invoice refund
 * matches its journal, the walk catches up day by day from its checkpoint, and a
 * settlement is booked only when its stored lines add up to the settlement
 * entity's amount.
 */

type Line = {
  id: string;
  entityId: string;
  type: string;
  settlementId: string | null;
  settledAt: Date | null;
  amountPaise: bigint;
  feePaise: bigint;
  creditPaise: bigint;
  debitPaise: bigint;
  paymentId: string | null;
  disputeId: string | null;
  status: string;
  matchedKind?: string;
  matchedId?: string | null;
  note?: string | null;
};

const mockLines: Line[] = [];
/** Report pages by IST day (`YYYY-M-D`), in page order. */
const mockPagesByDay = new Map<string, unknown[][]>();
const mockReportCalls: Array<{ day: string; skip: number }> = [];
/** Settlement entity amounts by id; an id that is absent cannot be read. */
const mockSettlements = new Map<string, number>();
const mockCheckpoint: { value: string | null } = { value: null };
const mockReport = jest.fn();
const mockStanding = jest.fn();
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
type PostInput = {
  idempotencyKey: string;
  postings: Array<{ direction: string; amountPaise: number }>;
};
/** A posted settlement journal is on the books for every later run. */
const mockPost = jest.fn(async (_db: unknown, input: PostInput) => {
  if (input.idempotencyKey.startsWith("settlement:")) {
    mockJournals.set(
      input.idempotencyKey,
      input.postings
        .filter((p) => p.direction === "DEBIT")
        .reduce((sum, p) => sum + p.amountPaise, 0),
    );
  }
  return { created: true };
});
const mockRefunds = [{ id: "r1", refundId: "rfnd_1", amountPaise: 9_000 }];
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

type LineWhere = {
  settledAt?: { gte: Date; lt: Date } | { not: null };
  entityId?: { in: string[] };
  status?: string | { in: string[] };
  id?: string;
};
const mockMatches = (l: Line, where: LineWhere): boolean => {
  if (where.id !== undefined && l.id !== where.id) return false;
  if (where.entityId && !where.entityId.in.includes(l.entityId)) return false;
  if (typeof where.status === "string" && l.status !== where.status)
    return false;
  if (typeof where.status === "object" && !where.status.in.includes(l.status)) {
    return false;
  }
  if (where.settledAt) {
    if (l.settledAt === null) return false;
    if ("gte" in where.settledAt) {
      return (
        l.settledAt >= where.settledAt.gte && l.settledAt < where.settledAt.lt
      );
    }
  }
  return true;
};

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    gatewaySettlementLine: {
      count: jest.fn(
        async ({ where }: { where: LineWhere }) =>
          mockLines.filter((l) => mockMatches(l, where)).length,
      ),
      findFirst: jest.fn(async ({ where }: { where: LineWhere }) => {
        const dated = mockLines
          .filter((l) => mockMatches(l, where))
          .sort((x, y) => y.settledAt!.getTime() - x.settledAt!.getTime());
        return dated[0] ?? null;
      }),
      findMany: jest.fn(
        async ({
          where,
          skip = 0,
          take,
        }: {
          where: LineWhere;
          skip?: number;
          take?: number;
        }) => {
          const hits = mockLines.filter((l) => mockMatches(l, where));
          return take === undefined ? hits : hits.slice(skip, skip + take);
        },
      ),
      createMany: jest.fn(async ({ data }: { data: Omit<Line, "id">[] }) => {
        for (const row of data) {
          mockLines.push({ ...row, id: `line_${mockLines.length + 1}` });
        }
        return { count: data.length };
      }),
      updateMany: jest.fn(
        async ({ where, data }: { where: LineWhere; data: Partial<Line> }) => {
          const hits = mockLines.filter((l) => mockMatches(l, where));
          hits.forEach((l) => Object.assign(l, data));
          return { count: hits.length };
        },
      ),
      groupBy: jest.fn(async ({ where }: { where: LineWhere }) => {
        const sums = new Map<string, { c: bigint; d: bigint }>();
        for (const l of mockLines.filter(
          (x) => mockMatches(x, where) && x.settlementId,
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
      findMany: jest.fn(
        async ({ where }: { where: { refundId: { in: string[] } } }) =>
          mockRefunds.filter((r) => where.refundId.in.includes(r.refundId)),
      ),
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
  readJobCheckpoint: async () => mockCheckpoint.value,
}));
jest.mock("../../lib/payments/core/razorpay", () => ({
  getRazorpayClient: () => ({
    settlements: {
      reports: jest.fn(
        async (q: {
          year: number;
          month: number;
          day: number;
          skip: number;
        }) => {
          const day = `${q.year}-${q.month}-${q.day}`;
          mockReportCalls.push({ day, skip: q.skip });
          return { items: mockPagesByDay.get(day)?.[q.skip / 1000] ?? [] };
        },
      ),
      fetch: jest.fn(async (id: string) => {
        const amount = mockSettlements.get(id);
        if (amount === undefined)
          throw new Error("The id provided does not exist");
        return { id, entity: "settlement", amount };
      }),
    },
  }),
  withRazorpaySdkTimeout: (_op: string, fn: () => Promise<unknown>) => fn(),
}));
jest.mock("../../lib/payments/ledger/post", () => ({
  postLedgerTxn: (db: unknown, input: PostInput) => mockPost(db, input),
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryMessage: (...a: unknown[]) => mockReport(...a),
}));
jest.mock("../../lib/observability/standing-finding", () => ({
  reportStandingFinding: async (args: unknown) => {
    mockStanding(args);
    return true;
  },
}));

import { InvalidDateParamError } from "../../lib/cron/date-param";
import { runReconcileGatewaySettlements } from "../../jobs/reconcile/reconcile-gateway-settlements";

/** Epoch seconds of 10:00 IST on an IST date. */
const settledOn = (date: string) =>
  Math.floor(Date.parse(`${date}T10:00:00+05:30`) / 1000);

beforeEach(() => {
  mockLines.length = 0;
  mockPagesByDay.clear();
  mockReportCalls.length = 0;
  mockSettlements.clear();
  mockCheckpoint.value = null;
  for (const key of [...mockJournals.keys()]) {
    if (key.startsWith("settlement:")) mockJournals.delete(key);
  }
  mockRefunds.length = 1;
  jest.clearAllMocks();
});

it("books the missing fee, flags the mismatch once, and settles the net to CASH when the lines add up", async () => {
  // 2026-10-20 08:00 IST; "yesterday" is 2026-10-19 IST.
  const now = new Date("2026-10-20T02:30:00Z");
  const base = { settlement_id: "setl_1", settled_at: settledOn("2026-10-19") };
  mockPagesByDay.set("2026-10-19", [
    [
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
    ],
  ]);
  mockSettlements.set("setl_1", 87_640);

  const first = await runReconcileGatewaySettlements(Date.now(), now);

  expect(first).toMatchObject({
    inserted: 2,
    feesPosted: 1,
    settlementsPosted: 1,
    settlementsHeld: 0,
    checkpoint: "2026-10-19",
    daysBehind: 0,
    done: true,
  });
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
  expect(mockReport).toHaveBeenCalledTimes(1);

  // A second run reads the same days again and neither stores nor posts anything.
  mockPost.mockClear();
  mockCheckpoint.value = "2026-10-19";
  const second = await runReconcileGatewaySettlements(Date.now(), now);
  expect(second).toMatchObject({
    inserted: 0,
    settlementsPosted: 0,
    done: true,
  });
  expect(mockPost).not.toHaveBeenCalled();
});

it("matches top-up and org-invoice refunds by their journal, keeping a missed one visible", async () => {
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
  mockPagesByDay.set("2026-11-19", [
    [
      refund("rfnd_t", "pay_t", 5_000),
      refund("rfnd_i", "pay_i", 7_000),
      refund("rfnd_tx", "pay_tx", 4_000),
      refund("rfnd_iw", "pay_i", 6_500),
      refund("rfnd_tf", "pay_tf", 1_000),
      refund("rfnd_u", "pay_unknown", 1_000),
    ],
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
  mockCheckpoint.value = "2026-12-18";
  mockPagesByDay.set("2026-12-19", [partialPage()]);
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
  mockPagesByDay.set("2027-1-19", [
    [line("rfnd_zero", 0), line("rfnd_neg", -2_000)],
  ]);

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

describe("the walk, the completeness check and the later passes", () => {
  // 2026-10-20 08:00 IST; "yesterday" is 2026-10-19 IST.
  const now = new Date("2026-10-20T02:30:00Z");
  const payment = (entity_id: string, date: string, credit: number) => ({
    entity_id,
    type: "payment",
    amount: credit,
    fee: 0,
    credit,
    debit: 0,
    settlement_id: `setl_${date}`,
    settled_at: settledOn(date),
  });
  const daysRead = () => [...new Set(mockReportCalls.map((c) => c.day))];

  it("catches up from its checkpoint day by day to yesterday, capped at ten days a run", async () => {
    mockCheckpoint.value = "2026-10-10";
    mockPagesByDay.set("2026-10-12", [
      [payment("pay_missed", "2026-10-12", 40_000)],
    ]);
    mockSettlements.set("setl_2026-10-12", 40_000);

    const caughtUp = await runReconcileGatewaySettlements(Date.now(), now);

    expect(daysRead()).toEqual(
      [11, 12, 13, 14, 15, 16, 17, 18, 19].map((d) => `2026-10-${d}`),
    );
    expect(caughtUp).toMatchObject({
      inserted: 1,
      settlementsPosted: 1,
      checkpoint: "2026-10-19",
      daysBehind: 0,
      done: true,
    });

    mockReportCalls.length = 0;
    mockCheckpoint.value = "2026-09-01";
    const capped = await runReconcileGatewaySettlements(Date.now(), now);

    expect(daysRead()).toHaveLength(10);
    expect(capped).toMatchObject({
      checkpoint: "2026-09-11",
      daysBehind: 38,
      done: false,
    });
  });

  it("with no checkpoint, starts on the day of the last stored line", async () => {
    mockPagesByDay.set("2026-10-15", [
      [payment("pay_old", "2026-10-15", 1_000)],
    ]);
    await runReconcileGatewaySettlements(Date.now(), now, {
      date: "2026-10-15",
    });
    mockReportCalls.length = 0;

    await runReconcileGatewaySettlements(Date.now(), now);

    expect(daysRead()).toEqual([15, 16, 17, 18, 19].map((d) => `2026-10-${d}`));
  });

  it("reads a day from its first page until a short page", async () => {
    mockCheckpoint.value = "2026-10-18";
    mockPagesByDay.set("2026-10-19", [
      Array.from({ length: 1000 }, (_, i) => ({
        entity_id: `trf_${i}`,
        type: "transfer",
        amount: 1,
      })),
      [{ entity_id: "trf_last", type: "transfer", amount: 1 }],
    ]);

    const result = await runReconcileGatewaySettlements(Date.now(), now);

    expect(mockReportCalls.filter((c) => c.day === "2026-10-19")).toEqual([
      { day: "2026-10-19", skip: 0 },
      { day: "2026-10-19", skip: 1000 },
    ]);
    expect(result).toMatchObject({ fetched: 1001, inserted: 1001 });
  });

  it("holds a settlement whose stored lines do not add up to its amount, and books it once they do", async () => {
    mockCheckpoint.value = "2026-10-18";
    mockPagesByDay.set("2026-10-19", [
      [payment("pay_a", "2026-10-19", 60_000)],
    ]);
    mockSettlements.set("setl_2026-10-19", 100_000);

    const held = await runReconcileGatewaySettlements(Date.now(), now);

    expect(held).toMatchObject({ settlementsPosted: 0, settlementsHeld: 1 });
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockStanding).toHaveBeenCalledTimes(1);
    expect(mockStanding).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "reconcile-gateway-settlements:held",
        ids: ["setl_2026-10-19"],
      }),
    );

    // The rest of the settlement arrives in a later read of the same day.
    mockPagesByDay.set("2026-10-19", [
      [
        payment("pay_a", "2026-10-19", 60_000),
        payment("pay_b", "2026-10-19", 40_000),
      ],
    ]);
    const booked = await runReconcileGatewaySettlements(Date.now(), now);

    expect(booked).toMatchObject({ settlementsPosted: 1, settlementsHeld: 0 });
    expect(mockPost).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        idempotencyKey: "settlement:setl_2026-10-19",
        postings: [
          expect.objectContaining({ direction: "DEBIT", amountPaise: 100_000 }),
          expect.objectContaining({
            direction: "CREDIT",
            amountPaise: 100_000,
          }),
        ],
      }),
    );
  });

  it("holds a settlement whose entity cannot be read", async () => {
    mockCheckpoint.value = "2026-10-18";
    mockPagesByDay.set("2026-10-19", [
      [payment("pay_a", "2026-10-19", 60_000)],
    ]);

    const result = await runReconcileGatewaySettlements(Date.now(), now);

    expect(result).toMatchObject({ settlementsPosted: 0, settlementsHeld: 1 });
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("reports a posted journal that differs from its lines and posts nothing over it", async () => {
    mockCheckpoint.value = "2026-10-18";
    mockPagesByDay.set("2026-10-19", [
      [payment("pay_a", "2026-10-19", 60_000)],
    ]);
    mockJournals.set("settlement:setl_2026-10-19", 45_000);

    const result = await runReconcileGatewaySettlements(Date.now(), now);

    expect(result).toMatchObject({ settlementsPosted: 0, postedMismatches: 1 });
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockStanding).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "reconcile-gateway-settlements:posted-differs",
        ids: ["setl_2026-10-19"],
      }),
    );
  });

  it("stores the valid rows of a page, and counts and reports the rejected ones once", async () => {
    mockCheckpoint.value = "2026-10-18";
    mockPagesByDay.set("2026-10-19", [
      [
        { entity_id: "trf_ok", type: "transfer", amount: 100 },
        { entity_id: "trf_bad", type: "transfer", amount: 10.5 },
        { entity_id: "", type: "transfer", amount: 100 },
      ],
    ]);

    const result = await runReconcileGatewaySettlements(Date.now(), now);

    expect(result).toMatchObject({
      fetched: 3,
      inserted: 1,
      rejectedRows: 2,
      checkpoint: "2026-10-19",
    });
    expect(mockLines.map((l) => l.entityId)).toEqual(["trf_ok"]);
    const rejects = mockReport.mock.calls.filter(([message]) =>
      String(message).includes("failed validation"),
    );
    expect(rejects).toHaveLength(1);
    expect(rejects[0][0]).toContain("2 row(s)");
  });

  it("matches again a line that was unresolved when the missing row arrives later", async () => {
    mockCheckpoint.value = "2026-10-18";
    mockPagesByDay.set("2026-10-19", [
      [
        {
          entity_id: "rfnd_late",
          type: "refund",
          amount: 3_000,
          debit: 3_000,
          settlement_id: "setl_r",
          settled_at: settledOn("2026-10-19"),
        },
      ],
    ]);
    await runReconcileGatewaySettlements(Date.now(), now);
    expect(mockLines[0]).toMatchObject({
      status: "UNMATCHED",
      matchedId: null,
    });

    mockRefunds.push({
      id: "r_late",
      refundId: "rfnd_late",
      amountPaise: 3_000,
    });
    const result = await runReconcileGatewaySettlements(Date.now(), now);

    expect(result.rematched).toBe(1);
    expect(mockLines[0]).toMatchObject({
      status: "MATCHED",
      matchedKind: "REFUND",
      matchedId: "r_late",
    });
  });

  it("a manual run reads the one date it is given and leaves the checkpoint alone", async () => {
    mockCheckpoint.value = "2026-10-18";
    mockPagesByDay.set("2026-10-5", [[payment("pay_m", "2026-10-05", 5_000)]]);
    mockSettlements.set("setl_2026-10-05", 5_000);

    const result = await runReconcileGatewaySettlements(Date.now(), now, {
      date: "2026-10-05",
    });

    expect(daysRead()).toEqual(["2026-10-5"]);
    expect(result).toMatchObject({
      inserted: 1,
      settlementsPosted: 1,
      done: true,
    });
    expect(result.checkpoint).toBeUndefined();
    for (const date of ["2026-10-20", "2026-02-30", "yesterday"]) {
      await expect(
        runReconcileGatewaySettlements(Date.now(), now, { date }),
      ).rejects.toBeInstanceOf(InvalidDateParamError);
    }
  });
});
