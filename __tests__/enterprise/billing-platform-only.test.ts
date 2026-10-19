/**
 * @jest-environment node
 */

/**
 * Only the platform extends credit, issues or voids an org invoice, or moves
 * its due date; a tenant may lower its credit limit and cancel a draft.
 */

import { NextRequest } from "next/server";

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

const tx = {
  billingAccount: { findFirst: jest.fn(), update: jest.fn() },
  organizationInvoice: {
    count: jest.fn(),
    findFirst: jest.fn(),
    updateMany: jest.fn(),
    findUniqueOrThrow: jest.fn(),
  },
  purchaseOrder: { update: jest.fn() },
  orgAuditLog: { create: jest.fn() },
  opsActionLog: { create: jest.fn() },
};
const transaction = jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: (fn: (t: typeof tx) => unknown) => transaction(fn),
  },
}));
jest.mock("../../lib/auth-helpers", () => ({
  requireOrgAccess: jest.fn(async () => ({
    member: { id: "m-owner", role: "OWNER" },
    org: { id: "org-1", name: "Acme" },
  })),
  requireBackofficeSurface: jest.fn(async () => ({
    session: {
      user: { id: "admin_1", role: "ADMIN" },
      session: { createdAt: new Date() },
    },
  })),
}));
const assertVerifiedDomainOrThrow = jest.fn(async (..._a: unknown[]) => {});
jest.mock("../../lib/enterprise/governance", () => ({
  ...jest.requireActual("../../lib/enterprise/governance"),
  assertVerifiedDomainOrThrow: (...a: unknown[]) =>
    assertVerifiedDomainOrThrow(...a),
}));

import { PATCH as patchAccount } from "@/app/api/organizations/[orgId]/billing-account/route";
import { PATCH as patchInvoice } from "@/app/api/organizations/[orgId]/billing-account/invoices/[invoiceId]/route";
import { PATCH as adminPatchAccount } from "@/app/api/admin/organizations/[orgId]/billing-account/route";

const req = (body: unknown) =>
  new NextRequest("https://x.test/api", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const orgParams = { params: Promise.resolve({ orgId: "org-1" }) };
const invoiceParams = {
  params: Promise.resolve({ orgId: "org-1", invoiceId: "inv-1" }),
};

const ACCOUNT = {
  id: "ba-1",
  ownerOrgId: "org-1",
  fundingSource: "WALLET",
  walletBalance: 0,
  currency: "INR",
  creditLimit: 1_00_000,
  minBalancePaise: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  tx.billingAccount.findFirst.mockResolvedValue(ACCOUNT);
  tx.billingAccount.update.mockImplementation(
    async ({ data }: { data: object }) => ({ ...ACCOUNT, ...data }),
  );
  tx.organizationInvoice.count.mockResolvedValue(0);
  tx.organizationInvoice.updateMany.mockResolvedValue({ count: 1 });
  tx.organizationInvoice.findUniqueOrThrow.mockResolvedValue({ id: "inv-1" });
  tx.orgAuditLog.create.mockResolvedValue({});
  tx.opsActionLog.create.mockResolvedValue({ id: "row" });
});

describe("tenant billing-account PATCH", () => {
  it.each([
    ["raise", { creditLimit: 2_00_000 }, "CREDIT_LIMIT_PLATFORM_ONLY"],
    ["remove", { creditLimit: null }, "CREDIT_LIMIT_PLATFORM_ONLY"],
    [
      "switch to INVOICE",
      { fundingSource: "INVOICE" },
      "INVOICE_FUNDING_PLATFORM_ONLY",
    ],
  ])("refuses a %s with 403", async (_label, body, code) => {
    const res = await patchAccount(req(body), orgParams);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe(code);
    expect(tx.billingAccount.update).not.toHaveBeenCalled();
  });

  it("lets a tenant lower its credit limit", async () => {
    const res = await patchAccount(req({ creditLimit: 50_000 }), orgParams);
    expect(res.status).toBe(200);
    expect(tx.billingAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { creditLimit: 50_000 } }),
    );
  });
});

describe("tenant invoice PATCH", () => {
  it.each([
    ["issue", { status: "ISSUED" }],
    ["void", { status: "VOID" }],
    ["due-date move", { dueDate: "2026-12-31" }],
  ])("refuses an %s with 403", async (_label, body) => {
    const res = await patchInvoice(req(body), invoiceParams);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("INVOICE_CHANGE_PLATFORM_ONLY");
    expect(tx.organizationInvoice.updateMany).not.toHaveBeenCalled();
  });

  it("lets a tenant cancel a draft", async () => {
    tx.organizationInvoice.findFirst.mockResolvedValue({
      id: "inv-1",
      status: "DRAFT",
      invoiceNumber: "ACME-1",
      purchaseOrderId: null,
      totalPaise: 5000,
    });
    const res = await patchInvoice(req({ status: "CANCELLED" }), invoiceParams);
    expect(res.status).toBe(200);
    expect(tx.organizationInvoice.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { in: ["DRAFT"] } }),
      }),
    );
  });
});

describe("admin billing-account door", () => {
  it("writes the account and an OpsActionLog row in one transaction", async () => {
    const res = await adminPatchAccount(
      req({
        creditLimit: null,
        fundingSource: "INVOICE",
        reason: "signed MSA with net-60",
      }),
      orgParams,
    );
    expect(res.status).toBe(200);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(assertVerifiedDomainOrThrow).toHaveBeenCalledWith(
      tx,
      "org-1",
      "INVOICE_FUNDING",
    );
    expect(tx.billingAccount.update).toHaveBeenCalledWith({
      where: { id: "ba-1" },
      data: {
        fundingSource: "INVOICE",
        walletBalance: null,
        creditLimit: null,
      },
    });
    expect(tx.opsActionLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          surface: "invoices.manage",
          targetKind: "BillingAccount",
          targetId: "ba-1",
          reason: "signed MSA with net-60",
        }),
      }),
    );
  });
});
