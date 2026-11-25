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
/** Line ids sort in insertion order. */
const lineId = (n: number) => `line_${String(n).padStart(6, "0")}`;
/** Report pages by IST day (`YYYY-M-D`), in page order. */
const mockPagesByDay = new Map<string, unknown[][]>();
const mockReportCalls: Array<{ day: string; skip: number }> = [];
/** IST days (`YYYY-M-D`) whose report throws. */
const mockFailingDays = new Set<string>();
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
  postings: Array<{
    account: { kind: string };
    direction: string;
    amountPaise: number;
  }>;
};
/**
 * A posted settlement journal is on the books for every later run, stored as
 * its cash movement: positive into CASH, negative out of it.
 */
const mockPost = jest.fn(async (_db: unknown, input: PostInput) => {
  if (input.idempotencyKey.startsWith("settlement:")) {
    mockJournals.set(
      input.idempotencyKey,
      input.postings
        .filter((p) => p.account.kind === "CASH")
        .reduce(
          (sum, p) =>
            sum + (p.direction === "DEBIT" ? p.amountPaise : -p.amountPaise),
          0,
        ),
    );
  }
  return { created: true };
});
/** The entries of a stored journal: both legs of a settlement, one debit otherwise. */
const mockEntriesOf = (key: string, value: number) => {
  if (!key.startsWith("settlement:")) {
    return [
      { direction: "DEBIT", amountPaise: value, account: { kind: "OTHER" } },
    ];
  }
  const amountPaise = Math.abs(value);
  const cash = value > 0 ? "DEBIT" : "CREDIT";
  return [
    { direction: cash, amountPaise, account: { kind: "CASH" } },
    {
      direction: cash === "DEBIT" ? "CREDIT" : "DEBIT",
      amountPaise,
      account: { kind: "GATEWAY_CLEARING" },
    },
  ];
};
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
  settlementId?: { in: string[] } | { not: null };
  status?: string | { in: string[] };
  id?: string | { gt: string };
  OR?: LineWhere[];
};
const mockMatches = (l: Line, where: LineWhere): boolean => {
  if (where.OR && !where.OR.some((either) => mockMatches(l, either))) {
    return false;
  }
  if (where.settlementId) {
    if (l.settlementId === null) return false;
    if (
      "in" in where.settlementId &&
      !where.settlementId.in.includes(l.settlementId)
    ) {
      return false;
    }
  }
  if (typeof where.id === "string" && l.id !== where.id) return false;
  if (typeof where.id === "object" && !(l.id > where.id.gt)) return false;
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
          orderBy,
          skip = 0,
          take,
        }: {
          where: LineWhere;
          orderBy?: { id: "asc" };
          skip?: number;
          take?: number;
        }) => {
          const entityIds = where.entityId && new Set(where.entityId.in);
          const hits = mockLines.filter(
            (l) =>
              (!entityIds || entityIds.has(l.entityId)) &&
              mockMatches(l, { ...where, entityId: undefined }),
          );
          // Rows come back in id order only when the query asks for it, as in Postgres.
          const ordered = orderBy
            ? [...hits].sort(
                (x, y) => Number(x.id > y.id) - Number(x.id < y.id),
              )
            : hits;
          return take === undefined
            ? ordered
            : ordered.slice(skip, skip + take);
        },
      ),
      createMany: jest.fn(async ({ data }: { data: Omit<Line, "id">[] }) => {
        for (const row of data) {
          mockLines.push({ ...row, id: lineId(mockLines.length + 1) });
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
        const sums = new Map<
          string,
          { c: bigint; d: bigint; oldest: Date | null }
        >();
        for (const l of mockLines.filter(
          (x) => mockMatches(x, where) && x.settlementId,
        )) {
          const s = sums.get(l.settlementId as string) ?? {
            c: BigInt(0),
            d: BigInt(0),
            oldest: null,
          };
          sums.set(l.settlementId as string, {
            c: s.c + l.creditPaise,
            d: s.d + l.debitPaise,
            oldest:
              l.settledAt && (!s.oldest || l.settledAt < s.oldest)
                ? l.settledAt
                : s.oldest,
          });
        }
        return [...sums].map(([settlementId, s]) => ({
          settlementId,
          _sum: { creditPaise: s.c, debitPaise: s.d },
          _min: { settledAt: s.oldest },
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
        async ({
          where,
          select,
        }: {
          where: { idempotencyKey: { in: string[] } };
          select: { entries: { where?: { direction: string } } };
        }) =>
          where.idempotencyKey.in.flatMap((k) => {
            const value = mockJournals.get(k);
            if (value === undefined) return [];
            const only = select.entries.where?.direction;
            const entries = mockEntriesOf(k, value);
            return [
              {
                idempotencyKey: k,
                entries: only
                  ? entries.filter((e) => e.direction === only)
                  : entries,
              },
            ];
          }),
      ),
    },
  },
}));
/** The run is past its deadline once this many report pages were requested. */
const mockDeadline: { afterReports: number } = { afterReports: Infinity };
jest.mock("../../lib/cron/run-deadline", () => ({
  startDeadline: () => () =>
    mockReportCalls.length >= mockDeadline.afterReports,
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
          if (mockFailingDays.has(day)) throw new Error("report unavailable");
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

import prisma from "../../lib/prisma";
import { InvalidDateParamError } from "../../lib/cron/date-param";
import { runReconcileGatewaySettlements } from "../../jobs/reconcile/reconcile-gateway-settlements";

type RunResult = Awaited<ReturnType<typeof runReconcileGatewaySettlements>>;
/** The continuation record a run leaves as its checkpoint. */
const continuation = (result: RunResult) =>
  JSON.parse(result.checkpoint ?? "null") as {
    read: string | null;
    day: { key: string; skip: number } | null;
    rematchAfter: string | null;
    settle: {
      from: string | null;
      after: string | null;
      stale: boolean;
      held: string[];
    };
    failedDays: string[];
    reread: Array<{ key: string; skip: number }>;
  };
/** A checkpoint that says every day up to `read` was read in full. */
const readThrough = (read: string) =>
  JSON.stringify({
    read,
    day: null,
    rematchAfter: null,
    settle: { from: null, after: null, stale: false },
  });
/** The next run starts from what this one left. */
const carryOn = (result: RunResult) => {
  mockCheckpoint.value = result.checkpoint ?? null;
  mockReportCalls.length = 0;
};

/** Epoch seconds of 10:00 IST on an IST date. */
const settledOn = (date: string) =>
  Math.floor(Date.parse(`${date}T10:00:00+05:30`) / 1000);

beforeEach(() => {
  mockLines.length = 0;
  mockPagesByDay.clear();
  mockReportCalls.length = 0;
  mockSettlements.clear();
  mockCheckpoint.value = null;
  mockDeadline.afterReports = Infinity;
  mockFailingDays.clear();
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
    daysBehind: 0,
    done: true,
  });
  expect(continuation(first).read).toBe("2026-10-19");
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
  mockCheckpoint.value = readThrough("2026-10-19");
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
  mockCheckpoint.value = readThrough("2026-12-18");
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
    mockCheckpoint.value = readThrough("2026-10-10");
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
      daysBehind: 0,
      done: true,
    });
    expect(continuation(caughtUp).read).toBe("2026-10-19");

    mockReportCalls.length = 0;
    mockCheckpoint.value = readThrough("2026-09-01");
    const capped = await runReconcileGatewaySettlements(Date.now(), now);

    expect(daysRead()).toHaveLength(10);
    expect(capped).toMatchObject({ daysBehind: 38, done: false });
    expect(continuation(capped).read).toBe("2026-09-11");
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
    mockCheckpoint.value = readThrough("2026-10-18");
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
    mockCheckpoint.value = readThrough("2026-10-18");
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

  it("an unposted settlement whose stored lines net to zero is resolved only when the gateway also says zero", async () => {
    mockCheckpoint.value = readThrough("2026-10-18");
    const zeroNet = (settlement: string) => [
      {
        ...payment(`pay_${settlement}`, "2026-10-19", 1_000),
        settlement_id: settlement,
      },
      {
        entity_id: `rfnd_${settlement}`,
        type: "refund",
        amount: 1_000,
        credit: 0,
        debit: 1_000,
        settlement_id: settlement,
        settled_at: settledOn("2026-10-19"),
      },
    ];
    mockPagesByDay.set("2026-10-19", [
      [
        ...zeroNet("setl_zero"),
        ...zeroNet("setl_short"),
        ...zeroNet("setl_gone"),
      ],
    ]);
    // The gateway settled nothing for the first, ₹20 for the second, and cannot be read for the third.
    mockSettlements.set("setl_zero", 0);
    mockSettlements.set("setl_short", 2_000);

    const result = await runReconcileGatewaySettlements(Date.now(), now);

    expect(result).toMatchObject({ settlementsPosted: 0, settlementsHeld: 2 });
    expect(
      mockPost.mock.calls.filter(([, input]) =>
        input.idempotencyKey.startsWith("settlement:"),
      ),
    ).toHaveLength(0);
    expect(mockStanding).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "reconcile-gateway-settlements:held",
        ids: ["setl_gone", "setl_short"],
      }),
    );
  });

  it("holds a settlement whose entity cannot be read", async () => {
    mockCheckpoint.value = readThrough("2026-10-18");
    mockPagesByDay.set("2026-10-19", [
      [payment("pay_a", "2026-10-19", 60_000)],
    ]);

    const result = await runReconcileGatewaySettlements(Date.now(), now);

    expect(result).toMatchObject({ settlementsPosted: 0, settlementsHeld: 1 });
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("reports a posted journal that differs from its lines and posts nothing over it", async () => {
    mockCheckpoint.value = readThrough("2026-10-18");
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

  it("reports a posted journal that moved cash the other way from what its lines now say", async () => {
    mockCheckpoint.value = readThrough("2026-10-18");
    // The lines net to ₹10 out of cash; the journal on the books moved ₹10 into cash.
    mockPagesByDay.set("2026-10-19", [
      [
        {
          entity_id: "rfnd_dir",
          type: "refund",
          amount: 1_000,
          credit: 0,
          debit: 1_000,
          settlement_id: "setl_dir",
          settled_at: settledOn("2026-10-19"),
        },
      ],
    ]);
    mockJournals.set("settlement:setl_dir", 1_000);

    const result = await runReconcileGatewaySettlements(Date.now(), now);

    expect(result).toMatchObject({ settlementsPosted: 0, postedMismatches: 1 });
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockStanding).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "reconcile-gateway-settlements:posted-differs",
        ids: ["setl_dir"],
        message: expect.stringContaining(
          "setl_dir: journal 1000 into cash, lines -1000",
        ),
      }),
    );
  });

  it("stores the valid rows of a page, and counts and reports the rejected ones once", async () => {
    mockCheckpoint.value = readThrough("2026-10-18");
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
    });
    expect(continuation(result).read).toBe("2026-10-19");
    expect(mockLines.map((l) => l.entityId)).toEqual(["trf_ok"]);
    const rejects = mockReport.mock.calls.filter(([message]) =>
      String(message).includes("failed validation"),
    );
    expect(rejects).toHaveLength(1);
    expect(rejects[0][0]).toContain("2 row(s)");
  });

  it("matches again a line that was unresolved when the missing row arrives later", async () => {
    mockCheckpoint.value = readThrough("2026-10-18");
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
    mockCheckpoint.value = readThrough("2026-10-18");
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

describe("bounded work resumes from the job's one continuation record", () => {
  // 2026-10-20 08:00 IST; "yesterday" is 2026-10-19 IST.
  const now = new Date("2026-10-20T02:30:00Z");
  const run = () => runReconcileGatewaySettlements(Date.now(), now);
  /** The IST date `days` before 2026-10-20. */
  const daysAgo = (days: number) =>
    new Date(Date.parse("2026-10-20T00:00:00Z") - days * 86_400_000)
      .toISOString()
      .slice(0, 10);
  /** The report mock's key for an IST date. */
  const reportKey = (date: string) =>
    date
      .split("-")
      .map((part) => String(Number(part)))
      .join("-");
  const transfer = (entity_id: string, date: string, settlement: string) => ({
    entity_id,
    type: "transfer",
    amount: 1_000,
    credit: 1_000,
    debit: 0,
    settlement_id: settlement,
    settled_at: settledOn(date),
  });

  it("a day of exactly twenty full pages completes on the next run, from the page it stopped at", async () => {
    mockCheckpoint.value = readThrough("2026-10-18");
    mockPagesByDay.set(
      "2026-10-19",
      Array.from({ length: 20 }, (_, page) =>
        Array.from({ length: 1000 }, (_, i) => ({
          entity_id: `trf_${page}_${i}`,
          type: "transfer",
          amount: 1,
        })),
      ),
    );

    const first = await run();

    expect(first).toMatchObject({ inserted: 20_000, daysBehind: 1 });
    expect(continuation(first)).toMatchObject({
      read: "2026-10-18",
      day: { key: "2026-10-19", skip: 20_000 },
    });

    carryOn(first);
    const second = await run();

    expect(mockReportCalls.filter((c) => c.day === "2026-10-19")[0]).toEqual({
      day: "2026-10-19",
      skip: 20_000,
    });
    expect(second).toMatchObject({ inserted: 0, daysBehind: 0 });
    expect(continuation(second)).toMatchObject({
      read: "2026-10-19",
      day: null,
    });
  });

  it("a first walk cut partway through a day resumes that day, even after a manual run stored a newer line", async () => {
    mockPagesByDay.set("2026-10-18", [
      Array.from({ length: 1000 }, (_, i) =>
        transfer(`trf_first_${i}`, "2026-10-18", "setl_first"),
      ),
      [transfer("trf_tail", "2026-10-18", "setl_first")],
    ]);
    mockDeadline.afterReports = 1;

    const first = await run();

    expect(continuation(first)).toMatchObject({
      read: null,
      day: { key: "2026-10-18", skip: 1000 },
    });

    carryOn(first);
    mockDeadline.afterReports = Infinity;
    const nextMorning = new Date("2026-10-21T02:30:00Z");
    mockPagesByDay.set("2026-10-20", [
      [transfer("trf_newer", "2026-10-20", "setl_newer")],
    ]);
    await runReconcileGatewaySettlements(Date.now(), nextMorning, {
      date: "2026-10-20",
    });
    mockReportCalls.length = 0;

    const second = await runReconcileGatewaySettlements(
      Date.now(),
      nextMorning,
    );

    expect(mockReportCalls[0]).toEqual({ day: "2026-10-18", skip: 1000 });
    expect(mockLines.some((l) => l.entityId === "trf_tail")).toBe(true);
    expect(continuation(second)).toMatchObject({
      read: "2026-10-20",
      day: null,
    });
  });

  it("the re-match reaches every unresolved line within a bounded number of runs", async () => {
    mockCheckpoint.value = readThrough("2026-10-19");
    // Stored newest first, so only a query ordered by id walks them in cursor order.
    for (let i = 450; i >= 1; i--) {
      mockLines.push({
        id: lineId(i),
        entityId: `rfnd_open_${i}`,
        type: "refund",
        settlementId: null,
        settledAt: null,
        amountPaise: BigInt(100),
        feePaise: BigInt(0),
        creditPaise: BigInt(0),
        debitPaise: BigInt(100),
        paymentId: null,
        disputeId: null,
        status: "UNMATCHED",
        matchedKind: "NONE",
        matchedId: null,
        note: null,
      });
    }
    const refundLookups = jest.mocked(prisma.refund.findMany);
    const examined = () =>
      new Set(
        refundLookups.mock.calls.flatMap(
          ([query]) =>
            (query as { where: { refundId: { in: string[] } } }).where.refundId
              .in,
        ),
      );

    const first = await run();
    expect(examined().size).toBe(200);
    expect(continuation(first).rematchAfter).toBe(lineId(200));

    carryOn(first);
    const second = await run();
    carryOn(second);
    const third = await run();

    expect(examined().size).toBe(450);
    expect(continuation(third).rematchAfter).toBeNull();
  });

  it("settlements held at the front of the order do not keep a complete one from being examined", async () => {
    mockCheckpoint.value = readThrough("2026-10-18");
    mockPagesByDay.set("2026-10-19", [
      [
        ...Array.from({ length: 60 }, (_, i) =>
          transfer(
            `trf_h${i}`,
            "2026-10-19",
            `setl_h${String(i).padStart(2, "0")}`,
          ),
        ),
        transfer("trf_ok", "2026-10-19", "setl_zzz"),
      ],
    ]);
    // Only the last settlement in the order can be read and adds up.
    mockSettlements.set("setl_zzz", 1_000);

    const first = await run();

    expect(first).toMatchObject({
      settlementsPosted: 0,
      settlementsHeld: 50,
      done: false,
    });
    expect(continuation(first).settle.after).toBe("setl_h49");

    carryOn(first);
    const second = await run();

    expect(second).toMatchObject({ settlementsPosted: 1, settlementsHeld: 10 });
    expect(mockJournals.get("settlement:setl_zzz")).toBe(1_000);
    expect(continuation(second).settle.after).toBeNull();
  });

  it("days read while catching up beyond the lookback stay in the settlement cohort until they are examined", async () => {
    mockCheckpoint.value = readThrough(daysAgo(101));
    const settled = daysAgo(95);
    mockPagesByDay.set(reportKey(settled), [
      [transfer("trf_old", settled, "setl_old")],
    ]);
    mockSettlements.set("setl_old", 1_000);
    // The deadline passes as the tenth day is read, before any settlement is examined.
    mockDeadline.afterReports = 10;

    const cut = await run();

    expect(cut).toMatchObject({
      inserted: 1,
      settlementsPosted: 0,
      done: false,
    });
    expect(continuation(cut)).toMatchObject({
      read: daysAgo(91),
      settle: { from: daysAgo(100) },
    });

    carryOn(cut);
    mockDeadline.afterReports = Infinity;
    const next = await run();

    expect(next.settlementsPosted).toBe(1);
    expect(mockJournals.get("settlement:setl_old")).toBe(1_000);
    expect(continuation(next)).toMatchObject({
      read: daysAgo(81),
      settle: { from: null, after: null },
    });
  });
  it("a settlement held beyond the lookback stays eligible by id until it resolves", async () => {
    mockCheckpoint.value = readThrough(daysAgo(81));
    const settled = daysAgo(80);
    mockPagesByDay.set(reportKey(settled), [
      [transfer("trf_80", settled, "setl_80")],
    ]);

    // The settlement entity cannot be read: held, and the pass still finishes.
    const held = await run();

    expect(held).toMatchObject({ settlementsPosted: 0, settlementsHeld: 1 });
    expect(continuation(held).settle).toMatchObject({
      from: null,
      after: null,
      held: ["setl_80"],
    });

    carryOn(held);
    mockSettlements.set("setl_80", 1_000);
    const resolved = await run();

    expect(resolved).toMatchObject({
      settlementsPosted: 1,
      settlementsHeld: 0,
    });
    expect(mockJournals.get("settlement:setl_80")).toBe(1_000);
    expect(continuation(resolved).settle.held).toEqual([]);
  });
  it("a day read just inside the lookback is still examined when its first run was cut before the examination", async () => {
    // At 08:00 IST on 20 October the lookback starts at 08:00 IST on 21 August;
    // 22 August starts after that, and its settlement settles at 07:00 IST.
    mockCheckpoint.value = readThrough("2026-08-21");
    mockPagesByDay.set("2026-8-22", [
      [
        {
          ...transfer("trf_edge", "2026-08-22", "setl_edge"),
          settled_at: Math.floor(
            Date.parse("2026-08-22T07:00:00+05:30") / 1000,
          ),
        },
      ],
    ]);
    mockSettlements.set("setl_edge", 1_000);
    mockDeadline.afterReports = 1;

    const cut = await run();

    expect(cut).toMatchObject({ inserted: 1, settlementsPosted: 0 });
    expect(continuation(cut).settle.from).toBe("2026-08-22");

    carryOn(cut);
    mockDeadline.afterReports = Infinity;
    // A day later the lookback starts at 08:00 IST on 22 August, after that settlement.
    const next = await runReconcileGatewaySettlements(
      Date.now(),
      new Date("2026-10-21T02:30:00Z"),
    );

    expect(next.settlementsPosted).toBe(1);
    expect(mockJournals.get("settlement:setl_edge")).toBe(1_000);
  });
  it("a re-read cut by the page bound resumes at its page, and the other recent day is still read again", async () => {
    mockCheckpoint.value = readThrough("2026-10-19");
    mockPagesByDay.set(
      "2026-10-18",
      Array.from({ length: 20 }, (_, page) =>
        Array.from({ length: 1000 }, (_, i) => ({
          entity_id: `trf_r_${page}_${i}`,
          type: "transfer",
          amount: 1,
        })),
      ),
    );
    mockPagesByDay.set("2026-10-19", [
      [{ entity_id: "trf_late", type: "transfer", amount: 1 }],
    ]);

    const first = await run();

    expect(mockLines.some((l) => l.entityId === "trf_late")).toBe(true);
    expect(first.stoppedShort).toEqual([
      {
        bound: "report-pages",
        stage: "report",
        date: "2026-10-18",
        reached: 20_000,
      },
    ]);
    expect(continuation(first).reread).toEqual([
      { key: "2026-10-18", skip: 20_000 },
    ]);

    carryOn(first);
    const second = await run();

    expect(mockReportCalls[0]).toEqual({ day: "2026-10-18", skip: 20_000 });
    expect(second.stoppedShort).toEqual([]);
    expect(continuation(second).reread).toEqual([]);
  });
});

describe("a bound that stops a run is never silent", () => {
  // 2026-10-20 08:00 IST.
  const now = new Date("2026-10-20T02:30:00Z");
  const manual = (date: string) =>
    runReconcileGatewaySettlements(Date.now(), now, { date });

  it("a manual run of a day past the page bound answers incomplete with the date and the rows reached", async () => {
    mockPagesByDay.set(
      "2026-10-5",
      Array.from({ length: 20 }, (_, page) =>
        Array.from({ length: 1000 }, (_, i) => ({
          entity_id: `trf_m_${page}_${i}`,
          type: "transfer",
          amount: 1,
          credit: 1,
          settlement_id: "setl_big",
          settled_at: settledOn("2026-10-05"),
        })),
      ),
    );
    mockSettlements.set("setl_big", 20_000);

    const result = await manual("2026-10-05");

    expect(result).toMatchObject({
      inserted: 20_000,
      settlementsPosted: 0,
      done: false,
      stoppedShort: [
        {
          bound: "report-pages",
          stage: "report",
          date: "2026-10-05",
          reached: 20_000,
        },
      ],
    });
    expect(mockStanding).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "reconcile-gateway-settlements:stopped-short",
        ids: ["report-pages:2026-10-05"],
        message: expect.stringContaining(
          "report-pages on 2026-10-05 after 20000 report rows",
        ),
      }),
    );
  });

  it("a manual run that spends its settlement reads answers incomplete with the last settlement examined", async () => {
    mockPagesByDay.set("2026-10-5", [
      Array.from({ length: 60 }, (_, i) => ({
        entity_id: `trf_s_${i}`,
        type: "transfer",
        amount: 1_000,
        credit: 1_000,
        settlement_id: `setl_m${String(i).padStart(2, "0")}`,
        settled_at: settledOn("2026-10-05"),
      })),
    ]);

    const result = await manual("2026-10-05");

    expect(result).toMatchObject({
      settlementsHeld: 50,
      done: false,
      stoppedShort: [
        {
          bound: "settlement-reads",
          stage: "settlements",
          date: "2026-10-05",
          reached: 50,
          after: "setl_m49",
        },
      ],
    });
    expect(mockStanding).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "reconcile-gateway-settlements:stopped-short",
        ids: ["settlement-reads:2026-10-05"],
      }),
    );
  });
});

describe("a date whose report cannot be read does not stop the run", () => {
  // 2026-10-20 08:00 IST; "yesterday" is 2026-10-19 IST.
  const now = new Date("2026-10-20T02:30:00Z");
  const run = () => runReconcileGatewaySettlements(Date.now(), now);
  const line = (entity_id: string, date: string) => ({
    entity_id,
    type: "transfer",
    amount: 1_000,
    credit: 1_000,
    debit: 0,
    settlement_id: `setl_${date}`,
    settled_at: settledOn(date),
  });

  it("the failing date is passed over and retried first on later runs, and a later date's settlement is examined in the same run", async () => {
    mockCheckpoint.value = readThrough("2026-10-09");
    mockFailingDays.add("2026-10-12");
    mockPagesByDay.set("2026-10-12", [[line("trf_12", "2026-10-12")]]);
    mockPagesByDay.set("2026-10-15", [[line("trf_15", "2026-10-15")]]);
    mockSettlements.set("setl_2026-10-12", 1_000);
    mockSettlements.set("setl_2026-10-15", 1_000);

    const first = await run();

    expect(first).toMatchObject({
      settlementsPosted: 1,
      failedDays: ["2026-10-12"],
      daysBehind: 0,
      done: false,
    });
    expect(mockJournals.get("settlement:setl_2026-10-15")).toBe(1_000);
    expect(continuation(first)).toMatchObject({
      read: "2026-10-19",
      failedDays: ["2026-10-12"],
    });
    expect(mockStanding).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "reconcile-gateway-settlements:report-failed",
        ids: ["2026-10-12"],
        message: expect.stringContaining("2026-10-12 (report unavailable)"),
      }),
    );

    carryOn(first);
    const second = await run();

    expect(mockReportCalls[0]).toEqual({ day: "2026-10-12", skip: 0 });
    expect(continuation(second).failedDays).toEqual(["2026-10-12"]);

    carryOn(second);
    mockFailingDays.clear();
    const third = await run();

    expect(third).toMatchObject({
      inserted: 1,
      settlementsPosted: 1,
      failedDays: [],
    });
    expect(mockJournals.get("settlement:setl_2026-10-12")).toBe(1_000);
    expect(continuation(third).failedDays).toEqual([]);
  });

  it("a second failing date in one run stops the walk there, and the later passes still run", async () => {
    mockCheckpoint.value = readThrough("2026-10-09");
    mockFailingDays.add("2026-10-12");
    mockFailingDays.add("2026-10-14");
    mockPagesByDay.set("2026-10-11", [[line("trf_11", "2026-10-11")]]);
    mockSettlements.set("setl_2026-10-11", 1_000);

    const result = await run();

    expect(result).toMatchObject({
      settlementsPosted: 1,
      failedDays: ["2026-10-12", "2026-10-14"],
      daysBehind: 6,
    });
    expect(continuation(result)).toMatchObject({
      read: "2026-10-13",
      failedDays: ["2026-10-12"],
    });
  });
});
