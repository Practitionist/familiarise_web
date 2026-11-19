/**
 * @jest-environment node
 */

/**
 * Draft organisation invoices are visible only to a role that manages billing.
 * The list, the CSV export, the detail and the PDF all read through one filter,
 * so a MANAGER can neither list a draft nor open one by id.
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
    orgAuditLog: { create: jest.fn(async () => ({})) },
  },
}));
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

import { GET as listInvoices } from "../../app/api/organizations/[orgId]/billing-account/invoices/route";
import { GET as exportInvoices } from "../../app/api/organizations/[orgId]/billing-account/invoices/export/route";
import { GET as invoiceDetail } from "../../app/api/organizations/[orgId]/billing-account/invoices/[invoiceId]/route";
import { GET as invoicePdf } from "../../app/api/organizations/[orgId]/billing-account/invoices/[invoiceId]/pdf/route";

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
});
