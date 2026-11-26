/**
 * @jest-environment node
 */

/**
 * #1915 P3 — PENDING_TRUST earnings promotion is inlined at the two events
 * that establish sponsor trust:
 *   1. Admin organization verification (`POST /api/admin/organizations/[orgId]/verify` with `action: "VERIFY"`)
 *   2. First paid organization invoice (`handleOrgPaymentSuccess` with `notes.type === "invoice_payment"`)
 */

const orgEarningsUpdateMany = jest.fn().mockResolvedValue({ count: 2 });
const consultantEarningsUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
const orgFindUnique = jest.fn();
const orgFindUniqueOrThrow = jest.fn();
const orgInvoiceFindUnique = jest.fn();
const orgInvoiceUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
const overageEventUpdateMany = jest.fn().mockResolvedValue({ count: 0 });
const orgAuditLogCreate = jest.fn().mockResolvedValue({});

const tx = {
  organization: {
    findUnique: (...a: unknown[]) => orgFindUnique(...a),
    findUniqueOrThrow: (...a: unknown[]) => orgFindUniqueOrThrow(...a),
  },
  organizationInvoice: {
    findUnique: (...a: unknown[]) => orgInvoiceFindUnique(...a),
    findUniqueOrThrow: (...a: unknown[]) => orgInvoiceFindUnique(...a),
    updateMany: (...a: unknown[]) => orgInvoiceUpdateMany(...a),
  },
  organizationInvoiceReceipt: {
    findUnique: jest.fn(async () => null),
    create: jest.fn(async () => ({ id: "rcpt_1" })),
    groupBy: jest.fn(async () => []),
    aggregate: jest.fn(async () => ({ _sum: { amountPaise: BigInt(50_000) } })),
  },
  creditNote: { groupBy: jest.fn(async () => []) },
  ledgerTransaction: { findUnique: jest.fn(async () => null) },
  membership: { findMany: jest.fn(async () => []) },
  overageEvent: {
    updateMany: (...a: unknown[]) => overageEventUpdateMany(...a),
  },
  organizationEarnings: {
    updateMany: (...a: unknown[]) => orgEarningsUpdateMany(...a),
  },
  consultantEarnings: {
    updateMany: (...a: unknown[]) => consultantEarningsUpdateMany(...a),
  },
  platformIncident: { findMany: jest.fn(async () => []) },
  orgAuditLog: {
    create: (...a: unknown[]) => orgAuditLogCreate(...a),
  },
  opsActionLog: { create: jest.fn(async () => ({ id: "ops_1" })) },
};

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    organizationInvoice: {
      findUnique: (...a: unknown[]) => orgInvoiceFindUnique(...a),
    },
    orgAuditLog: {
      create: (...a: unknown[]) => orgAuditLogCreate(...a),
    },
  },
}));

jest.mock("../../lib/auth-helpers", () => ({
  requireBackofficeSurface: jest.fn(async () => ({
    session: {
      user: { id: "admin_1", role: "ADMIN" },
      session: { createdAt: new Date() },
    },
  })),
}));

jest.mock("../../lib/data/public-cache", () => ({
  purgeOrgSurfaces: jest.fn(),
}));

jest.mock("../../lib/enterprise/transitions", () => ({
  IllegalTransitionError: class IllegalTransitionError extends Error {},
  transitionOrganization: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../lib/payments/ledger/post", () => ({
  postLedgerTxn: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../lib/novu/org-workflows", () => ({
  notifyOrgInvoicePaid: jest.fn().mockResolvedValue([]),
  notifyOrgWalletTopupConfirmed: jest.fn().mockResolvedValue([]),
}));

import { NextRequest } from "next/server";
import { POST as verifyOrg } from "../../app/api/admin/organizations/[orgId]/verify/route";
import { handleOrgPaymentSuccess } from "../../app/api/webhooks/utils";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("Inline PENDING_TRUST -> PENDING earnings promotion (#1915 P3)", () => {
  it("promotes PENDING_TRUST earnings when an admin verifies an organization", async () => {
    orgFindUnique.mockResolvedValueOnce({
      id: "org_1",
      status: "PENDING_VERIFICATION",
      slug: "acme",
    });
    orgFindUniqueOrThrow.mockResolvedValueOnce({
      id: "org_1",
      status: "ACTIVE",
      slug: "acme",
    });

    const req = new NextRequest(
      "https://x.test/api/admin/organizations/org_1/verify",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "VERIFY", reason: "documents ok" }),
      },
    );

    const res = await verifyOrg(req, {
      params: Promise.resolve({ orgId: "org_1" }),
    });

    expect(res.status).toBe(200);
    // Keyed on the payment's sponsor, never on the earning org.
    expect(orgEarningsUpdateMany).toHaveBeenCalledWith({
      where: {
        payment: { organizationId: "org_1" },
        status: "PENDING_TRUST",
      },
      data: { status: "PENDING" },
    });
    expect(consultantEarningsUpdateMany).toHaveBeenCalledWith({
      where: {
        payment: { organizationId: "org_1" },
        status: "PENDING_TRUST",
      },
      data: { status: "PENDING" },
    });
  });

  it("does NOT promote PENDING_TRUST earnings when suspending an active organization", async () => {
    orgFindUnique.mockResolvedValueOnce({
      id: "org_1",
      status: "ACTIVE",
      slug: "acme",
    });
    orgFindUniqueOrThrow.mockResolvedValueOnce({
      id: "org_1",
      status: "SUSPENDED",
      slug: "acme",
    });

    const req = new NextRequest(
      "https://x.test/api/admin/organizations/org_1/verify",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "SUSPEND", reason: "fraud review" }),
      },
    );

    const res = await verifyOrg(req, {
      params: Promise.resolve({ orgId: "org_1" }),
    });

    expect(res.status).toBe(200);
    expect(orgEarningsUpdateMany).not.toHaveBeenCalled();
  });

  // An org still awaiting verification can pay (FIN-24); paying releases its trust hold.
  it("promotes PENDING_TRUST earnings when an organization invoice is marked PAID", async () => {
    orgInvoiceFindUnique.mockResolvedValue({
      id: "inv_1",
      invoiceNumber: "INV-001",
      totalPaise: 50_000,
      status: "ISSUED",
      displayCurrency: "INR",
      organizationId: "org_1",
      providerPaymentId: null,
      organization: { name: "Acme", status: "PENDING_VERIFICATION" },
    });
    orgInvoiceUpdateMany.mockResolvedValue({ count: 1 });

    await handleOrgPaymentSuccess(
      {
        type: "invoice_payment",
        invoiceId: "inv_1",
        organizationId: "org_1",
      },
      "pay_rzp_1",
      50_000,
    );

    const expectedWhere = {
      payment: {
        organizationId: "org_1",
        OR: [
          { billableToOrgInvoiceId: "inv_1" },
          { billableToOrgInvoiceId: null },
        ],
      },
      status: "PENDING_TRUST",
    };
    expect(orgEarningsUpdateMany).toHaveBeenCalledWith({
      where: expectedWhere,
      data: { status: "PENDING" },
    });
    expect(consultantEarningsUpdateMany).toHaveBeenCalledWith({
      where: expectedWhere,
      data: { status: "PENDING" },
    });
  });
});
