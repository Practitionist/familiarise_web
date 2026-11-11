/**
 * @jest-environment node
 */

/**
 * The ticker runs money batch jobs in bounded slices: two slices of N cover 2N
 * units, and a third slice in the same window finds nothing left to do.
 */

import { runAsRegisteredPlatform } from "../fixtures/gst-registered";
const earnings = new Map<string, { status: string; payoutId: string | null }>();
const payouts: { consultantProfileId: string; createdAt: Date }[] = [];
const billedOrgs = new Set<string>();
const ORGS = ["org-a", "org-b", "org-c", "org-d"];

jest.mock("../../lib/prisma", () => {
  const readyFor = (consultantProfileId: string) =>
    [...earnings.entries()]
      .filter(
        ([id, e]) =>
          id.startsWith(consultantProfileId) &&
          e.status === "READY" &&
          e.payoutId === null,
      )
      .map(([id]) => ({
        id,
        consultantSharePaise: 100_000,
        refundedShareAmount: 0,
      }));
  const tx = {
    consultantEarnings: {
      findMany: jest.fn(
        async ({ where }: { where: { consultantProfileId: string } }) =>
          readyFor(where.consultantProfileId),
      ),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id: { in: string[] } };
          data: { payoutId: string; status: string };
        }) => {
          for (const id of where.id.in) earnings.set(id, data);
          return { count: where.id.in.length };
        },
      ),
    },
    consultantPayout: {
      create: jest.fn(
        async ({ data }: { data: { consultantProfileId: string } }) => {
          payouts.push({
            consultantProfileId: data.consultantProfileId,
            createdAt: new Date(),
          });
          return { id: `payout-${payouts.length}`, ...data };
        },
      ),
    },
    ledgerTransaction: { findMany: jest.fn(async () => []) },
    ledgerEntry: { groupBy: jest.fn(async () => []) },
  };
  return {
    __esModule: true,
    default: {
      consultantEarnings: {
        groupBy: jest.fn(
          async ({
            where,
          }: {
            where: {
              consultantProfile?: {
                payouts: { none: { createdAt: { gte: Date } } };
              };
            };
          }) => {
            const since = where.consultantProfile?.payouts.none.createdAt.gte;
            return ["cp-1", "cp-2", "cp-3", "cp-4"]
              .filter((cp) => readyFor(cp).length > 0)
              .filter(
                (cp) =>
                  !since ||
                  !payouts.some(
                    (p) => p.consultantProfileId === cp && p.createdAt >= since,
                  ),
              )
              .map((consultantProfileId) => ({
                consultantProfileId,
                _sum: { consultantSharePaise: 100_000 },
              }));
          },
        ),
      },
      payoutAccount: {
        findFirst: jest.fn(async () => ({
          id: "pa-1",
          provider: "RAZORPAY",
          accountType: "BANK_ACCOUNT",
        })),
      },
      consultantProfile: {
        findUnique: jest.fn(async () => ({
          msmeStatus: "NONE",
          writtenAgreementWithFamiliarise: false,
        })),
      },
      organization: {
        findMany: jest.fn(async ({ take }: { take: number }) =>
          ORGS.filter((o) => !billedOrgs.has(o))
            .slice(0, take)
            .map((id) => ({ id })),
        ),
      },
      $executeRaw: jest.fn(async () => 1),
      $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) =>
        fn(tx),
      ),
    },
  };
});
jest.mock("../../lib/redis", () => ({
  acquireLock: jest.fn(async () => "tok"),
  releaseLock: jest.fn(async () => undefined),
  isMockRedis: jest.fn(() => false),
  checkRedisHealth: jest.fn(async () => true),
  isRedisCircuitOpen: jest.fn(() => false),
}));
jest.mock("../../lib/payments/tax/tds-service", () => ({
  getCurrentFYCumulativePayments: jest.fn(),
  getFYDateRange: jest.fn(),
  getIndianFinancialYear: jest.fn(() => "2026-27"),
  recordTDSDeduction: jest.fn(),
  TDS_THRESHOLD_PAISE: 5_000_000,
}));
jest.mock("../../lib/novu/service", () => ({
  notifyPayoutProcessed: jest.fn(),
}));
jest.mock("../../lib/payments/billing/invoice-rollup", () => ({
  rollupOrgInvoiceAccruals: jest.fn(
    async ({ organizationId }: { organizationId: string }) => {
      billedOrgs.add(organizationId);
      return {
        invoiceId: `inv-${organizationId}`,
        invoiceNumber: "N",
        billedPaymentCount: 1,
        totalPaise: 100,
      };
    },
  ),
}));
jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemError: jest.fn(),
  recordSystemErrorSafe: jest.fn(),
  recordSystemEvent: jest.fn(),
  recordSystemEventSafe: jest.fn(),
}));

import { createPayoutBatchSlice } from "../../lib/payments/payouts/payout-service";
import { settleInvoiceAccruals } from "@/jobs/billing/settle-invoice-accruals";

beforeEach(() => {
  earnings.clear();
  payouts.length = 0;
  billedOrgs.clear();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

it("batches each consultant once per window across slices of two", async () => {
  for (const cp of ["cp-1", "cp-2", "cp-3", "cp-4"]) {
    earnings.set(`${cp}-e1`, { status: "READY", payoutId: null });
  }
  const windowStart = new Date(Date.now() - 60_000);

  const runs = [];
  for (let i = 0; i < 3; i++)
    runs.push(await createPayoutBatchSlice({ limit: 2, windowStart }));
  expect(runs.map((r) => [r.minted, r.remaining])).toEqual([
    [2, 2],
    [2, 0],
    [0, 0],
  ]);

  // A READY earning released mid-window waits for the next window.
  earnings.set("cp-1-e2", { status: "READY", payoutId: null });
  expect((await createPayoutBatchSlice({ limit: 2, windowStart })).minted).toBe(
    0,
  );
  expect(payouts).toHaveLength(4);
});

it("invoices each org once across slices of two", async () => {
  const runs = [];
  for (let i = 0; i < 3; i++)
    runs.push(await settleInvoiceAccruals({ limit: 2 }));
  // `remaining` peeks one row past the slice, so it is a lower bound.
  expect(runs.map((r) => [r.invoicesCreated, r.remaining])).toEqual([
    [2, 1],
    [2, 0],
    [0, 0],
  ]);
});

// The accrual rollup issues GST invoices only for a GST-registered platform.
runAsRegisteredPlatform();
