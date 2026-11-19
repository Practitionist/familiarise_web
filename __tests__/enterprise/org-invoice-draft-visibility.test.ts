/**
 * @jest-environment node
 */

/**
 * Draft organisation invoices are visible only to a role that manages billing.
 * The list, the CSV export, the detail, the PDF, the purchase-order invoice
 * links and the billing account's invoice count all read through one filter,
 * so a MANAGER can neither list nor count a draft.
 */

import { NextRequest } from "next/server";
import type { MemberRole } from "@prisma/client";

type Row = { id: string; organizationId: string; status: string };
const ROWS: Row[] = [
  { id: "inv-draft", organizationId: "org-1", status: "DRAFT" },
  { id: "inv-issued", organizationId: "org-1", status: "ISSUED" },
];

/** Evaluates the subset of Prisma `where` these routes build. */
function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === "AND") {
      return (cond as Record<string, unknown>[]).every((w) => matches(row, w));
    }
    if (key === "OR") {
      return true; // the export's keyset cursor; the first page has none
    }
    if (cond && typeof cond === "object" && "not" in cond) {
      return row[key as keyof Row] !== (cond as { not: unknown }).not;
    }
    return row[key as keyof Row] === cond;
  });
}
const select = (args: { where: Record<string, unknown> }) =>
  ROWS.filter((r) => matches(r, args.where)).map((r) => ({
    ...r,
    invoiceNumber: r.id,
    displayCurrency: "INR",
    subtotalPaise: 0,
    igstPaise: 0,
    cgstPaise: 0,
    sgstPaise: 0,
    totalPaise: 0,
    issuedAt: null,
    dueDate: null,
    paidAt: null,
    purchaseOrderId: null,
    contractId: null,
    createdAt: new Date("2026-11-01T00:00:00Z"),
    organization: { name: "Wipro", billingEmail: null, taxInfo: null },
    lineItems: [],
  }));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
    organizationInvoice: {
      count: jest.fn(async (args) => select(args).length),
      findMany: jest.fn(async (args) => select(args)),
      findFirst: jest.fn(async (args) => select(args)[0] ?? null),
    },
    purchaseOrder: {
      findMany: jest.fn(async (args) => [
        {
          id: "po-1",
          _count: {
            contracts: 1,
            invoices: linkedInvoices(args.include._count.select.invoices)
              .length,
          },
        },
      ]),
      findFirst: jest.fn(async (args) => ({
        id: "po-1",
        contracts: [],
        invoices: linkedInvoices(args.include.invoices).map((r) => ({
          id: r.id,
        })),
      })),
    },
    organization: {
      findUnique: jest.fn(async (args) => ({
        billingAccount: {
          id: "ba-1",
          _count: {
            invoices: linkedInvoices(
              args.select.billingAccount.include._count.select.invoices,
            ).length,
          },
        },
      })),
    },
    orgAuditLog: { create: jest.fn(async () => ({})) },
  },
}));
/** The invoices a purchase-order relation `select`/`include` entry reads. */
function linkedInvoices(entry: true | { where?: Record<string, unknown> }) {
  return ROWS.filter((r) => entry === true || matches(r, entry.where ?? {}));
}
let mockRole: MemberRole = "MANAGER";
jest.mock("../../lib/auth-helpers", () => ({
  requireOrgAccess: jest.fn(async () => ({
    member: { id: "m-1", role: mockRole },
    org: { id: "org-1" },
  })),
  requireBackofficeSurface: jest.fn(),
}));
jest.mock("../../lib/payments/billing/org-invoice-settlement", () => ({
  outstandingPaiseByInvoice: jest.fn(async () => new Map()),
  invoiceOutstandingPaise: jest.fn(async () => 0),
}));
jest.mock("../../lib/rate-limit", () => ({
  applyRateLimit: jest.fn(async () => null),
  moneyOpsLimiter: {},
}));
jest.mock("../../lib/pdf/supplier", () => ({
  getPlatformSupplier: () => ({ gstin: "29AAAAA0000A1Z5" }),
  SUPPLIER_UNAVAILABLE_MESSAGE: "unavailable",
}));
jest.mock("../../lib/pdf/storage", () => ({}));
jest.mock("../../lib/pdf/invoice-renderer", () => ({}));

import { GET as getBillingAccount } from "../../app/api/organizations/[orgId]/billing-account/route";
import { GET as listInvoices } from "../../app/api/organizations/[orgId]/billing-account/invoices/route";
import { GET as exportInvoices } from "../../app/api/organizations/[orgId]/billing-account/invoices/export/route";
import { GET as invoiceDetail } from "../../app/api/organizations/[orgId]/billing-account/invoices/[invoiceId]/route";
import { GET as invoicePdf } from "../../app/api/organizations/[orgId]/billing-account/invoices/[invoiceId]/pdf/route";
import { GET as listPurchaseOrders } from "../../app/api/organizations/[orgId]/billing-account/purchase-orders/route";
import { GET as purchaseOrderDetail } from "../../app/api/organizations/[orgId]/billing-account/purchase-orders/[poId]/route";

const req = (path: string) => new NextRequest(`http://localhost${path}`);
const orgParams = { params: Promise.resolve({ orgId: "org-1" }) };
const draftParams = () => ({
  params: Promise.resolve({ orgId: "org-1", invoiceId: "inv-draft" }),
});

async function listedIds(path: string): Promise<string[]> {
  const body = (await (await listInvoices(req(path), orgParams)).json()) as {
    data: { id: string }[];
  };
  return body.data.map((i) => i.id);
}

describe.each<[MemberRole, boolean]>([
  ["OWNER", true],
  ["BILLING_ADMIN", true],
  ["MANAGER", false],
  ["MAINTAINER", false],
])("a %s", (role, seesDrafts) => {
  beforeEach(() => {
    mockRole = role;
  });

  it(`${seesDrafts ? "lists" : "does not list"} a draft, even when asking for drafts`, async () => {
    const all = await listedIds("/x");
    const draftsOnly = await listedIds("/x?status=DRAFT");
    expect(all.includes("inv-draft")).toBe(seesDrafts);
    expect(all).toContain("inv-issued");
    expect(draftsOnly).toEqual(seesDrafts ? ["inv-draft"] : []);
  });

  it(`${seesDrafts ? "exports" : "leaves out"} a draft in the CSV`, async () => {
    const csv = await (await exportInvoices(req("/x"), orgParams)).text();
    expect(csv.includes("inv-draft")).toBe(seesDrafts);
    expect(csv).toContain("inv-issued");
  });

  it(`${seesDrafts ? "opens" : "cannot open"} a draft by id`, async () => {
    const detail = await invoiceDetail(req("/x"), draftParams());
    const pdf = await invoicePdf(req("/x"), draftParams());
    expect(detail.status).toBe(seesDrafts ? 200 : 404);
    // A draft has no legal PDF yet; a manager is told so, anyone else gets 404.
    expect(pdf.status).toBe(seesDrafts ? 409 : 404);
  });

  it(`${seesDrafts ? "counts" : "does not count"} a draft among a purchase order's invoices`, async () => {
    const list = (await (
      await listPurchaseOrders(req("/x"), orgParams)
    ).json()) as { data: { _count: { invoices: number } }[] };
    const detail = (await (
      await purchaseOrderDetail(req("/x"), {
        params: Promise.resolve({ orgId: "org-1", poId: "po-1" }),
      })
    ).json()) as { purchaseOrder: { invoices: { id: string }[] } };
    expect(list.data[0]._count.invoices).toBe(seesDrafts ? 2 : 1);
    expect(detail.purchaseOrder.invoices.map((i) => i.id)).toEqual(
      seesDrafts ? ["inv-draft", "inv-issued"] : ["inv-issued"],
    );
  });

  it(`${seesDrafts ? "counts" : "does not count"} a draft in the billing account's invoice count`, async () => {
    const body = (await (
      await getBillingAccount(req("/x"), orgParams)
    ).json()) as { billingAccount: { _count: { invoices: number } } };
    expect(body.billingAccount._count.invoices).toBe(seesDrafts ? 2 : 1);
  });
});
