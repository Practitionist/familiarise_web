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
import { AUDIT_ACTIONS } from "../../lib/enterprise/audit-actions";

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

/** Enough of Prisma's WHERE to drive the rows below. */
function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v === null) return (row[k] ?? null) === null;
    if (v instanceof Date) return (row[k] as Date)?.getTime() === v.getTime();
    if (v && typeof v === "object") {
      const op = v as { in?: unknown[]; lt?: Date; not?: unknown };
      if (op.in) return op.in.includes(row[k]);
      if ("not" in op) return (row[k] ?? null) !== op.not;
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
type OrderBy = Record<string, "asc" | "desc">;
/** Prisma's orderBy over Date columns, then `take`. */
function ordered(rows: Row[], orderBy?: OrderBy | OrderBy[], take?: number) {
  const keys = orderBy ? (Array.isArray(orderBy) ? orderBy : [orderBy]) : [];
  const sorted = [...rows].sort((a, b) => {
    for (const o of keys) {
      const [k, dir] = Object.entries(o)[0];
      const d = (a[k] as Date).getTime() - (b[k] as Date).getTime();
      if (d !== 0) return dir === "desc" ? -d : d;
    }
    return 0;
  });
  return take === undefined ? sorted : sorted.slice(0, take);
}
const mockAuditCreate = jest.fn(async (_a: { data: Row }) => ({}));
const mockDb = strict("prisma", {
  organizationPayout: strict("prisma.organizationPayout", {
    // Copies, as Prisma returns: a later write never changes what a reader saw.
    findMany: jest.fn(
      async (a: {
        where: Where;
        orderBy?: OrderBy | OrderBy[];
        take?: number;
      }) =>
        ordered(
          mockPayouts.filter((r) => matches(r, a.where)),
          a.orderBy,
          a.take,
        ).map((r) => ({ ...r })),
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
    create: (a: { data: Row }) => mockAuditCreate(a),
  }),
  $transaction: jest.fn(
    async (fn: (tx: unknown) => unknown): Promise<unknown> => fn(mockDb),
  ),
});

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  get default(): unknown {
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
const recordSystemErrorSafe = jest.fn(async (..._a: unknown[]) => undefined);
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
import { RazorpayXHttpError } from "../../lib/payments/payouts/razorpay-payouts";

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
  mockEarnings.filter((e) => String(e.id).startsWith(`${id}_`));

beforeEach(() => {
  process.env.ENABLE_LIVE_PAYOUTS = "true";
  mockPayouts = [];
  mockEarnings = [];
  mockStatusTrail = {};
  mockDisputedPayments = new Set();
  getAccountBalance.mockResolvedValue(100_000_000);
  listPayouts.mockResolvedValue({ entity: "collection", items: [] });
  createPayout.mockResolvedValue({ id: "pout_1", status: "queued" });
  mockAuditCreate.mockImplementation(async () => ({}));
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

  it("does not pull back a newer claim that landed while its lookup was out", async () => {
    const payout = stale();
    listPayouts.mockImplementation(async () => {
      // Another pass re-armed and claimed it again; its create is accepted but not yet bound.
      write(payout, { status: "APPROVED" });
      write(payout, { status: "PROCESSING" });
      return { entity: "collection", items: [] };
    });

    await processPendingOrgPayouts();

    expect(payout).toMatchObject({
      status: "PROCESSING",
      gatewayPayoutId: null,
    });
    expect(mockStatusTrail.op_1).toEqual([
      "PROCESSING",
      "APPROVED",
      "PROCESSING",
    ]);
  });
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

  it.each([
    [
      "a freeze",
      (a: Row) => {
        a.payoutsFrozenAt = new Date();
      },
    ],
    [
      "a suspension",
      (a: Row) => {
        a.status = "SUSPENDED";
      },
    ],
    [
      "an account change",
      (a: Row) => {
        a.payoutsAllowedAfter = new Date(
          Date.now() + PAYOUT_ACCOUNT_COOLING_OFF_MS,
        );
      },
    ],
  ])(
    "%s landing after the first read, during the balance read, still stops the claim",
    async (_label, change) => {
      const payout = addPayout("op_1");
      getAccountBalance.mockImplementation(async () => {
        change(payout.orgPayoutAccount as Row);
        return 100_000_000;
      });

      const out = await processOrgPayout("op_1");

      expect(out).toMatchObject({ status: "FAILED", claimed: false });
      expect(mockStatusTrail.op_1).toEqual(["APPROVED", "FAILED"]);
      expect(earningsOf("op_1").map((e) => e.status)).toEqual([
        "READY",
        "READY",
      ]);
      expect(createPayout).not.toHaveBeenCalled();
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

const changes: Array<[string, (a: Row) => void]> = [
  [
    "a freeze",
    (a) => {
      a.payoutsFrozenAt = new Date();
    },
  ],
  [
    "a suspension",
    (a) => {
      a.status = "SUSPENDED";
    },
  ],
  [
    "an account change",
    (a) => {
      a.payoutsAllowedAfter = new Date(
        Date.now() + PAYOUT_ACCOUNT_COOLING_OFF_MS,
      );
    },
  ],
];

describe("a destination change after the claim transaction read the account", () => {
  it.each(changes)(
    "%s committing before the send fails the claimed payout, sends nothing and is reported once",
    async (_label, change) => {
      const payout = addPayout("op_1");
      // Lands at the claim transaction's last write, after its account read.
      mockAuditCreate.mockImplementation(async ({ data }) => {
        if (data.action === AUDIT_ACTIONS.PAYOUT.PAYOUT_PROCESSED) {
          change(payout.orgPayoutAccount as Row);
        }
        return {};
      });

      await processPendingOrgPayouts();

      expect(createPayout).not.toHaveBeenCalled();
      expect(mockStatusTrail.op_1).toEqual([
        "APPROVED",
        "PROCESSING",
        "FAILED",
      ]);
      expect(earningsOf("op_1").map((e) => [e.status, e.orgPayoutId])).toEqual([
        ["READY", null],
        ["READY", null],
      ]);
      expect(reportSentryError).toHaveBeenCalledTimes(1);
    },
  );
});

describe("an approved payout already bound to a gateway payout", () => {
  it.each([
    ["a frozen account", { payoutsFrozenAt: new Date() }],
    ["an allowed account", {}],
  ])(
    "with %s goes to reconciliation: no release and no new send",
    async (_label, account) => {
      const payout = addPayout("op_1", { gatewayPayoutId: "pout_late" });
      Object.assign(payout.orgPayoutAccount as Row, account);

      await processPendingOrgPayouts();

      expect(createPayout).not.toHaveBeenCalled();
      expect(payout).toMatchObject({
        status: "PROCESSING",
        gatewayPayoutId: "pout_late",
        failureReason: null,
      });
      expect(earningsOf("op_1").map((e) => [e.status, e.orgPayoutId])).toEqual([
        ["BATCHED", "op_1"],
        ["BATCHED", "op_1"],
      ]);
    },
  );
});

describe("one run, bounded gateway reads and a fair queue", () => {
  it("reads the RazorpayX balance once per run, however many payouts", async () => {
    addPayout("op_1");
    addPayout("op_2");
    addPayout("op_3");
    mockDisputedPayments.add("op_2_pay_1");

    await processPendingOrgPayouts();

    expect(getAccountBalance).toHaveBeenCalledTimes(1);
    expect(createPayout).toHaveBeenCalledTimes(2);
  });

  it("gives a payout never attempted its turn ahead of re-armed retries", async () => {
    const older = new Date(Date.now() - 48 * HOUR);
    for (const n of [1, 2, 3, 4, 5]) {
      // Re-armed just now after a create whose outcome stayed unknown.
      addPayout(`op_r${n}`, { createdAt: older, updatedAt: new Date() });
    }
    const fresh = addPayout("op_new", {
      updatedAt: new Date(Date.now() - 12 * HOUR),
    });
    createPayout.mockImplementation(async ({ referenceId }: Row) => {
      if (referenceId === "op_new") return { id: "pout_new", status: "queued" };
      throw new RazorpayXHttpError(
        "RazorpayX API error (HTTP 503)",
        "SERVER_ERROR",
        503,
      );
    });

    await processPendingOrgPayouts({ limit: 5 });

    expect(fresh).toMatchObject({
      status: "PROCESSING",
      gatewayPayoutId: "pout_new",
    });
  });
});
