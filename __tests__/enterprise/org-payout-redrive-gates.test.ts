/**
 * @jest-environment node
 */

/**
 * Organisation payouts are sent only by processOrgPayout, after every gate. The
 * re-drive reconciles: a stale PROCESSING payout the gateway confirms it never
 * received goes back to APPROVED. Before its claim, processOrgPayout fails a
 * payout whose account check refuses and holds one the balance cannot cover, so
 * neither sits PROCESSING with nothing sent, and the run reports each once.
 */

import {
  DISPUTE_GATED_PAYMENT_WHERE,
  REFUND_GATED_PAYMENT_WHERE,
} from "../../lib/payments/payouts/shared-lifecycle";
import { PAYOUT_ACCOUNT_COOLING_OFF_MS } from "../../lib/payments/payouts/payout-requirements";
import { sanitizePayoutFailure } from "../../lib/dashboard/earnings-state";

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

/** Enough of Prisma's WHERE to drive the rows below. */
function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v === null) return (row[k] ?? null) === null;
    if (v && typeof v === "object" && !(v instanceof Date)) {
      const op = v as { in?: unknown[]; lt?: Date };
      if (op.in) return op.in.includes(row[k]);
      if (op.lt) return (row[k] as Date) < op.lt;
      throw new Error(`matches: unsupported filter on ${k}`);
    }
    return row[k] === v;
  });
}

/** A Prisma double whose unstubbed members throw instead of reading undefined. */
function strict<T extends object>(name: string, target: T): T {
  return new Proxy(target, {
    get(obj, key, receiver) {
      if (typeof key !== "symbol" && key !== "then" && !(key in obj)) {
        throw new Error(`${name}.${String(key)} is not stubbed`);
      }
      return Reflect.get(obj, key, receiver);
    },
  });
}

let mockPayouts: Row[];
let mockEarnings: Row[];
let mockDisputedPayments: Set<string>;
/** Every status each payout has held, in order. */
let mockStatusTrail: Record<string, string[]>;

const byId = (id: unknown) => {
  const row = mockPayouts.find((p) => p.id === id);
  if (!row) throw new Error(`no payout ${String(id)}`);
  return row;
};
const write = (row: Row, data: Row) => {
  Object.assign(row, data, { updatedAt: new Date() });
  if (typeof data.status === "string") {
    mockStatusTrail[row.id as string].push(data.status);
  }
};
const mockDb = strict("prisma", {
  organizationPayout: strict("prisma.organizationPayout", {
    findMany: jest.fn(async ({ where }: { where: Where }) =>
      mockPayouts.filter((r) => matches(r, where)),
    ),
    findUnique: jest.fn(async ({ where }: { where: Where }) => byId(where.id)),
    findUniqueOrThrow: jest.fn(async ({ where }: { where: Where }) =>
      byId(where.id),
    ),
    updateMany: jest.fn(
      async ({ where, data }: { where: Where; data: Row }) => {
        const rows = mockPayouts.filter((r) => matches(r, where));
        for (const r of rows) write(r, data);
        return { count: rows.length };
      },
    ),
    update: jest.fn(async ({ where, data }: { where: Where; data: Row }) => {
      const row = byId(where.id);
      write(row, data);
      return row;
    }),
  }),
  organizationEarnings: strict("prisma.organizationEarnings", {
    findFirst: jest.fn(
      async ({
        where,
      }: {
        where: { orgPayoutId: string; payment: unknown };
      }) => {
        const batch = mockEarnings.filter(
          (e) => e.orgPayoutId === where.orgPayoutId,
        );
        if (where.payment === DISPUTE_GATED_PAYMENT_WHERE) {
          return (
            batch.find((e) =>
              mockDisputedPayments.has(e.paymentId as string),
            ) ?? null
          );
        }
        if (where.payment === REFUND_GATED_PAYMENT_WHERE) return null;
        throw new Error("organizationEarnings.findFirst: unmodelled predicate");
      },
    ),
    aggregate: jest.fn(async ({ where }: { where: Where }) => {
      const rows = mockEarnings.filter((e) => matches(e, where));
      const sum = (k: string) => rows.reduce((s, e) => s + (e[k] as number), 0);
      return {
        _sum: {
          orgSharePaise: sum("orgSharePaise"),
          refundedAmountPaise: sum("refundedAmountPaise"),
        },
      };
    }),
    updateMany: jest.fn(
      async ({ where, data }: { where: Where; data: Row }) => {
        const rows = mockEarnings.filter((e) => matches(e, where));
        for (const e of rows) Object.assign(e, data);
        return { count: rows.length };
      },
    ),
  }),
  // The fail-and-release path drops the payout's TDS rows and emails the roster.
  tDSRecord: strict("prisma.tDSRecord", {
    deleteMany: jest.fn(async () => ({ count: 0 })),
  }),
  membership: strict("prisma.membership", {
    findMany: jest.fn(async () => []),
  }),
  user: strict("prisma.user", {}),
  failedEmail: strict("prisma.failedEmail", {}),
  orgAuditLog: strict("prisma.orgAuditLog", {
    create: jest.fn(async () => ({})),
  }),
  $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(mockDb)),
});

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  get default() {
    return mockDb;
  },
}));
jest.mock("../../lib/feature-flags", () => ({
  ...jest.requireActual("../../lib/feature-flags"),
  ENABLE_LIVE_PAYOUTS: true,
}));
const reportSentryError = jest.fn();
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: (...a: unknown[]) => reportSentryError(...a),
  reportSentryMessage: jest.fn(),
}));
const recordSystemErrorSafe = jest.fn(async () => undefined);
jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemErrorSafe: (...a: unknown[]) => recordSystemErrorSafe(...a),
  recordSystemEventSafe: jest.fn(async () => undefined),
}));
jest.mock("../../lib/novu/org-workflows", () => ({
  VISIBILITY_ROLES: ["OWNER", "ADMIN"],
  rosterForOrg: jest.fn(async () => []),
  notifyOrgPayoutCompleted: jest.fn(),
  notifyOrgPayoutFailed: jest.fn(async () => []),
}));
jest.mock("../../lib/email", () => ({
  sendOrgPayoutFailedEmail: jest.fn(async () => undefined),
}));
jest.mock("../../lib/enterprise/outbound-webhooks/dispatch", () => ({
  dispatchWebhookEvent: jest.fn(async () => undefined),
}));
jest.mock("../../lib/payments/payouts/clawback-recovery", () => ({
  ...jest.requireActual("../../lib/payments/payouts/clawback-recovery"),
  releaseClawbackRecovery: jest.fn(async () => undefined),
}));
const listPayouts = jest.fn();
const createPayout = jest.fn();
const getAccountBalance = jest.fn();
jest.mock("../../lib/payments/payouts/razorpay-payouts", () => ({
  ...jest.requireActual("../../lib/payments/payouts/razorpay-payouts"),
  isRazorpayPayoutsConfigured: () => true,
  getRazorpayPayoutsService: () => ({
    listPayouts: (...a: unknown[]) => listPayouts(...a),
    createPayout: (...a: unknown[]) => createPayout(...a),
    getAccountBalance: (...a: unknown[]) => getAccountBalance(...a),
    generateIdempotencyKey: (id: string) => `idem_${id}`,
    determinePayoutMode: () => "IMPS",
  }),
}));

import {
  processOrgPayout,
  processPendingOrgPayouts,
} from "../../lib/payments/payouts/org-payout-service";

const HOUR = 60 * 60 * 1000;

/** ₹40,000 of organisation share in two ₹20,000 earnings. */
function addPayout(id: string, over: Row = {}): Row {
  const row: Row = {
    id,
    organizationId: "org_1",
    organization: { name: "Acme" },
    status: "APPROVED",
    gatewayPayoutId: null,
    amountPaise: 4_000_000,
    netPayoutPaise: 4_000_000,
    currency: "INR",
    paymentGateway: "RAZORPAY",
    payoutReference: null,
    platformHeldAt: null,
    approvedBy: "admin_1",
    orgApprovedBy: "user_owner",
    failureReason: null,
    createdAt: new Date(Date.now() - 24 * HOUR),
    updatedAt: new Date(),
    orgPayoutAccount: {
      status: "VERIFIED",
      razorpayFundAccountId: "fa_org",
      payoutsAllowedAfter: null,
      payoutsFrozenAt: null,
    },
    ...over,
  };
  mockPayouts.push(row);
  mockStatusTrail[id] = [row.status as string];
  for (const n of [1, 2]) {
    mockEarnings.push({
      id: `${id}_oe_${n}`,
      orgPayoutId: id,
      paymentId: `${id}_pay_${n}`,
      status: "BATCHED",
      orgSharePaise: 2_000_000,
      refundedAmountPaise: 0,
    });
  }
  return row;
}
const earningsOf = (id: string) =>
  mockEarnings.filter((e) => e.id.toString().startsWith(`${id}_`));

beforeEach(() => {
  process.env.ENABLE_LIVE_PAYOUTS = "true";
  mockPayouts = [];
  mockEarnings = [];
  mockStatusTrail = {};
  mockDisputedPayments = new Set();
  getAccountBalance.mockResolvedValue(100_000_000);
  listPayouts.mockResolvedValue({ entity: "collection", items: [] });
  createPayout.mockResolvedValue({ id: "pout_1", status: "queued" });
});

afterAll(() => {
  delete process.env.ENABLE_LIVE_PAYOUTS;
});

describe("the re-drive reconciles and never sends", () => {
  /** Claimed two hours ago; nothing reached the gateway. */
  const stale = () =>
    addPayout("op_1", {
      status: "PROCESSING",
      updatedAt: new Date(Date.now() - 2 * HOUR),
    });

  it("re-arms a stale payout the gateway never received and sends it only on the next pass", async () => {
    const payout = stale();

    await processPendingOrgPayouts();

    expect(createPayout).not.toHaveBeenCalled();
    expect(payout).toMatchObject({ status: "APPROVED", gatewayPayoutId: null });

    await processPendingOrgPayouts();

    expect(createPayout).toHaveBeenCalledTimes(1);
    expect(payout).toMatchObject({
      status: "PROCESSING",
      gatewayPayoutId: "pout_1",
    });
  });

  it.each([
    [
      "live payouts switched off",
      () => {
        delete process.env.ENABLE_LIVE_PAYOUTS;
      },
      "APPROVED",
    ],
    [
      "an open dispute on one of its payments",
      () => {
        mockDisputedPayments.add("op_1_pay_2");
      },
      "APPROVED",
    ],
    [
      "a platform hold",
      (p: Row) => {
        p.platformHeldAt = new Date();
      },
      "APPROVED",
    ],
    [
      "a refund that left the batch short",
      () => {
        mockEarnings[0].refundedAmountPaise = 500_000;
      },
      "FAILED",
    ],
  ])(
    "never sends a stale payout past %s, on the re-drive or the pass after it",
    async (_label, arrange: (p: Row) => void, settled) => {
      const payout = stale();
      arrange(payout);

      await processPendingOrgPayouts();
      expect(payout.status).toBe("APPROVED");
      await processPendingOrgPayouts();

      expect(createPayout).not.toHaveBeenCalled();
      expect(payout.status).toBe(settled);
    },
  );
});

describe("before the claim, a refusing account check fails the payout", () => {
  it.each([
    [
      "frozen",
      { payoutsFrozenAt: new Date() },
      "PAYOUT_ACCOUNT_PAYOUTS_FROZEN",
    ],
    [
      "unverified",
      { status: "PENDING_VERIFICATION" },
      "PAYOUT_ACCOUNT_NOT_VERIFIED",
    ],
    [
      "changed after mint",
      {
        payoutsAllowedAfter: new Date(
          Date.now() - 2 * HOUR + PAYOUT_ACCOUNT_COOLING_OFF_MS,
        ),
      },
      "PAYOUT_ACCOUNT_CHANGED",
    ],
    [
      "missing a fund account",
      { razorpayFundAccountId: null },
      "PAYOUT_ACCOUNT_NO_FUND_ACCOUNT",
    ],
  ])(
    "an account %s ends FAILED with its earnings READY, never PROCESSING",
    async (_label, account, code) => {
      const payout = addPayout("op_1");
      Object.assign(payout.orgPayoutAccount as Row, account);

      const out = await processOrgPayout("op_1");

      expect(out).toMatchObject({ status: "FAILED", claimed: false });
      expect(payout.failureReason).toEqual(expect.stringContaining(code));
      expect(mockStatusTrail.op_1).toEqual(["APPROVED", "FAILED"]);
      expect(earningsOf("op_1")).toEqual([
        expect.objectContaining({ status: "READY", orgPayoutId: null }),
        expect.objectContaining({ status: "READY", orgPayoutId: null }),
      ]);
      expect(createPayout).not.toHaveBeenCalled();
      // The organisation is told the existing generic line, not a bank-details mismatch.
      expect(sanitizePayoutFailure(payout.failureReason as string)).toBe(
        "we couldn't send this payout",
      );
    },
  );

  it("leaves nothing for the hourly re-drive to re-arm", async () => {
    const payout = addPayout("op_1");
    (payout.orgPayoutAccount as Row).payoutsFrozenAt = new Date();

    await processPendingOrgPayouts();
    payout.updatedAt = new Date(Date.now() - 2 * HOUR);
    await processPendingOrgPayouts();

    expect(payout.status).toBe("FAILED");
    expect(listPayouts).not.toHaveBeenCalled();
    expect(mockStatusTrail.op_1).toEqual(["APPROVED", "FAILED"]);
  });
});

describe("one report per run, however many payouts", () => {
  it("two refused payouts produce one report", async () => {
    for (const id of ["op_1", "op_2"]) {
      (addPayout(id).orgPayoutAccount as Row).payoutsFrozenAt = new Date();
    }

    await processPendingOrgPayouts();

    expect(mockPayouts.map((p) => p.status)).toEqual(["FAILED", "FAILED"]);
    expect(reportSentryError).toHaveBeenCalledTimes(1);
    expect(reportSentryError.mock.calls[0][1]).toMatchObject({
      extra: { count: 2 },
    });
  });

  it.each([
    [
      "short",
      1_000_000,
      ["APPROVED", "APPROVED"],
      "RAZORPAYX_BALANCE_INSUFFICIENT",
    ],
    [
      "unknown",
      null,
      ["PROCESSING", "PROCESSING"],
      "RAZORPAYX_BALANCE_UNKNOWN",
    ],
  ])(
    "a %s balance on two payouts produces one report",
    async (_label, balance, statuses, summary) => {
      addPayout("op_1");
      addPayout("op_2");
      getAccountBalance.mockResolvedValue(balance);

      await processPendingOrgPayouts();

      expect(mockPayouts.map((p) => p.status)).toEqual(statuses);
      expect(createPayout).toHaveBeenCalledTimes(balance === null ? 2 : 0);
      expect(recordSystemErrorSafe).toHaveBeenCalledTimes(1);
      expect(recordSystemErrorSafe.mock.calls[0][0]).toMatchObject({
        summary: expect.stringContaining(summary),
      });
    },
  );
});
