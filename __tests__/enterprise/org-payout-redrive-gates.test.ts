/**
 * @jest-environment node
 */

/**
 * The organisation re-drive reconciles and never sends: a stale PROCESSING
 * payout the gateway confirms it never received goes back to APPROVED, and only
 * the next processOrgPayout pass, with every first-send gate, can submit it. A
 * short balance holds a payout before its claim, so it never sits PROCESSING
 * with nothing sent. One in-memory row; RazorpayX is the faked transport.
 */

import {
  DISPUTE_GATED_PAYMENT_WHERE,
  REFUND_GATED_PAYMENT_WHERE,
} from "../../lib/payments/payouts/shared-lifecycle";

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

let mockPayout: Row;
let mockEarnings: Row[];
let mockDisputedPayments: Set<string>;

const write = (data: Row) => {
  Object.assign(mockPayout, data, { updatedAt: new Date() });
};
const mockDb = strict("prisma", {
  organizationPayout: strict("prisma.organizationPayout", {
    findMany: jest.fn(async ({ where }: { where: Where }) =>
      [mockPayout].filter((r) => matches(r, where)),
    ),
    findUnique: jest.fn(async () => mockPayout),
    findUniqueOrThrow: jest.fn(async () => mockPayout),
    updateMany: jest.fn(
      async ({ where, data }: { where: Where; data: Row }) => {
        if (!matches(mockPayout, where)) return { count: 0 };
        write(data);
        return { count: 1 };
      },
    ),
    update: jest.fn(async ({ data }: { data: Row }) => {
      write(data);
      return mockPayout;
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
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
  reportSentryMessage: jest.fn(),
}));
jest.mock("../../lib/novu/org-workflows", () => ({
  notifyOrgPayoutCompleted: jest.fn(),
  notifyOrgPayoutFailed: jest.fn(async () => []),
}));
const assertPayoutBalance = jest.fn();
jest.mock("../../lib/payments/payouts/balance-preflight", () => ({
  assertPayoutBalance: (...a: unknown[]) => assertPayoutBalance(...a),
}));
jest.mock("../../lib/payments/payouts/clawback-recovery", () => ({
  ...jest.requireActual("../../lib/payments/payouts/clawback-recovery"),
  releaseClawbackRecovery: jest.fn(async () => undefined),
}));
const listPayouts = jest.fn();
const createPayout = jest.fn();
jest.mock("../../lib/payments/payouts/razorpay-payouts", () => ({
  ...jest.requireActual("../../lib/payments/payouts/razorpay-payouts"),
  getRazorpayPayoutsService: () => ({
    listPayouts: (...a: unknown[]) => listPayouts(...a),
    createPayout: (...a: unknown[]) => createPayout(...a),
    generateIdempotencyKey: (id: string) => `idem_${id}`,
    determinePayoutMode: () => "IMPS",
  }),
}));

import { processPendingOrgPayouts } from "../../lib/payments/payouts/org-payout-service";

const HOUR = 60 * 60 * 1000;

beforeEach(() => {
  process.env.ENABLE_LIVE_PAYOUTS = "true";
  // ₹40,000 of organisation share, claimed two hours ago; nothing reached the gateway.
  mockPayout = {
    id: "op_1",
    organizationId: "org_1",
    status: "PROCESSING",
    gatewayPayoutId: null,
    amountPaise: 4_000_000,
    netPayoutPaise: 4_000_000,
    currency: "INR",
    paymentGateway: "RAZORPAY",
    payoutReference: null,
    platformHeldAt: null,
    approvedBy: "admin_1",
    orgApprovedBy: "user_owner",
    createdAt: new Date(Date.now() - 24 * HOUR),
    updatedAt: new Date(Date.now() - 2 * HOUR),
    orgPayoutAccount: {
      status: "VERIFIED",
      razorpayFundAccountId: "fa_org",
      payoutsAllowedAfter: null,
      payoutsFrozenAt: null,
    },
  };
  mockEarnings = ["pay_1", "pay_2"].map((paymentId, i) => ({
    id: `oe_${i}`,
    orgPayoutId: "op_1",
    paymentId,
    status: "BATCHED",
    orgSharePaise: 2_000_000,
    refundedAmountPaise: 0,
  }));
  mockDisputedPayments = new Set();
  assertPayoutBalance.mockResolvedValue({ ok: true, balancePaise: null });
  listPayouts.mockResolvedValue({ entity: "collection", items: [] });
  createPayout.mockResolvedValue({ id: "pout_1", status: "queued" });
});

afterAll(() => {
  delete process.env.ENABLE_LIVE_PAYOUTS;
});

it("re-arms a stale payout the gateway never received and sends it only on the next pass", async () => {
  await processPendingOrgPayouts();

  expect(createPayout).not.toHaveBeenCalled();
  expect(mockPayout).toMatchObject({
    status: "APPROVED",
    gatewayPayoutId: null,
  });

  await processPendingOrgPayouts();

  expect(createPayout).toHaveBeenCalledTimes(1);
  expect(mockPayout).toMatchObject({
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
      mockDisputedPayments.add("pay_2");
    },
    "APPROVED",
  ],
  [
    "a platform hold",
    () => {
      mockPayout.platformHeldAt = new Date();
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
  async (_label, arrange, settled) => {
    arrange();

    await processPendingOrgPayouts();
    expect(mockPayout.status).toBe("APPROVED");
    await processPendingOrgPayouts();

    expect(createPayout).not.toHaveBeenCalled();
    expect(mockPayout.status).toBe(settled);
  },
);

it("holds an approved payout on a short balance without claiming it", async () => {
  mockPayout.status = "APPROVED";
  assertPayoutBalance.mockResolvedValue({
    ok: false,
    balancePaise: 1_000_000,
    reason: "RazorpayX balance 1000000 < required 4000000 paise",
  });

  await processPendingOrgPayouts();

  expect(assertPayoutBalance).toHaveBeenCalledWith(4_000_000);
  expect(createPayout).not.toHaveBeenCalled();
  expect(mockPayout.status).toBe("APPROVED");
});
