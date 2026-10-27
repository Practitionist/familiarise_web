/**
 * @jest-environment node
 */

/**
 * The organisation rail keeps maker-checker for an admin-started run: the
 * admin who minted a manual batch cannot co-approve its payouts, and an
 * approver cannot trigger the disbursement of a payout they approved.
 * Scheduled runs carry no actor and behave as before.
 */
const WINDOW = new Date("2026-11-02T20:00:00.000Z");
const OLD = new Date(WINDOW.getTime() - 3 * 24 * 60 * 60 * 1000);
const earning = {
  id: "oe-1",
  organizationId: "org-a",
  createdAt: OLD,
  grossAmountPaise: 100_000,
  platformFeePaise: 10_000,
  orgSharePaise: 90_000,
  refundedAmountPaise: 0,
  currency: "INR",
};
let pending: Record<string, unknown>[] = [];
let approvalRow: Record<string, unknown> | null = null;
const recordEvent = jest.fn(async (..._args: unknown[]) => undefined);

jest.mock("../../lib/prisma", () => {
  const client = {
    organizationEarnings: {
      groupBy: jest.fn(async () => [
        {
          organizationId: earning.organizationId,
          _count: 1,
          _min: { createdAt: earning.createdAt },
        },
      ]),
      updateMany: jest.fn(async () => ({ count: 1 })),
      findMany: jest.fn(async () => [earning]),
    },
    organizationPayoutAccount: {
      findUnique: jest.fn(async () => ({ status: "VERIFIED" })),
    },
    organizationPayout: {
      findUnique: jest.fn(async ({ where }: { where: { id?: string } }) =>
        where.id ? (approvalRow ?? { status: "APPROVED" }) : null,
      ),
      findMany: jest
        .fn()
        .mockImplementation(
          async ({ where }: { where: { status: unknown } }) =>
            where.status === "PROCESSING" ? [] : pending,
        ),
      create: jest.fn(async ({ data }: { data: object }) => ({
        id: "op-1",
        ...data,
      })),
      update: jest.fn(async () => ({})),
    },
    user: { count: jest.fn(async () => 2) },
    organization: { findUnique: jest.fn(async () => null) },
    orgAuditLog: { create: jest.fn(async () => ({})) },
    $transaction: jest.fn(
      async (fn: (tx: unknown) => unknown): Promise<unknown> => fn(client),
    ),
  };
  return { __esModule: true, default: client };
});
jest.mock("../../lib/enterprise/system-events", () => ({
  ...jest.requireActual("../../lib/enterprise/system-events"),
  recordSystemEventSafe: (...args: unknown[]) => recordEvent(...args),
}));
jest.mock("../../lib/redis", () => ({
  acquireLock: jest.fn(async () => "tok"),
  releaseLock: jest.fn(async () => undefined),
}));
jest.mock("../../lib/maintenance", () => ({
  getActiveOrgMaintenanceWindow: jest.fn(async () => null),
}));
jest.mock("../../lib/compliance/tds", () => ({
  ...jest.requireActual("../../lib/compliance/tds"),
  resolveEffectiveTdsRate: jest.fn(async () => 0.001),
}));
jest.mock("../../lib/payments/payouts/clawback-recovery", () => ({
  ...jest.requireActual("../../lib/payments/payouts/clawback-recovery"),
  recoverClawbackOnPayout: jest.fn(async () => 0),
}));

import prisma from "@/lib/prisma";
import {
  approveOrgPayout,
  createOrgPayoutBatches,
  processPendingOrgPayouts,
} from "@/lib/payments/payouts/org-payout-service";
import { PayoutMakerCheckerError } from "@/lib/payments/payouts/shared-lifecycle";

const payouts = jest.mocked(prisma.organizationPayout);

beforeEach(() => {
  jest.clearAllMocks();
  pending = [];
  approvalRow = null;
});

it("mints a manual batch as its admin, who then cannot co-approve it; cron mints as SYSTEM_CRON", async () => {
  await createOrgPayoutBatches({
    periodEnd: WINDOW,
    limit: 10,
    createdBy: "admin_1",
  });
  const manual = payouts.create.mock.calls[0][0].data;
  expect(manual.createdBy).toBe("admin_1");

  approvalRow = {
    status: "PENDING",
    createdBy: "admin_1",
    orgApprovedBy: "member_1",
    organizationId: "org-a",
    amountPaise: 90_000,
    platformApprovalRequiredAt: new Date(),
  };
  await expect(approveOrgPayout("op-1", "admin_1")).rejects.toBeInstanceOf(
    PayoutMakerCheckerError,
  );
  approvalRow = null;

  await createOrgPayoutBatches({ periodEnd: WINDOW, limit: 10 });
  expect(payouts.create.mock.calls[1][0].data.createdBy).toBe("SYSTEM_CRON");
});

it("skips disbursing a payout its triggering admin approved, on either approval", async () => {
  pending = [
    { id: "op-platform", approvedBy: "admin_1", orgApprovedBy: "member_1" },
    { id: "op-org", approvedBy: "admin_2", orgApprovedBy: "admin_1" },
    { id: "op-other", approvedBy: "admin_2", orgApprovedBy: "member_1" },
  ];
  await processPendingOrgPayouts({ limit: 10, triggeredByUserId: "admin_1" });
  const processed = payouts.findUnique.mock.calls.map(
    ([args]) => args.where.id,
  );
  expect(processed).toEqual(["op-other"]);
  expect(recordEvent).toHaveBeenCalledTimes(2);

  jest.clearAllMocks();
  await processPendingOrgPayouts({ limit: 10 });
  expect(payouts.findUnique.mock.calls.map(([args]) => args.where.id)).toEqual([
    "op-platform",
    "op-org",
    "op-other",
  ]);
  expect(recordEvent).not.toHaveBeenCalled();
});
