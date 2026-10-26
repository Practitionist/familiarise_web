/**
 * @jest-environment node
 */

/**
 * A timed-out member overage on a wallet parent whose org has spent the wallet
 * below the base: the claim commits, the wallet gives what it holds, the rest
 * books as ORG_RECEIVABLE, and the run carries on past any row that throws.
 */
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    overageEvent: { findMany: jest.fn() },
    $transaction: jest.fn(),
  },
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: (_job: string, _opts: unknown, fn: () => unknown) => fn(),
}));
jest.mock("../../lib/email/senders/money", () => ({
  sendOrgOperationalEmail: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../lib/novu/org-workflows", () => ({
  notifyMemberOverageTimedOut: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemErrorSafe: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
  reportSentryMessage: jest.fn(),
}));

import prisma from "../../lib/prisma";
import { recordSystemErrorSafe } from "../../lib/enterprise/system-events";
import { FINANCIAL_JOB_NAMES } from "../../lib/cron/financial-jobs";
import { runTimeoutMemberOverages } from "../../jobs/billing/timeout-member-overages";

type Entry = { key: string; accountId: string; dir: string; paise: number };

/** Parent pN is wallet-funded off billing account baN; every overage carved 40,000 paise. */
function world(balances: Record<string, number>) {
  const amount: Record<string, number> = { p1: 60_000, p2: 60_000 };
  const walletLeg: Record<string, number> = { ...amount };
  const entries: Entry[] = [];
  const posted = new Set<string>();
  const n = (id: string) => id.replace(/\D/g, "");
  const tx = {
    overageEvent: {
      updateMany: async () => ({ count: 1 }),
      findFirst: async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        basePaise: 40_000,
        overageBehavior: "CHARGE_MEMBER",
        payment: {
          id: `side${n(where.id)}`,
          parentPaymentId: `p${n(where.id)}`,
        },
      }),
      count: async () => 0,
    },
    payment: {
      findUnique: async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        billableToOrgInvoiceId: null,
        billingAccountId: `ba${n(where.id)}`,
      }),
      updateMany: async (a: {
        where: { id: string };
        data: { amount: { increment: number } };
      }) => {
        amount[a.where.id] += a.data.amount.increment;
        return { count: 1 };
      },
    },
    paymentLeg: {
      findUnique: async (a: {
        where: { paymentId_source: { paymentId: string; source: string } };
      }) =>
        a.where.paymentId_source.source === "WALLET"
          ? { amountPaise: walletLeg[a.where.paymentId_source.paymentId] }
          : null,
      update: async (a: {
        where: { paymentId_source: { paymentId: string } };
        data: { amountPaise: { increment: number } };
      }) => {
        walletLeg[a.where.paymentId_source.paymentId] +=
          a.data.amountPaise.increment;
      },
    },
    billingAccount: {
      updateMany: async (a: {
        where: { id: string; walletBalance: null | { gte: number } };
        data: { walletBalance: number | { decrement: number } };
      }) => {
        const gte = a.where.walletBalance?.gte;
        if (gte === undefined || balances[a.where.id] < gte) {
          return { count: 0 };
        }
        balances[a.where.id] -= (
          a.data.walletBalance as { decrement: number }
        ).decrement;
        return { count: 1 };
      },
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => ({
        walletBalance: balances[where.id],
        ownerOrgId: "org1",
      }),
    },
    ledgerTransaction: {
      findUnique: async ({ where }: { where: { idempotencyKey: string } }) =>
        where.idempotencyKey.startsWith("booking:") ||
        posted.has(where.idempotencyKey)
          ? { id: "t" }
          : null,
      create: async ({
        data,
      }: {
        data: {
          idempotencyKey: string;
          entries: {
            create: {
              accountId: string;
              direction: string;
              amountPaise: bigint;
            }[];
          };
        };
      }) => {
        posted.add(data.idempotencyKey);
        for (const e of data.entries.create) {
          entries.push({
            key: data.idempotencyKey,
            accountId: e.accountId.split("|")[0],
            dir: e.direction,
            paise: Number(e.amountPaise),
          });
        }
        return { id: data.idempotencyKey };
      },
    },
    ledgerAccount: { createMany: async () => ({ count: 0 }) },
    consultantEarnings: { findMany: async () => [] },
    organizationEarnings: { findMany: async () => [] },
  };
  return { tx, amount, walletLeg, entries };
}

describe("timed-out member overage on a short wallet", () => {
  it("books the shortfall as ORG_RECEIVABLE and processes every other row", async () => {
    const balances = { ba1: 15_000, ba2: 100_000 };
    const w = world(balances);
    const assignment = {
      membership: { userId: "u1" },
      program: {
        name: "P",
        contract: { organization: { id: "org1", name: "Org" } },
      },
    };
    const mocked = prisma as unknown as {
      overageEvent: { findMany: jest.Mock };
      $transaction: jest.Mock;
    };
    mocked.overageEvent.findMany.mockResolvedValue(
      ["ov1", "ov3", "ov2"].map((id) => ({
        id,
        marginalPaise: 47_200,
        currency: "INR",
        programAssignment: assignment,
      })),
    );
    mocked.$transaction.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        const next = mocked.$transaction.mock.calls.length;
        if (next === 2) throw new Error("serialization failure");
        return fn(w.tx);
      },
    );

    const stats = await runTimeoutMemberOverages({ limit: 10 });

    expect(stats).toEqual({ scanned: 3, timedOut: 2, errored: 1 });
    expect(balances).toEqual({ ba1: 0, ba2: 60_000 });
    // Only the wallet-covered part joins the leg, so the legs still sum to the amount.
    expect(w.amount).toEqual({ p1: 75_000, p2: 100_000 });
    expect(w.walletLeg).toEqual(w.amount);
    const shortfall = w.entries
      .filter((e) => e.key === "overage-restore:ov1")
      .map(({ accountId, dir, paise }) => [accountId, dir, paise]);
    expect(shortfall).toEqual([
      ["WALLET", "DEBIT", 15_000],
      ["ORG_RECEIVABLE", "DEBIT", 25_000],
      ["DISCOUNT", "CREDIT", 40_000],
    ]);
    expect(recordSystemErrorSafe).toHaveBeenCalledTimes(1);
    expect(
      (recordSystemErrorSafe as jest.Mock).mock.calls[0][0].context,
    ).toEqual({
      receivableOverageEventIds: ["ov1"],
      errors: [{ overageEventId: "ov3", error: "serialization failure" }],
    });
  });

  it("holds the abandoned-overage sweep in DEGRADED maintenance", () => {
    expect(FINANCIAL_JOB_NAMES.has("sweep-abandoned-overage-charges")).toBe(
      true,
    );
  });
});
