/**
 * @jest-environment node
 *
 * The bounded payout reconcilers rotate on `lastReconciledAt`: with a limit of
 * N, repeated runs visit every row of a cohort before revisiting one, a row is
 * stamped only once its poll ends, the stamp is raw SQL that leaves `updatedAt`
 * alone, and the aging predicates are the same 24 h / 48 h-30 d windows as before.
 */

jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: (_name: string, _opts: unknown, fn: () => unknown) => fn(),
  LONG_JOB_TTL_MS: 1000,
}));
jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemEvent: jest.fn(),
  recordSystemError: jest.fn(),
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryMessage: jest.fn(),
}));
jest.mock("../../lib/payments/payouts", () => ({
  applyOrgGatewayStatus: jest.fn(async () => false),
  handlePayoutWebhook: jest.fn(),
  markOrgPayoutFailed: jest.fn(),
  markConsultantPayoutReversed: jest.fn(),
  markOrgPayoutReversed: jest.fn(),
}));
jest.mock("../../lib/payments/payouts/clawback-recovery", () => ({
  releaseClawbackRecovery: jest.fn(),
}));
jest.mock("../../lib/payments/payouts/razorpay-payouts", () => ({
  resolveRazorpayXCredentials: () => ({ keyId: "k", keySecret: "s" }),
}));
jest.mock("../../lib/payments/payouts/payout-gateway-lookup", () => ({
  WEBHOOK_STATUS_MAP: {},
  getRazorpayPayoutStatus: jest.fn(async () => ({
    kind: "status",
    status: "processing",
  })),
  findRazorpayPayoutByReference: jest.fn(),
  mapGatewayStatus: () => "PROCESSING",
  retireUnknownGatewayPayout: jest.fn(),
}));

type Row = {
  id: string;
  status: string;
  updatedAt: Date;
  lastReconciledAt: Date | null;
  [k: string]: unknown;
};
type Where = {
  status?: string | { in: string[] };
  updatedAt?: { lt?: Date; gte?: Date };
};
type FindArgs = {
  where: Where;
  take?: number;
  orderBy: Record<string, unknown>[];
};

const tables: Record<"ConsultantPayout" | "OrganizationPayout", Row[]> = {
  ConsultantPayout: [],
  OrganizationPayout: [],
};
/** Per cohort, the ids each run stamped, indexed by `runNo`. */
const visits: Record<string, string[][]> = {};
let clock = 0;
let runNo = 0;

/** Applies the status filter, then each orderBy key in turn, then `take`. */
function find(rows: Row[], { where, take, orderBy }: FindArgs): Row[] {
  const statusOk = (r: Row) =>
    typeof where.status === "string"
      ? r.status === where.status
      : !where.status || where.status.in.includes(r.status);
  const key = (r: Row, k: string) =>
    r[k] instanceof Date ? (r[k] as Date).getTime() : -1;
  return rows
    .filter(statusOk)
    .sort((a, b) => {
      for (const o of orderBy) {
        const [k, dir] = Object.entries(o)[0];
        const sign = dir === "desc" ? -1 : 1;
        const d = sign * (key(a, k) - key(b, k));
        if (d !== 0) return d;
      }
      return 0;
    })
    .slice(0, take);
}

const db = {
  consultantPayout: {
    findMany: jest.fn(async (a: FindArgs) => find(tables.ConsultantPayout, a)),
  },
  organizationPayout: {
    findMany: jest.fn(async (a: FindArgs) =>
      find(tables.OrganizationPayout, a),
    ),
  },
  $executeRaw: jest.fn(
    async (sql: TemplateStringsArray, ids: string[]): Promise<number> => {
      const table = sql.join("").includes('"OrganizationPayout"')
        ? "OrganizationPayout"
        : "ConsultantPayout";
      clock += 1;
      const batch = tables[table].filter((r) => ids.includes(r.id));
      for (const row of batch) row.lastReconciledAt = new Date(clock);
      if (batch.length > 0) {
        ((visits[`${table}:${batch[0].status}`] ??= [])[runNo] ??= []).push(
          ...ids,
        );
      }
      return ids.length;
    },
  ),
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  get default() {
    return db;
  },
}));

import { handleStuckPayouts } from "../../scripts/payouts/handle-stuck-payouts";
import { reconcilePayoutStatus } from "../../scripts/payouts/reconcile-payout-status";
import { getRazorpayPayoutStatus } from "../../lib/payments/payouts/payout-gateway-lookup";

const NOW = Date.UTC(2026, 9, 20, 12, 0);
const HOUR = 60 * 60 * 1000;

function rows(prefix: string, status: string, n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i}`,
    status,
    updatedAt: new Date(NOW - (100 - i) * HOUR),
    processedAt: new Date(NOW - (100 - i) * HOUR),
    lastReconciledAt: null,
    providerPayoutId: `pout_${prefix}${i}`,
    gatewayPayoutId: `pout_${prefix}${i}`,
    provider: "RAZORPAY",
    retryCount: 0,
    amount: 1000,
    currency: "INR",
    consultantProfile: { user: { name: "A" } },
  }));
}

/** No row is revisited before every row was visited, and every ceil(n/limit) runs cover the cohort. */
function expectFullRotation(runs: string[][], ids: string[], limit: number) {
  expect(new Set(runs.flat().slice(0, ids.length))).toEqual(new Set(ids));
  const span = Math.ceil(ids.length / limit);
  for (let i = 0; i + span <= runs.length; i++) {
    expect(new Set(runs.slice(i, i + span).flat())).toEqual(new Set(ids));
  }
}

beforeEach(() => {
  jest.spyOn(Date, "now").mockReturnValue(NOW);
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  for (const k of Object.keys(visits)) delete visits[k];
  runNo = 0;
  db.consultantPayout.findMany.mockClear();
  db.organizationPayout.findMany.mockClear();
});

it("handle-stuck-payouts visits every stuck row before revisiting one, and keeps the 24 h aging", async () => {
  tables.ConsultantPayout = rows("c", "PROCESSING", 5);
  tables.OrganizationPayout = rows("o", "PROCESSING", 3);
  const before = tables.ConsultantPayout.map((r) => r.updatedAt.getTime());

  for (runNo = 0; runNo < 5; runNo++) await handleStuckPayouts({ limit: 2 });

  expectFullRotation(
    visits["ConsultantPayout:PROCESSING"],
    ["c0", "c1", "c2", "c3", "c4"],
    2,
  );
  expectFullRotation(
    visits["OrganizationPayout:PROCESSING"],
    ["o0", "o1", "o2"],
    2,
  );
  for (const [{ where, take }] of [
    ...db.consultantPayout.findMany.mock.calls,
    ...db.organizationPayout.findMany.mock.calls,
  ]) {
    expect(take).toBe(2);
    expect(where.updatedAt).toEqual({ lt: new Date(NOW - 24 * HOUR) });
  }
  expect(tables.ConsultantPayout.map((r) => r.updatedAt.getTime())).toEqual(
    before,
  );
  for (const [sql] of db.$executeRaw.mock.calls) {
    expect(sql.join("")).not.toContain("updatedAt");
  }
});

it("reconcile-payout-status rotates the stale cohort and both reversal sweeps, and keeps the 48 h-30 d aging", async () => {
  tables.ConsultantPayout = [
    ...rows("s", "PROCESSING", 3),
    ...rows("k", "COMPLETED", 3),
  ];
  tables.OrganizationPayout = rows("g", "COMPLETED", 3);

  for (runNo = 0; runNo < 4; runNo++) {
    await reconcilePayoutStatus({ limit: 2 });
  }

  expectFullRotation(
    visits["ConsultantPayout:PROCESSING"],
    ["s0", "s1", "s2"],
    2,
  );
  expectFullRotation(
    visits["ConsultantPayout:COMPLETED"],
    ["k0", "k1", "k2"],
    2,
  );
  expectFullRotation(
    visits["OrganizationPayout:COMPLETED"],
    ["g0", "g1", "g2"],
    2,
  );
  const stale = db.consultantPayout.findMany.mock.calls.find(
    ([a]) => typeof a.where.status !== "string",
  );
  expect(stale?.[0].where.updatedAt).toEqual({
    lt: new Date(NOW - 48 * HOUR),
    gte: new Date(NOW - 30 * 24 * HOUR),
  });
});

it("a run killed mid-poll stamps only the rows it finished, so the next run starts at the first unfinished row", async () => {
  tables.ConsultantPayout = rows("c", "PROCESSING", 3);
  tables.OrganizationPayout = [];
  jest
    .mocked(getRazorpayPayoutStatus)
    .mockImplementationOnce(async () => ({
      kind: "status",
      status: "processing",
    }))
    .mockImplementationOnce(() => new Promise(() => {}));

  void handleStuckPayouts({ limit: 3 });
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  expect(visits["ConsultantPayout:PROCESSING"]).toEqual([["c0"]]);

  runNo = 1;
  await handleStuckPayouts({ limit: 2 });
  expect(visits["ConsultantPayout:PROCESSING"][1]).toEqual(["c1", "c2"]);
});

it("starts no row once 16 s have passed since startedAt, leaving the rest unstamped", async () => {
  tables.ConsultantPayout = rows("s", "PROCESSING", 3);
  tables.OrganizationPayout = rows("g", "COMPLETED", 2);
  let now = NOW;
  jest.spyOn(Date, "now").mockImplementation(() => now);
  jest.mocked(getRazorpayPayoutStatus).mockImplementation(async () => {
    now += 10_000;
    return { kind: "status", status: "processing" };
  });

  const result = await reconcilePayoutStatus({ limit: 3, startedAt: NOW });

  expect(result.totalProcessed).toBe(2);
  expect(visits["ConsultantPayout:PROCESSING"]).toEqual([["s0", "s1"]]);
  expect(visits["OrganizationPayout:COMPLETED"]).toBeUndefined();
});

it("bounds every cohort at 100 rows when the caller passes no limit", async () => {
  tables.ConsultantPayout = [];
  tables.OrganizationPayout = [];

  await reconcilePayoutStatus();
  await handleStuckPayouts();

  const takes = [
    ...db.consultantPayout.findMany.mock.calls,
    ...db.organizationPayout.findMany.mock.calls,
  ].map(([a]) => a.take);
  expect(takes).toHaveLength(5);
  expect(new Set(takes)).toEqual(new Set([100]));
});

it("one row's thrown poll is recorded, stamped, and never stops the rows or the org pass behind it", async () => {
  tables.ConsultantPayout = rows("e", "PROCESSING", 2);
  tables.OrganizationPayout = rows("f", "PROCESSING", 1);
  jest
    .mocked(getRazorpayPayoutStatus)
    .mockRejectedValueOnce(new Error("gateway down"))
    .mockImplementation(async () => ({ kind: "status", status: "processing" }));

  const result = await handleStuckPayouts({ limit: 2 });

  expect(visits["ConsultantPayout:PROCESSING"]).toEqual([["e0", "e1"]]);
  expect(visits["OrganizationPayout:PROCESSING"]).toEqual([["f0"]]);
  expect(result.success).toBe(false);
  expect(result.errors).toEqual(
    expect.arrayContaining([expect.stringContaining("e0: gateway down")]),
  );
});
