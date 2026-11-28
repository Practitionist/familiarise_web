/**
 * @jest-environment node
 */

/**
 * Org payouts under platform control: a large payout needs a Familiarise
 * co-approval by someone other than its maker or org approver, a platform hold
 * parks it, verifying a sponsor releases only that sponsor's trust park, one
 * org's batch failure is counted without aborting the run, and a stuck org
 * payout is re-armed only when the gateway confirms it holds none.
 */

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

/** Enough of Prisma's WHERE to drive one in-memory payout row. */
function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v === null) return (row[k] ?? null) === null;
    if (v && typeof v === "object" && !(v instanceof Date)) {
      const op = v as { in?: unknown[]; not?: unknown; lt?: Date };
      if (op.in) return op.in.includes(row[k]);
      if ("not" in op)
        return op.not === null ? (row[k] ?? null) !== null : true;
      if (op.lt) return (row[k] as Date) < op.lt;
    }
    return row[k] === v;
  });
}

let payout: Row;
let actorId = "admin_1";

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
const reportSentryMessage = jest.fn();
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
  reportSentryMessage: (...a: unknown[]) => reportSentryMessage(...a),
}));
jest.mock("../../lib/auth-helpers", () => ({
  requireBackofficeSurface: jest.fn(async () => ({
    session: {
      user: { id: actorId, role: "ADMIN" },
      session: { createdAt: new Date() },
    },
  })),
  requireOrgAccess: jest.fn(async () => ({
    member: { id: "mem_owner", role: "OWNER" },
    session: {
      user: { id: "user_owner" },
      session: { createdAt: new Date() },
    },
    org: { slug: "acme" },
  })),
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: (_n: string, _o: unknown, fn: () => unknown) => fn(),
  LONG_JOB_TTL_MS: 1000,
}));
jest.mock("../../lib/redis", () => ({
  acquireLock: jest.fn(async () => "tok"),
  releaseLock: jest.fn(async () => undefined),
}));
jest.mock("../../lib/maintenance", () => ({
  getActiveOrgMaintenanceWindow: jest.fn(async () => null),
}));
jest.mock("../../lib/data/public-cache", () => ({
  purgeOrgSurfaces: jest.fn(),
}));
jest.mock("../../lib/compliance/tds", () => ({
  ...jest.requireActual("../../lib/compliance/tds"),
  resolveEffectiveTdsRate: jest.fn(async () => 0.001),
}));
jest.mock("../../lib/payments/payouts/clawback-recovery", () => ({
  ...jest.requireActual("../../lib/payments/payouts/clawback-recovery"),
  recoverClawbackOnPayout: jest.fn(async () => 0),
}));
jest.mock("../../lib/payments/payouts/balance-preflight", () => ({
  assertPayoutBalance: jest.fn(async () => ({ ok: true })),
}));
const createPayout = jest.fn(async () => ({ id: "pout_1" }));
jest.mock("../../lib/payments/payouts/razorpay-payouts", () => ({
  ...jest.requireActual("../../lib/payments/payouts/razorpay-payouts"),
  resolveRazorpayXCredentials: () => ({ keyId: "k", keySecret: "s" }),
  getRazorpayPayoutsService: () => ({
    generateIdempotencyKey: (id: string) => `idem_${id}`,
    determinePayoutMode: () => "IMPS",
    createPayout,
  }),
}));
const findByReference = jest.fn();
jest.mock("../../lib/payments/payouts/payout-gateway-lookup", () => ({
  findRazorpayPayoutByReference: (...a: unknown[]) => findByReference(...a),
  getRazorpayPayoutStatus: jest.fn(),
  mapGatewayStatus: jest.fn(),
  retireUnknownGatewayPayout: jest.fn(),
  WEBHOOK_STATUS_MAP: {},
}));
jest.mock("../../lib/payments/payouts", () => ({
  applyOrgGatewayStatus: jest.fn(),
  handlePayoutWebhook: jest.fn(),
  markOrgPayoutFailed: jest.fn(),
}));

const db = {
  organizationPayout: {
    findFirst: jest.fn(async () => payout),
    findUnique: jest.fn(async (): Promise<Row | null> => payout),
    findUniqueOrThrow: jest.fn(async () => payout),
    findMany: jest.fn(async ({ where }: { where: Where }) =>
      [payout].filter((r) => matches(r, where)),
    ),
    updateMany: jest.fn(
      async ({ where, data }: { where: Where; data: Row }) => {
        if (!matches(payout, where)) return { count: 0 };
        Object.assign(payout, data);
        return { count: 1 };
      },
    ),
    update: jest.fn(async ({ data }: { data: Row }) =>
      Object.assign(payout, data),
    ),
    create: jest.fn(),
  },
  organizationPayoutAccount: { findUnique: jest.fn() },
  organizationEarnings: {
    findFirst: jest.fn(async () => null),
    findMany: jest.fn(),
    groupBy: jest.fn(),
    updateMany: jest.fn(async (_a: { where: Where }) => ({ count: 1 })),
  },
  consultantEarnings: {
    updateMany: jest.fn(async (_a: { where: Where }) => ({ count: 1 })),
  },
  consultantPayout: { findMany: jest.fn(async () => []) },
  platformIncident: { findMany: jest.fn(async () => []) },
  organization: {
    findUnique: jest.fn(),
    findUniqueOrThrow: jest.fn(),
    updateMany: jest.fn(async () => ({ count: 1 })),
  },
  orgAuditLog: {
    create: jest.fn(async () => ({})),
    findFirst: jest.fn(async () => null),
  },
  opsActionLog: {
    create: jest.fn(async (_a: { data: Row }) => ({ id: "ops" })),
  },
  // The second-approval count: one active admin, so the door runs directly.
  user: { count: jest.fn(async () => 1) },
  $transaction: jest.fn(
    async (fn: (tx: unknown) => unknown): Promise<unknown> => fn(db),
  ),
  $disconnect: jest.fn(),
  $executeRaw: jest.fn(async () => 0),
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  get default() {
    return db;
  },
}));

import { NextRequest } from "next/server";
import { PATCH as tenantPatch } from "../../app/api/organizations/[orgId]/payouts/[payoutId]/route";
import { POST as approve } from "../../app/api/admin/org-payouts/[id]/approve/route";
import { POST as hold } from "../../app/api/admin/org-payouts/[id]/hold/route";
import { POST as release } from "../../app/api/admin/org-payouts/[id]/release/route";
import { POST as verifyOrg } from "../../app/api/admin/organizations/[orgId]/verify/route";
import {
  createOrgPayoutBatches,
  processOrgPayout,
} from "../../lib/payments/payouts/org-payout-service";
import { handleStuckPayouts } from "../../scripts/payouts/handle-stuck-payouts";

const req = (body: unknown) =>
  new NextRequest("https://x.test/api", {
    method: "POST",
    body: JSON.stringify(body),
  });
const door = (
  route: (r: NextRequest, c: { params: Promise<unknown> }) => Promise<Response>,
  params: Record<string, string>,
  body: Row = { reason: "checked the bank proof" },
) => route(req(body), { params: Promise.resolve(params) });

beforeEach(() => {
  jest.clearAllMocks();
  actorId = "admin_1";
  process.env.ENABLE_LIVE_PAYOUTS = "true";
  payout = {
    id: "op_1",
    organizationId: "org_1",
    status: "PENDING",
    amountPaise: 6_000_000,
    netPayoutPaise: 6_000_000,
    currency: "INR",
    paymentGateway: "RAZORPAY",
    createdBy: "user_maker",
    orgApprovedBy: null,
    platformApprovalRequiredAt: null,
    platformHeldAt: null,
    createdAt: new Date(Date.now() - 86_400_000),
    updatedAt: new Date(),
    orgPayoutAccount: {
      status: "VERIFIED",
      razorpayFundAccountId: "fa_1",
      payoutsAllowedAfter: null,
      payoutsFrozenAt: null,
    },
  };
  db.organizationPayoutAccount.findUnique.mockResolvedValue({
    payoutsAllowedAfter: null,
  });
});

it("keeps an over-threshold payout PENDING after the org approves, and only a third person co-approves it", async () => {
  const res = await tenantPatch(
    new NextRequest("https://x.test/api", {
      method: "PATCH",
      body: JSON.stringify({ status: "APPROVED" }),
    }),
    { params: Promise.resolve({ orgId: "org_1", payoutId: "op_1" }) },
  );
  expect(res.status).toBe(200);
  expect(payout).toMatchObject({
    status: "PENDING",
    orgApprovedBy: "user_owner",
  });
  expect(payout.platformApprovalRequiredAt).toBeInstanceOf(Date);

  for (const self of ["user_maker", "user_owner"]) {
    actorId = self;
    const refused = await door(approve, { id: "op_1" });
    expect(refused.status).toBe(403);
    expect(payout.status).toBe("PENDING");
  }
  actorId = "admin_1";
  expect((await door(approve, { id: "op_1" })).status).toBe(200);
  expect(payout).toMatchObject({ status: "APPROVED", approvedBy: "admin_1" });
  actorId = "admin_2";
  expect((await door(approve, { id: "op_1" })).status).toBe(409);
  expect(payout.approvedBy).toBe("admin_1");
});

it("a platform hold blocks processing and its release unblocks it", async () => {
  payout.status = "APPROVED";
  expect((await door(hold, { id: "op_1" })).status).toBe(200);
  expect(await processOrgPayout("op_1")).toMatchObject({ claimed: false });
  expect(createPayout).not.toHaveBeenCalled();

  expect((await door(release, { id: "op_1" })).status).toBe(200);
  expect(await processOrgPayout("op_1")).toMatchObject({
    claimed: true,
    submittedToGateway: true,
  });
  expect(createPayout).toHaveBeenCalledTimes(1);
});

it("verifying sponsor X releases only earnings whose payment X sponsored", async () => {
  db.organization.findUnique.mockResolvedValue({
    id: "org_X",
    status: "PENDING_VERIFICATION",
  });
  db.organization.findUniqueOrThrow.mockResolvedValue({
    id: "org_X",
    slug: "x",
  });
  const res = await door(
    verifyOrg,
    { orgId: "org_X" },
    {
      action: "VERIFY",
      reason: "documents reviewed",
    },
  );
  expect(res.status).toBe(200);

  const calls = [
    ...db.organizationEarnings.updateMany.mock.calls,
    ...db.consultantEarnings.updateMany.mock.calls,
  ].map(([arg]) => arg as { where: Where & { payment: Where } });
  expect(calls).toHaveLength(6);
  for (const { where } of calls) {
    expect(where).not.toHaveProperty("organizationId");
    expect(where.payment.organizationId).toBe("org_X");
  }
  expect(db.organizationEarnings.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({ holdUntil: expect.any(Object) }),
      data: { status: "READY" },
    }),
  );
  expect(db.opsActionLog.create.mock.calls[0][0]).toMatchObject({
    data: { action: "organization.verify", targetId: "org_X" },
  });
});

it("counts an org's batch failure once and still batches the next org", async () => {
  db.organizationEarnings.groupBy.mockResolvedValue([
    { organizationId: "org_a", _count: 1, _min: { createdAt: new Date(0) } },
    { organizationId: "org_b", _count: 1, _min: { createdAt: new Date(0) } },
  ]);
  db.organizationPayoutAccount.findUnique.mockImplementation(
    async ({ where }: { where: { organizationId: string } }) => {
      if (where.organizationId === "org_a") throw new Error("db hiccup");
      return { id: "acc_b", status: "VERIFIED" };
    },
  );
  db.organizationPayout.findUnique.mockResolvedValue(null);
  db.organizationPayout.create.mockImplementation(
    async ({ data }: { data: Row }) => ({
      id: "op_b",
      ...data,
    }),
  );
  db.organizationEarnings.findMany.mockResolvedValue([
    {
      id: "oe_b",
      grossAmountPaise: 100_000,
      platformFeePaise: 10_000,
      orgSharePaise: 90_000,
      refundedAmountPaise: 0,
      currency: "INR",
    },
  ]);
  db.organization.findUnique.mockResolvedValue(null);

  const run = await createOrgPayoutBatches({
    periodEnd: new Date(),
    limit: 10,
  });
  expect(run).toMatchObject({ failed: 1, payoutsCreated: 1 });
  expect(reportSentryMessage).toHaveBeenCalledTimes(1);
  expect(reportSentryMessage.mock.calls[0][0]).toBe(
    "org-payout-batch-failures",
  );
});

it("re-arms a stuck org payout only when the gateway confirms it holds none", async () => {
  payout = {
    id: "op_s",
    status: "PROCESSING",
    gatewayPayoutId: null,
    updatedAt: new Date(0),
  };
  findByReference.mockResolvedValueOnce({
    kind: "gateway_error",
    detail: "503",
  });
  const first = await handleStuckPayouts();
  expect(payout.status).toBe("PROCESSING");
  expect(first.errors).toHaveLength(1);

  findByReference.mockResolvedValueOnce({ kind: "none" });
  const second = await handleStuckPayouts();
  expect(payout.status).toBe("APPROVED");
  expect(second.retriedCount).toBe(1);
});
