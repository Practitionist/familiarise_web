/**
 * @jest-environment node
 *
 * A consultant payout whose first submit lost its reply is re-armed by the real
 * stuck-payout job and sent again under the same idempotency key. RazorpayX
 * refuses a different body under a used key, so the retry must send the body
 * staged at the first submit. The database and RazorpayX are in-memory doubles;
 * a model or method the database double lacks throws instead of returning undefined.
 */

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;
type QueryArgs = {
  where?: Where;
  select?: Record<string, unknown>;
  include?: Record<string, unknown>;
  take?: number;
};
type Tables = Record<string, Row[]>;
type PrismaDouble = {
  __tables: Tables;
  __catchUpWrites: Array<{ id: unknown; value: unknown }>;
  /** One-shot hooks run before the next single-row read of a table. */
  __beforeRead: Record<string, () => Promise<void>>;
};
type FakeGateway = {
  requests: Row[];
  timeoutNext: boolean;
  /** What the reference list answers: lagging (nothing), current, or an error. */
  list: "lagging" | "current" | "error";
  lookups: number;
  reset(): void;
};

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: mockPrismaDouble(),
}));
jest.mock("@/lib/payments/payouts/razorpay-payouts", () => {
  const actual = jest.requireActual("@/lib/payments/payouts/razorpay-payouts");
  const gateway = mockFakeGateway(actual);
  return {
    ...actual,
    __gateway: gateway,
    getRazorpayPayoutsService: () => gateway,
    isRazorpayPayoutsConfigured: () => true,
    resolveRazorpayXCredentials: () => ({
      keyId: "rzp_test_key",
      keySecret: "secret",
    }),
  };
});
jest.mock("@/lib/feature-flags", () => ({
  ...jest.requireActual("@/lib/feature-flags"),
  ENABLE_LIVE_PAYOUTS: true,
  ENABLE_TDS_194O_GROSS: true,
}));
jest.mock("@/lib/payments/payouts/balance-preflight", () => ({
  assertPayoutBalance: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock("@/lib/redis", () => ({
  acquireLock: jest.fn().mockResolvedValue("tok"),
  releaseLock: jest.fn().mockResolvedValue(undefined),
  isMockRedis: jest.fn().mockReturnValue(false),
  checkRedisHealth: jest.fn().mockResolvedValue(true),
  isRedisCircuitOpen: jest.fn().mockReturnValue(false),
}));
jest.mock("@/lib/cron/with-cron-lock", () => ({
  ...jest.requireActual("@/lib/cron/with-cron-lock"),
  withCronLock: (_name: string, _opts: unknown, fn: () => unknown) => fn(),
}));
jest.mock("@/lib/payments/ledger/post", () => ({
  ...jest.requireActual("@/lib/payments/ledger/post"),
  postLedgerTxn: jest.fn().mockResolvedValue({ created: true }),
}));
jest.mock("@/lib/enterprise/system-events", () => ({
  ...jest.requireActual("@/lib/enterprise/system-events"),
  recordSystemEvent: jest.fn(),
  recordSystemEventSafe: jest.fn(),
  recordSystemError: jest.fn(),
}));
jest.mock("@/lib/observability/report", () => ({
  ...jest.requireActual("@/lib/observability/report"),
  reportSentryError: jest.fn(),
  reportSentryMessage: jest.fn(),
}));
jest.mock("@/lib/novu/service", () => ({
  notifyPayoutProcessed: jest.fn(),
  notifyPayoutFailed: jest.fn(),
}));
jest.mock("@/lib/novu/outbox", () => ({
  ...jest.requireActual("@/lib/novu/outbox"),
  attemptTrigger: jest.fn(),
}));
jest.mock("@/lib/email/senders/money", () => ({
  ...jest.requireActual("@/lib/email/senders/money"),
  stagePayoutStatusEmail: jest.fn().mockResolvedValue([]),
}));
jest.mock("@/lib/email/send-to-recipients", () => ({
  ...jest.requireActual("@/lib/email/send-to-recipients"),
  attemptStaged: jest.fn(),
}));

import { PaymentGateway } from "@prisma/client";
import prisma from "@/lib/prisma";
import * as razorpayPayouts from "@/lib/payments/payouts/razorpay-payouts";
import { postLedgerTxn } from "@/lib/payments/ledger/post";
import {
  approvePayout,
  createPayoutBatch,
  handlePayoutWebhook,
  processApprovedPayouts,
  processPayoutById,
} from "@/lib/payments/payouts/payout-service";
import { reportSentryError } from "@/lib/observability/report";
import { buildPayoutCompletionPostings } from "@/lib/payments/payouts/shared-lifecycle";
import { getIndianFinancialYear } from "@/lib/payments/tax/tds-service";
import { handleStuckPayouts } from "@/scripts/payouts/handle-stuck-payouts";

const LIVE = ["PROCESSING", "COMPLETED"];

/** An in-memory Prisma client over plain tables; any model or method it lacks throws. */
function mockPrismaDouble() {
  const tables: Tables = {};
  const catchUpWrites: Array<{ id: unknown; value: unknown }> = [];
  const beforeRead: Record<string, () => Promise<void>> = {};
  const relations: Record<
    string,
    Record<
      string,
      { table: string; local: string; foreign: string; many?: boolean }
    >
  > = {
    consultantPayout: {
      payoutAccount: {
        table: "payoutAccount",
        local: "payoutAccountId",
        foreign: "id",
      },
      consultantProfile: {
        table: "consultantProfile",
        local: "consultantProfileId",
        foreign: "id",
      },
      earnings: {
        table: "consultantEarnings",
        local: "id",
        foreign: "payoutId",
        many: true,
      },
    },
    consultantProfile: {
      payoutAccounts: {
        table: "payoutAccount",
        local: "id",
        foreign: "consultantProfileId",
        many: true,
      },
      user: { table: "user", local: "userId", foreign: "id" },
    },
    consultantEarnings: {
      payout: { table: "consultantPayout", local: "payoutId", foreign: "id" },
      payment: { table: "payment", local: "paymentId", foreign: "id" },
    },
  };
  const rows = (table: string) => (tables[table] ??= []);
  // Column defaults from prisma/schema.prisma for the rows the app creates.
  const DEFAULTS: Record<string, Row> = {
    consultantPayout: {
      retryCount: 0,
      tdsDeducted: 0,
      netAmount: null,
      tdsRateAppliedBps: null,
      tdsFinancialYear: null,
      tdsCatchUpFy: null,
      tdsCarryPaise: 0,
      tdsCreditPaise: 0,
      clawbackAmountPaise: 0,
      providerPayoutId: null,
      failureReason: null,
      processedAt: null,
      gatewayUtr: null,
      lastReconciledAt: null,
    },
  };
  const norm = (v: unknown) => (v === undefined ? null : v);
  const eq = (a: unknown, b: unknown) =>
    a instanceof Date && b instanceof Date
      ? a.getTime() === b.getTime()
      : norm(a) === norm(b);
  const num = (v: unknown) => (v instanceof Date ? v.getTime() : Number(v));
  const isOps = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === "object" && !(v instanceof Date);

  function fieldMatches(value: unknown, cond: unknown): boolean {
    if (!isOps(cond)) return eq(value, cond);
    return Object.entries(cond).every(([op, arg]) => {
      if (arg === undefined) return true;
      const present = value !== null && value !== undefined;
      switch (op) {
        case "equals":
          return eq(value, arg);
        case "not":
          return isOps(arg) ? !fieldMatches(value, arg) : !eq(value, arg);
        case "in":
          return (arg as unknown[]).some((a) => eq(value, a));
        case "notIn":
          return !(arg as unknown[]).some((a) => eq(value, a));
        case "lt":
          return present && num(value) < num(arg);
        case "lte":
          return present && num(value) <= num(arg);
        case "gt":
          return present && num(value) > num(arg);
        case "gte":
          return present && num(value) >= num(arg);
        default:
          throw new Error(`Prisma double: no filter operator ${op}`);
      }
    });
  }

  function related(table: string, row: Row, name: string) {
    const rel = relations[table]?.[name];
    if (!rel) return undefined;
    const hits = rows(rel.table).filter((r) =>
      eq(r[rel.foreign], row[rel.local]),
    );
    return { rel, value: rel.many ? hits : (hits[0] ?? null) };
  }

  function matches(table: string, row: Row, where: Where = {}): boolean {
    return Object.entries(where).every(([key, cond]) => {
      if (cond === undefined) return true;
      if (key === "OR")
        return (cond as Where[]).some((w) => matches(table, row, w));
      if (key === "AND")
        return (cond as Where[]).every((w) => matches(table, row, w));
      const link = related(table, row, key);
      if (link) {
        if (link.rel.many)
          throw new Error(`Prisma double: no to-many filter ${table}.${key}`);
        const target = link.value as Row | null;
        if (cond === null) return target === null;
        return (
          target !== null && matches(link.rel.table, target, cond as Where)
        );
      }
      return fieldMatches(row[key], cond);
    });
  }

  function project(table: string, row: Row, args: QueryArgs): Row {
    const pick = args.select ?? args.include;
    const out: Row = args.select ? {} : { ...row };
    for (const [key, spec] of Object.entries(pick ?? {})) {
      if (!spec) continue;
      const link = related(table, row, key);
      if (!link) {
        out[key] = row[key];
        continue;
      }
      const nested: QueryArgs = spec === true ? {} : (spec as QueryArgs);
      out[key] = link.rel.many
        ? (link.value as Row[])
            .filter((r) => matches(link.rel.table, r, nested.where))
            .map((r) => project(link.rel.table, r, nested))
        : link.value && project(link.rel.table, link.value as Row, nested);
    }
    return out;
  }

  function written(row: Row, data: Row): Row {
    const next: Row = { ...row };
    for (const [key, v] of Object.entries(data)) {
      if (v === undefined) continue;
      if (isOps(v)) {
        if (typeof v.increment !== "number")
          throw new Error(`Prisma double: no write operator on ${key}`);
        next[key] = Number(next[key]) + v.increment;
      } else {
        next[key] = v;
      }
    }
    return next;
  }

  function assertCatchUpIndex(table: string, next: Row) {
    if (table !== "consultantPayout" || next.tdsCatchUpFy === null) return;
    if (!LIVE.includes(next.status as string)) return;
    const taken = rows(table).some(
      (o) =>
        o.id !== next.id &&
        o.consultantProfileId === next.consultantProfileId &&
        o.tdsCatchUpFy === next.tdsCatchUpFy &&
        LIVE.includes(o.status as string),
    );
    if (taken) {
      throw Object.assign(
        new Error(
          "Unique constraint failed: consultant_payout_one_tds_catch_up_per_fy",
        ),
        {
          code: "P2002",
          meta: { target: "consultant_payout_one_tds_catch_up_per_fy" },
        },
      );
    }
  }

  function update(table: string, hits: Row[], data: Row) {
    const nexts = hits.map((r) => written(r, data));
    nexts.forEach((n) => assertCatchUpIndex(table, n));
    hits.forEach((r, i) => {
      if (table === "consultantPayout") {
        nexts[i].updatedAt = new Date();
        if (data.tdsCatchUpFy !== undefined) {
          catchUpWrites.push({ id: r.id, value: data.tdsCatchUpFy });
        }
      }
      Object.assign(r, nexts[i]);
    });
  }

  const sumOf = (hits: Row[], fields: Record<string, unknown>) =>
    Object.fromEntries(
      Object.keys(fields).map((f) => [
        f,
        hits.length === 0
          ? null
          : hits.reduce((s, r) => s + Number(r[f] ?? 0), 0),
      ]),
    );

  function loud<T extends object>(name: string, target: T): T {
    return new Proxy(target, {
      get(t, prop, receiver) {
        if (typeof prop === "symbol" || prop === "then" || prop in t) {
          return Reflect.get(t, prop, receiver);
        }
        throw new Error(`Prisma double has no ${name}.${prop}`);
      },
    });
  }

  function model(table: string) {
    const find = (where?: Where) =>
      rows(table).filter((r) => matches(table, r, where));
    const first = async (args: QueryArgs = {}) => {
      const hook = beforeRead[table];
      if (hook) {
        delete beforeRead[table];
        await hook();
      }
      const hit = find(args.where)[0];
      return hit ? project(table, hit, args) : null;
    };
    return loud(table, {
      findMany: async (args: QueryArgs = {}) =>
        find(args.where)
          .slice(0, args.take ?? Infinity)
          .map((r) => project(table, r, args)),
      findFirst: first,
      findUnique: first,
      findUniqueOrThrow: async (args: QueryArgs) => {
        const hit = await first(args);
        if (!hit) throw new Error(`Prisma double: no ${table} row`);
        return hit;
      },
      count: async (args: QueryArgs = {}) => find(args.where).length,
      aggregate: async (args: {
        where?: Where;
        _sum: Record<string, unknown>;
      }) => ({ _sum: sumOf(find(args.where), args._sum) }),
      groupBy: async (args: {
        by: string[];
        where?: Where;
        _sum: Record<string, unknown>;
        having?: Record<string, { _sum: Record<string, unknown> }>;
      }) => {
        const groups = new Map<string, Row[]>();
        for (const r of find(args.where)) {
          const key = JSON.stringify(args.by.map((b) => r[b]));
          groups.set(key, [...(groups.get(key) ?? []), r]);
        }
        return [...groups.values()]
          .map((g) => ({
            ...Object.fromEntries(args.by.map((b) => [b, g[0][b]])),
            _sum: sumOf(g, args._sum),
          }))
          .filter((g) =>
            Object.entries(args.having ?? {}).every(([f, h]) =>
              fieldMatches(g._sum[f], h._sum),
            ),
          );
      },
      create: async (args: { data: Row }) => {
        const row = {
          id: `${table}_${rows(table).length + 1}`,
          ...DEFAULTS[table],
          createdAt: new Date(),
          updatedAt: new Date(),
          ...args.data,
        };
        rows(table).push(row);
        return row;
      },
      updateMany: async (args: { where: Where; data: Row }) => {
        const hits = find(args.where);
        update(table, hits, args.data);
        return { count: hits.length };
      },
      update: async (args: { where: Where; data: Row }) => {
        const hits = find(args.where).slice(0, 1);
        if (hits.length === 0) throw new Error(`Prisma double: no ${table}`);
        update(table, hits, args.data);
        return hits[0];
      },
      deleteMany: async (args: { where?: Where } = {}) => {
        const hits = find(args.where);
        tables[table] = rows(table).filter((r) => !hits.includes(r));
        return { count: hits.length };
      },
    });
  }

  const client: Row = {
    __tables: tables,
    __catchUpWrites: catchUpWrites,
    __beforeRead: beforeRead,
    $executeRaw: async () => 0,
    // Notices are mocked out; these exist so the notice code takes its production branch.
    notificationOutbox: loud("notificationOutbox", { upsert: jest.fn() }),
    failedEmail: loud("failedEmail", { create: jest.fn() }),
    ledgerTransaction: loud("ledgerTransaction", {
      findMany: async () => [],
    }),
    ledgerEntry: loud("ledgerEntry", { groupBy: async () => [] }),
    tdsRate: loud("tdsRate", { findFirst: async () => null }),
  };
  for (const table of [
    "consultantPayout",
    "consultantEarnings",
    "consultantProfile",
    "consultantTaxInfo",
    "payoutAccount",
    "organizationPayout",
    "tDSRecord",
    "user",
  ]) {
    client[table] = model(table);
  }
  const db = loud("prisma", client);
  client.$transaction = async (fn: unknown) => {
    if (typeof fn !== "function") {
      throw new Error("Prisma double: only interactive transactions");
    }
    return fn(db);
  };
  return db;
}

/** RazorpayX under one idempotency key: the same body returns the payout, another body is a 400. */
function mockFakeGateway(actual: typeof razorpayPayouts) {
  const byKey = new Map<
    string,
    { body: string; id: string; referenceId: unknown }
  >();
  const gateway = {
    requests: [] as Row[],
    timeoutNext: false,
    list: "lagging" as "lagging" | "current" | "error",
    lookups: 0,
    reset() {
      byKey.clear();
      gateway.requests.length = 0;
      gateway.timeoutNext = false;
      gateway.list = "lagging";
      gateway.lookups = 0;
    },
    async createPayout(request: Row) {
      gateway.requests.push(request);
      const key = String(request.idempotencyKey);
      const body = JSON.stringify(request);
      const prior = byKey.get(key);
      if (prior && prior.body !== body) {
        throw new actual.RazorpayXHttpError(
          "Different request body sent for the same idempotency key",
          "BAD_REQUEST_ERROR",
          400,
        );
      }
      const id = prior?.id ?? `pout_${byKey.size + 1}`;
      byKey.set(key, { body, id, referenceId: request.referenceId });
      if (gateway.timeoutNext) {
        gateway.timeoutNext = false;
        throw Object.assign(
          new Error("The operation was aborted due to timeout"),
          { name: "TimeoutError" },
        );
      }
      return { id, status: "processing" };
    },
    // By default the reference list lags the create, so a lookup sees nothing.
    async listPayouts(params: { referenceId?: string }) {
      gateway.lookups += 1;
      if (gateway.list === "error") throw new Error("RazorpayX list failed");
      const items =
        gateway.list === "current"
          ? [...byKey.values()]
              .filter((p) => p.referenceId === params.referenceId)
              .map((p) => ({ id: p.id, reference_id: p.referenceId }))
          : [];
      return { entity: "collection", count: items.length, items };
    },
    determinePayoutMode:
      actual.RazorpayPayoutsService.prototype.determinePayoutMode,
    generateIdempotencyKey: (id: string) => `payout_${id}`,
  };
  return gateway;
}

const db = prisma as unknown as PrismaDouble;
const gateway = (razorpayPayouts as unknown as { __gateway: FakeGateway })
  .__gateway;
const FY = getIndianFinancialYear();
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
const row = (table: string, id: string) => {
  const hit = db.__tables[table].find((r) => r.id === id);
  if (!hit) throw new Error(`no ${table} ${id}`);
  return hit;
};

function payoutRow(fields: Row): Row {
  return {
    consultantProfileId: "cp_1",
    provider: "RAZORPAY",
    currency: "INR",
    method: "BANK_TRANSFER",
    batchId: "batch_1",
    kind: null,
    payoutAccountId: "pa_1",
    retryCount: 0,
    tdsDeducted: 0,
    netAmount: null,
    tdsRateAppliedBps: null,
    tdsFinancialYear: null,
    tdsCatchUpFy: null,
    tdsCarryPaise: 0,
    tdsCreditPaise: 0,
    clawbackAmountPaise: 0,
    providerPayoutId: null,
    failureReason: null,
    processedAt: null,
    approvedAt: hoursAgo(30),
    approvedBy: "SYSTEM_AUTO_APPROVE",
    createdBy: null,
    gatewayUtr: null,
    lastReconciledAt: null,
    createdAt: hoursAgo(30),
    updatedAt: hoursAgo(30),
    ...fields,
  };
}

function earningRow(fields: Row): Row {
  return {
    consultantProfileId: "cp_1",
    paymentId: null,
    refundedShareAmount: 0,
    releasedFromPayoutId: null,
    paidAt: null,
    ...fields,
  };
}

/** A completed payout of the same expert in this FY, planned while the other one was not live. */
function completedPayout(
  id: string,
  fields: { amount: number; grossPaise: number } & Row,
) {
  const { grossPaise, ...payout } = fields;
  db.__tables.consultantPayout.push(
    payoutRow({
      id,
      status: "COMPLETED",
      tdsFinancialYear: getIndianFinancialYear(),
      tdsRateAppliedBps: 0,
      netAmount: payout.amount,
      processedAt: new Date(),
      idempotencyKey: `key_${id}`,
      ...payout,
    }),
  );
  db.__tables.consultantEarnings.push(
    earningRow({
      id: `e_${id}`,
      payoutId: id,
      status: "PAID",
      grossAmount: grossPaise,
      consultantSharePaise: (grossPaise * 4) / 5,
      paidAt: new Date(),
    }),
  );
}

/** Expert with one prior completed payout this FY and payout A: ₹20,000 gross, ₹16,000 share. */
function seed(opts: {
  priorAmountPaise: number;
  priorGrossPaise: number;
  panVerified?: boolean;
}) {
  for (const key of Object.keys(db.__tables)) delete db.__tables[key];
  db.__catchUpWrites.length = 0;
  gateway.reset();
  Object.assign(db.__tables, {
    user: [{ id: "u_1", name: "Priya", email: "priya@example.test" }],
    consultantProfile: [{ id: "cp_1", userId: "u_1" }],
    consultantTaxInfo: [
      {
        id: "ti_1",
        consultantProfileId: "cp_1",
        isIndianResident: true,
        taxEntityType: "INDIVIDUAL",
        panEncrypted: "encrypted-pan",
        panVerified: opts.panVerified ?? true,
      },
    ],
    payoutAccount: [
      {
        id: "pa_1",
        consultantProfileId: "cp_1",
        provider: "RAZORPAY",
        isDefault: true,
        isVerified: true,
        razorpayFundAccId: "fa_1",
        accountType: "BANK_ACCOUNT",
        payoutsAllowedAfter: null,
        payoutsFrozenAt: null,
      },
    ],
    consultantPayout: [
      payoutRow({
        id: "po_A",
        status: "APPROVED",
        amount: 1_600_000,
        idempotencyKey: "payout_cp_1_week47",
      }),
    ],
    consultantEarnings: [
      earningRow({
        id: "e_A",
        payoutId: "po_A",
        status: "BATCHED",
        grossAmount: 2_000_000,
        consultantSharePaise: 1_600_000,
      }),
    ],
    tDSRecord: [],
    organizationPayout: [],
    payment: [],
  });
  completedPayout("po_prior", {
    amount: opts.priorAmountPaise,
    grossPaise: opts.priorGrossPaise,
  });
}

/** First submit: RazorpayX creates the payout but the reply times out. */
async function firstSubmitTimesOut() {
  gateway.timeoutNext = true;
  await processApprovedPayouts();
  expect(gateway.requests).toHaveLength(1);
  expect(row("consultantPayout", "po_A")).toMatchObject({
    status: "PROCESSING",
    providerPayoutId: null,
  });
}

/** A day later the stuck-payout job finds no payout by reference and re-arms the row. */
async function stuckJobReArms() {
  row("consultantPayout", "po_A").updatedAt = hoursAgo(25);
  await handleStuckPayouts();
  expect(row("consultantPayout", "po_A")).toMatchObject({
    status: "APPROVED",
    retryCount: 1,
  });
}

const stagedFields = (id: string) => {
  const p = row("consultantPayout", id);
  return {
    netAmount: p.netAmount,
    tdsDeducted: p.tdsDeducted,
    tdsRateAppliedBps: p.tdsRateAppliedBps,
    tdsFinancialYear: p.tdsFinancialYear,
    tdsCatchUpFy: p.tdsCatchUpFy,
    tdsCarryPaise: p.tdsCarryPaise,
    tdsCreditPaise: p.tdsCreditPaise,
  };
};

beforeEach(() => {
  delete process.env.TDS_ENGINE;
  process.env.ENABLE_TDS_194O_GROSS = "true";
});
afterAll(() => {
  delete process.env.TDS_ENGINE;
  delete process.env.ENABLE_TDS_194O_GROSS;
});

describe("a retried consultant payout sends the body staged at its first submit", () => {
  it.each([
    // LEGACY reads the FY sum of completed payout amounts (₹50,000 threshold).
    { engine: "LEGACY", priorAmountPaise: 3_000_000, priorGrossPaise: 0 },
    // 194-O reads the FY earnings gross (₹5,00,000 threshold).
    { engine: "194O", priorAmountPaise: 0, priorGrossPaise: 47_000_000 },
  ])(
    "$engine: another payout completing between attempts does not change the resent body",
    async ({ engine, priorAmountPaise, priorGrossPaise }) => {
      process.env.TDS_ENGINE = engine;
      seed({ priorAmountPaise, priorGrossPaise });
      await firstSubmitTimesOut();
      expect(gateway.requests[0].amount).toBe(1_600_000);

      // An instant payout of ₹20,000 gross completes while A waits.
      completedPayout("po_B", {
        amount: 1_600_000,
        grossPaise: 2_000_000,
        kind: "INSTANT",
      });
      await stuckJobReArms();
      const results = await processApprovedPayouts();

      expect(gateway.requests).toHaveLength(2);
      expect(gateway.requests[1]).toEqual(gateway.requests[0]);
      expect(results).toEqual([
        { payoutId: "po_A", success: true, providerPayoutId: "pout_1" },
      ]);
      expect(row("consultantPayout", "po_A")).toMatchObject({
        status: "PROCESSING",
        providerPayoutId: "pout_1",
        netAmount: 1_600_000,
      });
    },
  );

  it("keeps the FY catch-up it took on the first submit and never re-takes it", async () => {
    // ₹4,90,000 before A, so A crosses ₹5L and withholds 0.1% of ₹5,10,000.
    seed({ priorAmountPaise: 0, priorGrossPaise: 49_000_000 });
    await firstSubmitTimesOut();
    expect(stagedFields("po_A")).toMatchObject({
      netAmount: 1_549_000,
      tdsDeducted: 51_000,
      tdsCatchUpFy: FY,
    });
    const staged = stagedFields("po_A");

    await stuckJobReArms();
    await processApprovedPayouts();

    expect(gateway.requests[1]).toEqual(gateway.requests[0]);
    expect(stagedFields("po_A")).toEqual(staged);
    expect(
      db.__catchUpWrites.filter((w) => w.id === "po_A").map((w) => w.value),
    ).toEqual([FY]);
  });

  /** A's first submit takes the FY catch-up; while A waits re-armed, instant payout B takes it too. */
  async function catchUpTakenWhileWaiting() {
    seed({ priorAmountPaise: 0, priorGrossPaise: 49_000_000 });
    await firstSubmitTimesOut();
    const staged = stagedFields("po_A");
    await stuckJobReArms();
    // B holds the catch-up, as a payout planned before staged retries were counted could.
    completedPayout("po_B", {
      amount: 1_600_000,
      grossPaise: 2_000_000,
      kind: "INSTANT",
      tdsDeducted: 51_000,
      tdsRateAppliedBps: 10,
      tdsCatchUpFy: FY,
    });
    return staged;
  }
  const catchUpReports = () =>
    jest
      .mocked(reportSentryError)
      .mock.calls.filter(
        ([, opts]) => opts?.op === "payout-tds-catch-up-taken",
      );

  it("fails the retry unsent and releases its earnings when another payout took the FY catch-up and a fresh lookup finds none", async () => {
    await catchUpTakenWhileWaiting();
    const lookupsBefore = gateway.lookups;

    const results = await processApprovedPayouts();

    expect(gateway.lookups).toBe(lookupsBefore + 1);
    expect(gateway.requests).toHaveLength(1);
    expect(results).toEqual([
      expect.objectContaining({
        payoutId: "po_A",
        success: false,
        error: expect.stringContaining("TDS_CATCH_UP_TAKEN"),
      }),
    ]);
    expect(row("consultantPayout", "po_A")).toMatchObject({
      status: "FAILED",
      failureReason: expect.stringContaining("TDS_CATCH_UP_TAKEN"),
      netAmount: null,
      tdsDeducted: 0,
      tdsRateAppliedBps: null,
      tdsFinancialYear: null,
      tdsCatchUpFy: null,
      tdsCarryPaise: 0,
      tdsCreditPaise: 0,
    });
    expect(row("consultantEarnings", "e_A")).toMatchObject({
      status: "READY",
      payoutId: null,
      releasedFromPayoutId: "po_A",
    });
    expect(catchUpReports()).toHaveLength(1);
  });

  it("pays the released earnings in the next batch under a new key, re-planned without a second catch-up", async () => {
    await catchUpTakenWhileWaiting();
    await processApprovedPayouts();

    const batch = await createPayoutBatch(["cp_1"]);
    expect(batch.minted).toBe(1);
    const next = db.__tables.consultantPayout.find(
      (p) => p.status === "PENDING",
    );
    expect(next).toBeDefined();
    await approvePayout(String(next?.id), "admin_1");
    await processApprovedPayouts();

    // ₹5,30,000 this FY needs ₹530; B already holds ₹510, so the new payout withholds ₹20.
    expect(gateway.requests).toHaveLength(2);
    expect(gateway.requests[1]).toMatchObject({
      referenceId: next?.id,
      amount: 1_598_000,
    });
    expect(gateway.requests[1].idempotencyKey).not.toBe("payout_cp_1_week47");
    expect(stagedFields(String(next?.id))).toMatchObject({
      netAmount: 1_598_000,
      tdsDeducted: 2_000,
      tdsCatchUpFy: null,
    });
    expect(row("consultantEarnings", "e_A")).toMatchObject({
      status: "BATCHED",
      payoutId: next?.id,
    });
  });

  it("never releases a retry that carries a gateway id when its catch-up was taken", async () => {
    const staged = await catchUpTakenWhileWaiting();
    row("consultantPayout", "po_A").providerPayoutId = "pout_1";

    const results = await processApprovedPayouts();

    expect(gateway.requests).toHaveLength(1);
    expect(results).toEqual([
      expect.objectContaining({
        payoutId: "po_A",
        success: false,
        skipped: true,
      }),
    ]);
    expect(row("consultantPayout", "po_A")).toMatchObject({
      status: "APPROVED",
      providerPayoutId: "pout_1",
      ...staged,
    });
    expect(row("consultantEarnings", "e_A")).toMatchObject({
      status: "BATCHED",
      payoutId: "po_A",
    });
    expect(catchUpReports()).toHaveLength(1);
  });

  it("still plans a re-armed payout whose first attempt stopped before staging", async () => {
    seed({ priorAmountPaise: 0, priorGrossPaise: 49_000_000 });
    // Claimed, then the function was killed before the TDS was staged.
    Object.assign(row("consultantPayout", "po_A"), { status: "PROCESSING" });
    await stuckJobReArms();

    await processApprovedPayouts();

    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0].amount).toBe(1_549_000);
    expect(stagedFields("po_A")).toMatchObject({
      netAmount: 1_549_000,
      tdsDeducted: 51_000,
      tdsCatchUpFy: FY,
    });
  });

  it("fails the payout before any resend when a refund cascaded between attempts", async () => {
    seed({ priorAmountPaise: 0, priorGrossPaise: 47_000_000 });
    await firstSubmitTimesOut();
    await stuckJobReArms();
    row("consultantEarnings", "e_A").refundedShareAmount = 400_000;

    const results = await processApprovedPayouts();

    expect(gateway.requests).toHaveLength(1);
    expect(results).toEqual([
      expect.objectContaining({
        payoutId: "po_A",
        success: false,
        error: expect.stringContaining("SHORTFALL_BEFORE_DISBURSEMENT"),
      }),
    ]);
    expect(row("consultantPayout", "po_A")).toMatchObject({
      status: "FAILED",
      netAmount: null,
      tdsCatchUpFy: null,
    });
    expect(row("consultantEarnings", "e_A")).toMatchObject({
      status: "READY",
      payoutId: null,
      releasedFromPayoutId: "po_A",
    });
  });

  it("books the staged TDS when the resent payout completes, even after the PAN was verified in between", async () => {
    // Unverified PAN: 5% of the ₹20,000 gross is withheld, ₹15,000 is sent.
    seed({
      priorAmountPaise: 0,
      priorGrossPaise: 49_000_000,
      panVerified: false,
    });
    await firstSubmitTimesOut();
    expect(stagedFields("po_A")).toMatchObject({
      netAmount: 1_500_000,
      tdsDeducted: 100_000,
      tdsRateAppliedBps: 500,
    });
    row("consultantTaxInfo", "ti_1").panVerified = true;
    await stuckJobReArms();
    await processApprovedPayouts();
    expect(gateway.requests[1]).toEqual(gateway.requests[0]);

    await handlePayoutWebhook(
      PaymentGateway.RAZORPAY,
      "pout_1",
      "COMPLETED",
      undefined,
      "UTR123",
      "po_A",
    );

    expect(row("consultantPayout", "po_A")).toMatchObject({
      status: "COMPLETED",
      netAmount: 1_500_000,
      tdsDeducted: 100_000,
    });
    expect(db.__tables.tDSRecord.filter((r) => r.payoutId === "po_A")).toEqual([
      expect.objectContaining({
        consultantProfileId: "cp_1",
        tdsDeducted: 100_000,
        tdsRateBps: 500,
        tdsSection: "194O",
      }),
    ]);
    const completion = jest
      .mocked(postLedgerTxn)
      .mock.calls.map(([, txn]) => txn)
      .filter((txn) => txn.idempotencyKey === "payout:po_A");
    expect(completion).toHaveLength(1);
    expect(completion[0].postings).toEqual(
      buildPayoutCompletionPostings({
        payableAccount: {
          kind: "CONSULTANT_PAYABLE",
          consultantProfileId: "cp_1",
        },
        grossPayablePaise: 1_600_000,
        netCashPaise: 1_500_000,
        tdsPaise: 100_000,
      }),
    );
  });
  /** An instant payout of ₹20,000 gross, minted while A waits re-armed and sent at once. */
  async function instantPayoutWhileWaiting() {
    db.__tables.consultantPayout.push(
      payoutRow({
        id: "po_B",
        status: "APPROVED",
        amount: 1_600_000,
        kind: "INSTANT",
        idempotencyKey: "instant_cp_1_today",
      }),
    );
    db.__tables.consultantEarnings.push(
      earningRow({
        id: "e_B",
        payoutId: "po_B",
        status: "BATCHED",
        grossAmount: 2_000_000,
        consultantSharePaise: 1_600_000,
      }),
    );
    await processPayoutById("po_B");
  }

  it("counts a staged retry when planning a payout made while it waits, so the year's catch-up is withheld once", async () => {
    // ₹4,70,000 before: A stages no TDS at ₹4,90,000.
    seed({ priorAmountPaise: 0, priorGrossPaise: 47_000_000 });
    await firstSubmitTimesOut();
    await stuckJobReArms();

    await instantPayoutWhileWaiting();
    // B sees A, so the year is ₹5,10,000 and B withholds the ₹510 catch-up.
    expect(gateway.requests[1]).toMatchObject({
      referenceId: "po_B",
      amount: 1_549_000,
    });
    expect(stagedFields("po_B")).toMatchObject({
      tdsDeducted: 51_000,
      tdsCatchUpFy: FY,
    });

    await processApprovedPayouts();
    expect(gateway.requests[2]).toEqual(gateway.requests[0]);
    expect(row("consultantPayout", "po_A").status).toBe("PROCESSING");
  });

  it("counts a staged retry's TDS credit when planning a payout made while it waits, so the credit is paid once", async () => {
    // ₹600 already withheld this FY against ₹510 due: A stages a ₹90 credit.
    seed({ priorAmountPaise: 0, priorGrossPaise: 49_000_000 });
    Object.assign(row("consultantPayout", "po_prior"), {
      tdsDeducted: 60_000,
      tdsRateAppliedBps: 10,
    });
    await firstSubmitTimesOut();
    expect(stagedFields("po_A")).toMatchObject({
      netAmount: 1_609_000,
      tdsCreditPaise: 9_000,
    });
    await stuckJobReArms();

    await instantPayoutWhileWaiting();
    // The year is ₹5,30,000 (₹530 due) and ₹510 is assigned net of A's credit: B withholds ₹20.
    expect(gateway.requests[1]).toMatchObject({
      referenceId: "po_B",
      amount: 1_598_000,
    });
    expect(stagedFields("po_B")).toMatchObject({
      tdsDeducted: 2_000,
      tdsCreditPaise: 0,
    });
  });

  it("does not resend a staged retry whose original transfer completed after the claim", async () => {
    seed({ priorAmountPaise: 0, priorGrossPaise: 47_000_000 });
    await firstSubmitTimesOut();
    await stuckJobReArms();
    // The original's delayed webhook lands while the retry reads the tax info after claiming.
    db.__beforeRead.consultantTaxInfo = () =>
      handlePayoutWebhook(
        PaymentGateway.RAZORPAY,
        "pout_1",
        "COMPLETED",
        undefined,
        "UTR123",
        "po_A",
      );

    const results = await processApprovedPayouts();

    expect(gateway.requests).toHaveLength(1);
    expect(results).toEqual([
      expect.objectContaining({ payoutId: "po_A", skipped: true }),
    ]);
    expect(row("consultantPayout", "po_A")).toMatchObject({
      status: "COMPLETED",
      providerPayoutId: "pout_1",
      netAmount: 1_600_000,
    });
  });
  /** Books the completion of po_A and returns its TDS records and its completion journal. */
  async function completeA() {
    await handlePayoutWebhook(
      PaymentGateway.RAZORPAY,
      "pout_1",
      "COMPLETED",
      undefined,
      "UTR123",
      "po_A",
    );
    const journal = jest
      .mocked(postLedgerTxn)
      .mock.calls.map(([, txn]) => txn)
      .filter((txn) => txn.idempotencyKey === "payout:po_A");
    return {
      records: db.__tables.tDSRecord.filter((r) => r.payoutId === "po_A"),
      journal,
    };
  }
  const completionPostings = (cash: number, tds: number) =>
    buildPayoutCompletionPostings({
      payableAccount: {
        kind: "CONSULTANT_PAYABLE",
        consultantProfileId: "cp_1",
      },
      grossPayablePaise: 1_600_000,
      netCashPaise: cash,
      tdsPaise: tds,
    });

  it("records the found payout and sends nothing when a fresh lookup after the catch-up collision finds it, then books its completion", async () => {
    await catchUpTakenWhileWaiting();
    gateway.list = "current";

    const results = await processApprovedPayouts();

    expect(gateway.requests).toHaveLength(1);
    expect(results).toEqual([
      expect.objectContaining({
        payoutId: "po_A",
        skipped: true,
        providerPayoutId: "pout_1",
      }),
    ]);
    // PROCESSING with a gateway id, the state the webhook and both reconcilers read;
    // the catch-up flag is dropped so the completion clears the index.
    expect(row("consultantPayout", "po_A")).toMatchObject({
      status: "PROCESSING",
      providerPayoutId: "pout_1",
      netAmount: 1_549_000,
      tdsDeducted: 51_000,
      tdsCatchUpFy: null,
    });
    expect(row("consultantEarnings", "e_A")).toMatchObject({
      status: "BATCHED",
      payoutId: "po_A",
    });

    const { records, journal } = await completeA();
    expect(row("consultantPayout", "po_A").status).toBe("COMPLETED");
    expect(records).toEqual([
      expect.objectContaining({ tdsDeducted: 51_000, tdsRateBps: 10 }),
    ]);
    expect(journal[0].postings).toEqual(completionPostings(1_549_000, 51_000));
  });

  it("changes nothing and reports once when the fresh lookup after the catch-up collision fails", async () => {
    const staged = await catchUpTakenWhileWaiting();
    gateway.list = "error";

    const results = await processApprovedPayouts();

    expect(gateway.requests).toHaveLength(1);
    expect(results).toEqual([
      expect.objectContaining({ payoutId: "po_A", skipped: true }),
    ]);
    expect(row("consultantPayout", "po_A")).toMatchObject({
      status: "APPROVED",
      providerPayoutId: null,
      ...staged,
    });
    expect(row("consultantEarnings", "e_A")).toMatchObject({
      status: "BATCHED",
      payoutId: "po_A",
    });
    expect(catchUpReports()).toHaveLength(1);
  });

  describe("a staged retry that crosses into a new financial year", () => {
    const MARCH = new Date("2027-03-30T12:00:00+05:30");
    const APRIL = new Date("2027-04-03T12:00:00+05:30");
    const yearReports = () =>
      jest
        .mocked(reportSentryError)
        .mock.calls.filter(
          ([, opts]) => opts?.op === "payout-retry-crossed-financial-year",
        );

    beforeEach(() => {
      jest.useFakeTimers({
        now: MARCH,
        doNotFake: [
          "hrtime",
          "nextTick",
          "performance",
          "queueMicrotask",
          "requestAnimationFrame",
          "cancelAnimationFrame",
          "requestIdleCallback",
          "cancelIdleCallback",
          "setImmediate",
          "clearImmediate",
          "setInterval",
          "clearInterval",
          "setTimeout",
          "clearTimeout",
        ],
      });
    });
    afterEach(() => jest.useRealTimers());

    it("fails unsent on a fresh none and is re-planned in the new year by the next batch", async () => {
      seed({ priorAmountPaise: 0, priorGrossPaise: 47_000_000 });
      await firstSubmitTimesOut();
      expect(stagedFields("po_A")).toMatchObject({
        tdsFinancialYear: "2026-27",
        netAmount: 1_600_000,
      });
      jest.setSystemTime(APRIL);
      // ₹4,90,000 already paid in the new year, so A's ₹20,000 crosses its ₹5L.
      completedPayout("po_apr", {
        amount: 39_200_000,
        grossPaise: 49_000_000,
        tdsFinancialYear: "2027-28",
      });
      await stuckJobReArms();

      const results = await processApprovedPayouts();

      expect(gateway.requests).toHaveLength(1);
      expect(results).toEqual([
        expect.objectContaining({
          payoutId: "po_A",
          success: false,
          error: expect.stringContaining("TDS_FY_CROSSED"),
        }),
      ]);
      expect(row("consultantPayout", "po_A")).toMatchObject({
        status: "FAILED",
        failureReason: expect.stringContaining("TDS_FY_CROSSED"),
        netAmount: null,
        tdsFinancialYear: null,
      });
      expect(row("consultantEarnings", "e_A")).toMatchObject({
        status: "READY",
        payoutId: null,
      });
      expect(yearReports()).toHaveLength(1);

      await createPayoutBatch(["cp_1"]);
      const next = db.__tables.consultantPayout.find(
        (p) => p.status === "PENDING",
      );
      await approvePayout(String(next?.id), "admin_1");
      await processApprovedPayouts();

      // The new year's ₹5,10,000 takes the whole-year 0.1% catch-up: ₹510.
      expect(gateway.requests[1]).toMatchObject({
        referenceId: next?.id,
        amount: 1_549_000,
      });
      expect(stagedFields(String(next?.id))).toMatchObject({
        tdsFinancialYear: "2027-28",
        tdsDeducted: 51_000,
        tdsCatchUpFy: "2027-28",
      });
    });

    it("records a payout the fresh lookup finds, sends nothing, and books its staged TDS on completion", async () => {
      seed({ priorAmountPaise: 0, priorGrossPaise: 49_000_000 });
      await firstSubmitTimesOut();
      expect(stagedFields("po_A")).toMatchObject({
        tdsFinancialYear: "2026-27",
        tdsDeducted: 51_000,
        tdsCatchUpFy: "2026-27",
      });
      jest.setSystemTime(APRIL);
      await stuckJobReArms();
      gateway.list = "current";

      const results = await processApprovedPayouts();

      expect(gateway.requests).toHaveLength(1);
      expect(results).toEqual([
        expect.objectContaining({
          payoutId: "po_A",
          skipped: true,
          providerPayoutId: "pout_1",
        }),
      ]);
      expect(row("consultantPayout", "po_A")).toMatchObject({
        status: "PROCESSING",
        providerPayoutId: "pout_1",
        tdsFinancialYear: "2026-27",
        tdsCatchUpFy: "2026-27",
        netAmount: 1_549_000,
      });

      const { records, journal } = await completeA();
      expect(row("consultantPayout", "po_A").status).toBe("COMPLETED");
      expect(records).toEqual([
        expect.objectContaining({ tdsDeducted: 51_000, tdsRateBps: 10 }),
      ]);
      expect(journal[0].postings).toEqual(
        completionPostings(1_549_000, 51_000),
      );
    });
  });
});
