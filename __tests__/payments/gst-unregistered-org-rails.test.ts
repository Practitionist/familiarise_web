/**
 * @jest-environment node
 */

// Invariant: while PLATFORM_GSTIN is unset, organisation-funded money is refused with
// GST_REGISTRATION_REQUIRED and the org invoice jobs skip without writing an invoice.

// Built inside the factory: lib/auth reads the client at import, before module-level consts exist.
jest.mock("@/lib/prisma", () => {
  const write = jest.fn();
  return {
    __esModule: true,
    write,
    default: {
      billingAccount: {
        findFirst: jest.fn(async () => ({
          id: "ba_1",
          fundingSource: "WALLET",
        })),
      },
      walletTopUp: { findUnique: write, create: write },
      organization: {
        findUnique: jest.fn(async () => ({
          id: "org_1",
          status: "ACTIVE",
          deletedAt: null,
          billingAccountId: "ba_1",
          dataResidencyRegion: "IN",
          taxInfo: { gstStateCode: "06", gstin: null, hsnDefault: null },
        })),
        findMany: write,
      },
      billingSubscription: { findMany: jest.fn(), updateMany: write },
      organizationInvoice: { create: write },
      $transaction: write,
      $executeRaw: write,
    },
  };
});
jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  startSpan: (_opts: unknown, fn: () => unknown) => fn(),
  getCurrentScope: () => ({ setTag: jest.fn() }),
  metrics: { count: jest.fn() },
}));
jest.mock("@sentry/core", () => jest.requireMock("@sentry/nextjs"));
jest.mock("@/lib/redis", () => ({
  __esModule: true,
  default: {},
  withCircuitBreaker: (fn: () => unknown) => fn(),
  checkRedisHealth: jest.fn().mockResolvedValue(true),
}));
jest.mock("@/lib/cron/with-cron-lock", () => ({
  LONG_JOB_TTL_MS: 35 * 60 * 1000,
  withCronLock: (_n: string, _o: unknown, run: () => Promise<unknown>) => run(),
}));
jest.mock("@/lib/auth-helpers", () => ({
  requireOrgAccess: jest.fn(async () => ({})),
}));
jest.mock("@/lib/payments/core/razorpay", () => ({
  createRazorpayOrder: (...a: unknown[]) => mockWrite(...a),
}));
jest.mock("@/lib/api/organizations/wallet", () => ({
  initiateTopUp: (...a: unknown[]) => mockWrite(...a),
  parseMintedOrderId: jest.fn(),
}));
jest.mock("@/lib/payments/billing/invoice-numbering", () => ({
  generateOrgInvoiceNumber: (...a: unknown[]) => mockWrite(...a),
}));
const mockFundingSource = jest.fn();
jest.mock("@/lib/payments/checkout/org-funding", () => ({
  resolveOrgFunding: jest.fn(async (validatedData: unknown) => ({
    validatedData,
    organizationId: "org_1",
    programAssignmentId: null,
    fundingProgramId: null,
    callerMembershipId: "m_1",
    referralCreditsDropped: false,
    billingAccountId: "ba_1",
    fundingSource: mockFundingSource(),
    creditEffectiveLimit: null,
  })),
  readInvoiceExposurePaise: (...a: unknown[]) => mockWrite(...a),
  assertWithinInvoiceCreditLimit: jest.fn(),
}));
jest.mock("@/lib/payments/checkout/pricing", () => ({
  calculateAmountAndValidate: (...a: unknown[]) => mockWrite(...a),
}));
jest.mock("@/lib/payments/checkout/locks", () => ({
  getPlanDataForLock: (...a: unknown[]) => mockWrite(...a),
  acquireCheckoutLock: (...a: unknown[]) => mockWrite(...a),
  releaseCheckoutLock: jest.fn(),
  lockBuyerSeatAtoms: (...a: unknown[]) => mockWrite(...a),
}));
jest.mock("@/lib/payments/checkout/commit", () => ({
  commitCheckout: (...a: unknown[]) => mockWrite(...a),
}));

import { NextRequest } from "next/server";
import { handleCheckout } from "@/lib/payments/checkout/orchestrate";
import { POST as topUp } from "@/app/api/organizations/[orgId]/billing-account/wallet/top-ups/route";
import {
  createOrgInvoice,
  CreateOrgInvoiceSchema,
} from "@/lib/payments/billing/create-org-invoice";
import { rollupOrgInvoiceAccruals } from "@/lib/payments/billing/invoice-rollup";
import { runGenerateSubscriptionInvoices } from "@/jobs/billing/generate-subscription-invoices";
import { settleInvoiceAccruals } from "@/jobs/billing/settle-invoice-accruals";
import type { CheckoutInput } from "@/schemas/checkout";
import prisma, { type Tx } from "@/lib/prisma";

const mockWrite: jest.Mock = jest.requireMock("@/lib/prisma").write;

const refusal = { code: "GST_REGISTRATION_REQUIRED", httpStatus: 403 };
let previousGstin: string | undefined;

beforeAll(() => {
  previousGstin = process.env.PLATFORM_GSTIN;
});
beforeEach(() => {
  delete process.env.PLATFORM_GSTIN;
  jest.spyOn(console, "warn").mockImplementation(() => {});
  mockWrite.mockClear();
});
afterAll(() => {
  if (previousGstin !== undefined) process.env.PLATFORM_GSTIN = previousGstin;
});

it.each(["WALLET", "INVOICE", "LICENSE"])(
  "checkout refuses the %s rail before pricing, locking or writing",
  async (rail) => {
    mockFundingSource.mockReturnValue(rail);
    const input = {
      appointmentType: "CONSULTATION",
      planId: "plan_1",
      paymentGateway: "RAZORPAY",
    } as unknown as CheckoutInput;

    await expect(handleCheckout(input, "user_1")).rejects.toMatchObject(
      refusal,
    );
    expect(mockWrite).not.toHaveBeenCalled();
  },
);

it("refuses a wallet top-up with 403 before minting an order", async () => {
  const res = await topUp(
    new NextRequest("https://x.test/api/top-ups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amountPaise: 50_000 }),
    }),
    { params: Promise.resolve({ orgId: "org_1" }) },
  );

  expect(res.status).toBe(403);
  expect(await res.json()).toMatchObject({ code: refusal.code });
  expect(mockWrite).not.toHaveBeenCalled();
});

it("refuses a manual org invoice before numbering or creating it", async () => {
  const tx = {
    organization: prisma.organization,
    organizationInvoice: prisma.organizationInvoice,
  } as unknown as Tx;
  const input = CreateOrgInvoiceSchema.parse({
    dueDate: "2026-11-30",
    items: [{ description: "Seats", quantity: 1, unitPrice: 100_000 }],
  });

  await expect(
    createOrgInvoice(tx, { orgId: "org_1", actorMembershipId: "m_1", input }),
  ).rejects.toMatchObject(refusal);
  expect(mockWrite).not.toHaveBeenCalled();
});

it("the accrual rollup skips an org as unregistered", async () => {
  await expect(
    rollupOrgInvoiceAccruals({ organizationId: "org_1" }),
  ).resolves.toMatchObject({ invoiceId: null, skippedUnregistered: true });
  expect(mockWrite).not.toHaveBeenCalled();
});

it("the subscription invoice job issues nothing while unregistered", async () => {
  // The renewal-reminder read finds nothing; the due read finds one subscription.
  (prisma.billingSubscription.findMany as unknown as jest.Mock)
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ id: "sub_1" }]);

  await expect(runGenerateSubscriptionInvoices({})).resolves.toEqual({
    generated: 0,
    skipped: 0,
    failed: 0,
    remindersSent: 0,
    remaining: 1,
  });
  expect(mockWrite).not.toHaveBeenCalled();
});

it("the settle-invoice-accruals job skips with the config reason", async () => {
  await expect(settleInvoiceAccruals()).resolves.toEqual({
    orgsProcessed: 0,
    invoicesCreated: 0,
    failed: 0,
    remaining: 0,
    skipped: "PLATFORM_GSTIN not configured",
  });
  expect(mockWrite).not.toHaveBeenCalled();
});
