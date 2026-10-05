/**
 * @jest-environment node
 */

/**
 * #785 (task #25) — abandoned overage-charge sweeper. Never-paid PENDING
 * CHARGE_MEMBER side-charges count toward the per-cycle circuit-breaker ceiling
 * (cycleOverageSoFarPaise excludes only REVERSED/BLOCKED/FAILED). This job FAILs
 * the abandoned ones so they stop blocking legit bookings.
 */
jest.mock("../../lib/prisma", () => {
  const client = {
    overageEvent: { findMany: jest.fn() },
    // #812 — the sweep claims per-event in a tx (FAIL + basePaise restore).
    $transaction: jest.fn(
      (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => fn(client),
    ),
  };
  return { __esModule: true, default: client };
});
jest.mock("../../lib/payments/billing/overage-transitions", () => ({
  transitionOverage: jest.fn(),
}));
jest.mock("../../lib/payments/billing/overage-base-carve", () => ({
  restoreOverageBaseCarve: jest.fn().mockResolvedValue("restored"),
}));
jest.mock("../../lib/enterprise/system-events", () => {
  const recordSystemError = jest.fn().mockResolvedValue(undefined);
  // `*Safe` is the one the sweep calls for audit writes. Returning a
  // hand-resolved promise lets a test observe how many writes the sweep holds
  // open at once, which is the whole point: the batch change exists so that
  // number stops scaling with `limit`.
  const recordSystemErrorSafe = jest.fn(() => {
    auditWriteDepth += 1;
    auditWritePeak = Math.max(auditWritePeak, auditWriteDepth);
    return new Promise<void>((resolve) => {
      auditReleases.push(() => {
        auditWriteDepth -= 1;
        resolve();
      });
    });
  });
  return {
    recordSystemError,
    recordSystemErrorSafe,
  };
});

// `let` is enough: the mock above only reads these when a mocked call runs
// during a test, long after this declaration has initialised them.
let auditWriteDepth = 0;
let auditWritePeak = 0;
let auditReleases: Array<() => void> = [];

// #476 — the sweep cores are now wrapped in withCronLock; pass through so
// these unit tests exercise the sweep logic, not the lock (covered in
// with-cron-lock.test.ts).
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: jest.fn((_job: string, _opts: unknown, fn: () => unknown) =>
    fn(),
  ),
  CronLockHeldError: class CronLockHeldError extends Error {},
  CronLockUnavailableError: class CronLockUnavailableError extends Error {},
  LONG_JOB_TTL_MS: 35 * 60 * 1000,
}));

import prisma from "../../lib/prisma";
import { transitionOverage } from "../../lib/payments/billing/overage-transitions";
import { restoreOverageBaseCarve } from "../../lib/payments/billing/overage-base-carve";
import { recordSystemErrorSafe } from "../../lib/enterprise/system-events";
import { sweepAbandonedOverageCharges } from "../../scripts/cleanup/sweep-abandoned-overage-charges";

const mockFindMany = (
  prisma as unknown as { overageEvent: { findMany: jest.Mock } }
).overageEvent.findMany;
const mockTransition = transitionOverage as jest.Mock;
const mockRestore = restoreOverageBaseCarve as jest.Mock;
const mockSafeAudit = recordSystemErrorSafe as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  // Default: the normal path, no audit writes. The batching test opts in.
  mockRestore.mockResolvedValue("restored");
  mockTransition.mockResolvedValue(1);
  auditWriteDepth = 0;
  auditWritePeak = 0;
  auditReleases = [];
});

describe("sweepAbandonedOverageCharges (#785)", () => {
  it("FAILs abandoned PENDING CHARGE_MEMBER charges to free the ceiling", async () => {
    mockFindMany.mockResolvedValue([{ id: "ov_1" }, { id: "ov_2" }]);
    mockTransition.mockResolvedValue(2);

    const r = await sweepAbandonedOverageCharges({ ageDays: 7 });

    expect(r).toMatchObject({ scanned: 2, failed: 2 });
    const where = mockFindMany.mock.calls[0][0].where;
    expect(where.chargeStatus).toBe("PENDING");
    expect(where.overageBehavior).toBe("CHARGE_MEMBER");
    expect(where.createdAt).toHaveProperty("lt");
    // Only never-STARTED side-charges: no payment, or a non-SUCCEEDED payment
    // whose paymentIntent is still the synthetic `overage:<parentId>` (the order
    // route overwrites it with the real gateway id once the member opens
    // checkout). #785 — a charge whose intent was replaced may be captured-but-
    // webhook-stuck, so it must NOT be swept (FAILing it would strand money).
    expect(where.OR).toEqual(
      expect.arrayContaining([
        { paymentId: null },
        {
          payment: {
            is: {
              paymentStatus: { not: "SUCCEEDED" },
              paymentIntent: { startsWith: "overage:" },
            },
          },
        },
      ]),
    );
    // #812 — per-event tx now: PENDING→FAILED claim (transitionOverage
    // appends the legal-from guard) + basePaise restore land together,
    // stamping an auditable write-off reason (#779 §A).
    expect(mockTransition).toHaveBeenCalledTimes(2);
    for (const id of ["ov_1", "ov_2"]) {
      expect(mockTransition).toHaveBeenCalledWith(
        expect.anything(),
        { id },
        "FAILED",
        { chargeFailureReason: "Payment not started within 7 days" },
      );
    }
  });

  it("bounds concurrent audit writes instead of opening one per invoiced parent", async () => {
    const COUNT = 40;
    mockFindMany.mockResolvedValue(
      Array.from({ length: COUNT }, (_, i) => ({ id: `ov_${i}` })),
    );
    mockTransition.mockResolvedValue(1);
    // Every parent was already invoiced, so every iteration takes the audit
    // branch — this is the shape that used to open `limit` writes at once.
    mockRestore.mockResolvedValue("invoiced");

    auditWriteDepth = 0;
    auditWritePeak = 0;
    auditReleases = [];

    // The sweep only advances past a batch when those writes settle, so drain
    // them as they appear rather than awaiting the whole sweep first.
    const run = sweepAbandonedOverageCharges({ ageDays: 7, limit: COUNT });
    const pump = (async () => {
      for (let i = 0; i < COUNT + 2; i += 1) {
        await Promise.resolve();
        while (auditReleases.length > 0) auditReleases.shift()!();
        await new Promise((r) => setImmediate(r));
      }
    })();
    const r = await Promise.all([run, pump]).then(([result]) => result);

    expect(r.failed).toBe(COUNT);
    // The regression: 40 concurrent writes against a pool documented at
    // PG_POOL_MAX=1 (lib/prisma.ts:63). They queue past the connection timeout,
    // and `*Safe` resolves even on failure, so the sweep could report success
    // having durably recorded nothing.
    expect(auditWritePeak).toBeLessThanOrEqual(10);
    // And the writes are still all made — batching must not drop them.
    expect(mockSafeAudit).toHaveBeenCalledTimes(COUNT);
  });

  it("empty scan → no transition", async () => {
    mockFindMany.mockResolvedValue([]);
    const r = await sweepAbandonedOverageCharges();
    expect(r).toMatchObject({ scanned: 0, failed: 0 });
    expect(mockTransition).not.toHaveBeenCalled();
  });
});
