/**
 * @jest-environment node
 */

/**
 * Payout approval CAS (money-hardening pass).
 *
 * approvePayout/rejectPayout used to be check-then-act: two concurrent admin
 * actions (approve ∥ reject) both read PENDING, reject committed (earnings
 * released, payout CANCELLED), and approve's unconditional update overwrote
 * CANCELLED → APPROVED — an approved payout with no backing earnings that the
 * cron then pays while the freed earnings re-batch: double pay.
 *
 * Under test:
 *   - approve claims via updateMany WHERE status = PENDING; a lost claim
 *     surfaces the current state in the thrown error and never writes;
 *   - reject claims the payout INSIDE the same tx as the earnings release,
 *     so an interleaved approve either loses cleanly or we never touch the
 *     earnings.
 */
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultantPayout: {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
    consultantEarnings: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    $transaction: jest.fn(),
  },
}));
jest.mock("../../lib/redis", () => ({
  acquireLock: jest.fn().mockResolvedValue("tok"),
  releaseLock: jest.fn().mockResolvedValue(undefined),
  isMockRedis: jest.fn().mockReturnValue(false),
  checkRedisHealth: jest.fn().mockResolvedValue(true),
  isRedisCircuitOpen: jest.fn().mockReturnValue(false),
}));

import prisma from "../../lib/prisma";
import {
  approvePayout,
  PayoutMakerCheckerError,
  rejectPayout,
} from "../../lib/payments/payouts/payout-service";

/** The Prisma surface approve/reject touch in these tests. */
interface ApprovalPrismaMock {
  consultantPayout: {
    findUnique: jest.Mock;
    findFirst?: jest.Mock;
    updateMany: jest.Mock;
  };
  consultantEarnings: { updateMany: jest.Mock };
  user?: { count: jest.Mock };
  systemEvent?: { create: jest.Mock };
  $transaction: jest.Mock;
}

// Single seam over the generated client (repo-wide mock idiom).
const cp = prisma as unknown as ApprovalPrismaMock;

beforeEach(() => {
  jest.clearAllMocks();
});

describe("approvePayout CAS", () => {
  test("claims PENDING atomically and stamps the approver", async () => {
    cp.consultantPayout.updateMany.mockResolvedValueOnce({ count: 1 });

    await approvePayout("payout_1", "admin_1");

    expect(cp.consultantPayout.updateMany).toHaveBeenCalledWith({
      where: { id: "payout_1", status: "PENDING" },
      data: expect.objectContaining({
        status: "APPROVED",
        approvedBy: "admin_1",
      }),
    });
  });

  test("a lost claim throws with the CURRENT state and writes nothing else", async () => {
    // A concurrent reject won: the row is already CANCELLED.
    cp.consultantPayout.updateMany.mockResolvedValueOnce({ count: 0 });
    cp.consultantPayout.findUnique.mockResolvedValueOnce({
      status: "CANCELLED",
    });

    await expect(approvePayout("payout_1", "admin_1")).rejects.toThrow(
      /current status: CANCELLED/,
    );
    // Exactly one write was attempted (the losing claim) — no follow-up
    // unconditional update may exist.
    expect(cp.consultantPayout.updateMany).toHaveBeenCalledTimes(1);
    expect(cp.consultantPayout.findUnique).toHaveBeenCalledTimes(1);
  });
});

describe("approvePayout maker-checker (#1902)", () => {
  beforeEach(() => {
    cp.consultantPayout.findFirst = jest.fn();
    cp.user = { count: jest.fn() };
    cp.systemEvent = { create: jest.fn().mockResolvedValue({ id: "se_1" }) };
    delete process.env.PAYOUT_MAKER_CHECKER_REQUIRED;
  });

  afterEach(() => {
    delete cp.consultantPayout.findFirst;
    delete cp.user;
    delete cp.systemEvent;
  });

  test("rejects self-approval with PayoutMakerCheckerError (403) when multiple admins exist", async () => {
    cp.consultantPayout.findFirst!.mockResolvedValueOnce({
      status: "PENDING",
      createdBy: "admin_1",
    });
    cp.user!.count.mockResolvedValueOnce(2);

    await expect(approvePayout("payout_1", "admin_1")).rejects.toThrow(
      PayoutMakerCheckerError,
    );
    expect(cp.consultantPayout.updateMany).not.toHaveBeenCalled();
  });

  test("allows solo-admin bootstrap self-approval when activeAdminCount === 1 and emits WARN SystemEvent", async () => {
    cp.consultantPayout.findFirst!.mockResolvedValueOnce({
      status: "PENDING",
      createdBy: "admin_solo",
    });
    cp.user!.count.mockResolvedValueOnce(1);
    cp.consultantPayout.updateMany.mockResolvedValueOnce({ count: 1 });

    await approvePayout("payout_1", "admin_solo");

    expect(cp.consultantPayout.updateMany).toHaveBeenCalledWith({
      where: { id: "payout_1", status: "PENDING" },
      data: expect.objectContaining({
        status: "APPROVED",
        approvedBy: "admin_solo",
      }),
    });
    expect(cp.systemEvent!.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          category: "PAYOUT",
          severity: "WARN",
          message: expect.stringContaining("PAYOUT_SOLO_ADMIN_SELF_APPROVAL"),
        }),
      }),
    );
  });
});

describe("rejectPayout CAS", () => {
  test("claims the payout inside the same tx as the earnings release", async () => {
    const tx = {
      consultantPayout: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }).mockName("claim"),
        findUnique: jest.fn(),
      },
      consultantEarnings: {
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    };
    cp.$transaction.mockImplementationOnce(
      async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    );

    await rejectPayout("payout_1", "duplicate batch");

    // Claim FIRST (PENDING → CANCELLED), release SECOND, one tx.
    const order = tx.consultantPayout.updateMany.mock.invocationCallOrder[0];
    const releaseOrder =
      tx.consultantEarnings.updateMany.mock.invocationCallOrder[0];
    expect(order).toBeLessThan(releaseOrder);
    expect(tx.consultantPayout.updateMany).toHaveBeenCalledWith({
      where: { id: "payout_1", status: "PENDING" },
      data: { status: "CANCELLED", failureReason: "duplicate batch" },
    });
    expect(tx.consultantEarnings.updateMany).toHaveBeenCalledWith({
      where: { payoutId: "payout_1", status: "BATCHED" },
      data: { payoutId: null, status: "READY" },
    });
  });

  test("a lost claim aborts WITHOUT releasing any earnings", async () => {
    const tx = {
      consultantPayout: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findUnique: jest.fn().mockResolvedValue({ status: "APPROVED" }),
      },
      consultantEarnings: { updateMany: jest.fn() },
    };
    cp.$transaction.mockImplementationOnce(
      async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    );

    await expect(rejectPayout("payout_1", "late")).rejects.toThrow(
      /cannot be rejected/,
    );
    expect(tx.consultantEarnings.updateMany).not.toHaveBeenCalled();
  });
});

