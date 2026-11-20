/**
 * @jest-environment node
 */

// An invoice's dates are India calendar dates: one issued at 23:33 UTC on
// 19 Oct reads 20 Oct 2026, labelled IST, on its PDF, the Billing list and
// drawer, the CSV, the emails and the bell, on a UTC server and for a viewer
// whose profile zone is Los Angeles (where it is still 19 Oct), and is filed
// with the IRP as 20/10/2026.

type Node = unknown;
const mockPdfDocs: Node[] = [];
jest.mock("@react-pdf/renderer", () => ({
  Document: "Document",
  Page: "Page",
  View: "View",
  Text: "Text",
  Image: "Image",
  StyleSheet: { create: <T,>(s: T) => s },
  Font: { register: () => undefined },
  renderToBuffer: async (doc: Node) => {
    mockPdfDocs.push(doc);
    return new Uint8Array([37, 80, 68, 70]);
  },
}));
jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  logger: { info: jest.fn() },
}));
jest.mock("@/lib/cron/with-cron-lock", () => ({
  withCronLock: (_job: string, _opts: unknown, run: () => unknown) => run(),
}));
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: (reads: Promise<unknown>[]) => Promise.all(reads),
    organizationInvoice: {
      count: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    creditNote: { findFirst: jest.fn() },
    consumerInvoice: { findUnique: jest.fn(), update: jest.fn() },
    consumerCreditNote: { findFirst: jest.fn(), update: jest.fn() },
    orgAuditLog: { create: jest.fn() },
    user: { findMany: jest.fn() },
    membership: { findMany: jest.fn() },
  },
}));
jest.mock("@/lib/auth-helpers", () => ({
  requireOrgAccess: async () => ({
    error: null,
    member: { id: "m-owner", role: "OWNER" },
  }),
  requireBackofficeSurface: async () => ({ error: "unused" }),
  isPrivileged: () => false,
}));
jest.mock("@/lib/auth-server", () => ({
  getSession: async () => ({ user: { id: "buyer-1", role: "USER" } }),
}));
jest.mock("@/lib/rate-limit", () => ({
  applyRateLimit: async () => null,
  moneyOpsLimiter: {},
}));
jest.mock("@/lib/pdf/storage", () => ({
  pdfStoragePathFor: () => "org/inv.pdf",
  consumerPdfStoragePathFor: () => "buyer/inv.pdf",
  uploadInvoicePdf: async () => undefined,
  createInvoicePdfSignedUrl: async () => "https://storage.test/signed.pdf",
}));
jest.mock("@/lib/pdf/supplier", () => {
  const supplier = () => ({
    name: "Practitionist (OPC) Private Limited",
    gstin: "06ABCDE1234F1Z5",
    address: "Gurgaon, Haryana",
    email: "billing@familiarise.test",
    stateCode: "06",
  });
  return {
    SUPPLIER_UNAVAILABLE_MESSAGE: "unavailable",
    getPlatformSupplier: supplier,
    platformSupplierForJob: supplier,
  };
});
jest.mock("@/lib/payments/billing/org-invoice-settlement", () => ({
  outstandingPaiseByInvoice: async () => new Map(),
  invoiceOutstandingPaise: async () => 118_000,
}));
const mockRenderedEmails: Node[] = [];
jest.mock("@/lib/email/render", () => ({
  renderEmail: async (element: Node) => {
    mockRenderedEmails.push(element);
    return { html: "<p></p>", text: "" };
  },
}));
jest.mock("@/lib/email/deliver", () => ({
  deliver: jest.fn(),
  stage: jest.fn(),
  attempt: jest.fn(),
  stageRenderFailure: jest.fn(),
}));
const mockBellPayloads: Record<string, unknown>[] = [];
jest.mock("@/lib/novu/service", () => ({
  triggerWorkflow: jest.fn(),
  triggerForMultiple: async (
    _id: string,
    _users: string[],
    payload: Record<string, unknown>,
  ) => {
    mockBellPayloads.push(payload);
    return [];
  },
  triggerForMultipleZoned: async (
    _id: string,
    _users: string[],
    build: (zone: string) => Record<string, unknown>,
  ) => {
    mockBellPayloads.push(build("America/Los_Angeles"));
    return [];
  },
}));
jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("invoice=inv-1"),
}));
jest.mock("@/lib/auth-client", () => ({ useSession: () => ({ data: null }) }));
// Radix portals render nothing on a server pass; the drawer's body is what is pinned.
jest.mock("@/components/ui/sheet", () => {
  const Pass = ({ children }: { children?: unknown }) => <>{children}</>;
  return {
    Sheet: Pass,
    SheetContent: Pass,
    SheetHeader: Pass,
    SheetTitle: Pass,
    SheetDescription: Pass,
  };
});

import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import prisma from "@/lib/prisma";
import { DisplayZoneProvider } from "@/lib/time/zoned-format";
import { GET as listInvoices } from "@/app/api/organizations/[orgId]/billing-account/invoices/route";
import { GET as invoiceDetail } from "@/app/api/organizations/[orgId]/billing-account/invoices/[invoiceId]/route";
import { GET as exportInvoices } from "@/app/api/organizations/[orgId]/billing-account/invoices/export/route";
import { GET as orgInvoicePdf } from "@/app/api/organizations/[orgId]/billing-account/invoices/[invoiceId]/pdf/route";
import { GET as orgCreditNotePdf } from "@/app/api/organizations/[orgId]/billing-account/credit-notes/[creditNoteId]/pdf/route";
import { GET as consumerInvoicePdf } from "@/app/api/payments/[paymentId]/invoice/pdf/route";
import { GET as consumerCreditNotePdf } from "@/app/api/payments/[paymentId]/credit-note/[creditNoteId]/pdf/route";
import {
  fetchInvoiceDetail,
  fetchInvoices,
} from "@/app/dashboard/organization/[orgId]/billing/billing-api";
import { InvoicesPanel } from "@/app/dashboard/organization/[orgId]/billing/InvoicesPanel";
import {
  prepareOrgBillingEmail,
  prepareOrgInvoiceOverdueEmail,
} from "@/lib/email/senders/money";
import { notifyOrgInvoiceIssued } from "@/lib/novu/org-workflows";
import { runIrpUploader } from "@/jobs/compliance/irp-uploader";
import { buildIrpPayload } from "@/lib/compliance/irp-payload";

const db = jest.mocked(prisma, { shallow: false }) as unknown as {
  organizationInvoice: Record<
    "count" | "findMany" | "findFirst" | "update",
    jest.Mock
  >;
  creditNote: { findFirst: jest.Mock };
  consumerInvoice: { findUnique: jest.Mock };
  consumerCreditNote: { findFirst: jest.Mock };
  user: { findMany: jest.Mock };
  membership: { findMany: jest.Mock };
};

// 23:33 UTC on 19 Oct is 05:03 IST on 20 Oct and 16:33 PDT on 19 Oct.
const ISSUED = new Date("2026-10-19T23:33:00.000Z");
// Thirty days on: 19 Nov in India, 18 Nov in UTC and Los Angeles.
const DUE = new Date("2026-11-18T23:33:00.000Z");
const VIEWER_ZONE = "America/Los_Angeles";

/** Locale date APIs without a zone print in UTC, as on Netlify. */
function utcServer() {
  const original = Date.prototype.toLocaleDateString;
  jest.spyOn(Date.prototype, "toLocaleDateString").mockImplementation(function (
    this: Date,
    locales,
    options,
  ) {
    return original.call(this, locales, { timeZone: "UTC", ...options });
  });
}

/** Every Text line of a react-pdf tree, function components expanded. */
function pdfLines(node: Node, out: string[] = []): string[] {
  const flat = (n: Node): string => {
    if (typeof n === "string" || typeof n === "number") return String(n);
    if (Array.isArray(n)) return n.map(flat).join("");
    if (!n || typeof n !== "object") return "";
    const { type, props } = n as { type: unknown; props: { children?: Node } };
    if (typeof type === "function") return flat(type(props));
    return flat(props?.children);
  };
  if (Array.isArray(node)) node.forEach((n) => pdfLines(n, out));
  else if (node && typeof node === "object") {
    const { type, props } = node as {
      type: unknown;
      props: { children?: Node };
    };
    if (typeof type === "function") pdfLines(type(props), out);
    else if (type === "Text") out.push(flat(props.children));
    else pdfLines(props?.children, out);
  }
  return out;
}

const orgInvoiceRow = {
  id: "inv-1",
  organizationId: "org-1",
  invoiceNumber: "WIPRO-2026-0001",
  status: "ISSUED",
  displayCurrency: "INR",
  subtotalPaise: 100_000,
  igstPaise: 18_000,
  cgstPaise: 0,
  sgstPaise: 0,
  totalPaise: 118_000,
  hsnCode: "998311",
  placeOfSupply: "29",
  gstin: "29AAACW0387R1Z0",
  reverseCharge: false,
  issuedAt: ISSUED,
  dueDate: DUE,
  paidAt: null,
  billingCycleStart: null,
  billingCycleEnd: null,
  autoGenerated: true,
  createdAt: ISSUED,
  pdfUrl: null,
  pdfStoragePath: null,
  pdfGeneratedAt: null,
  purchaseOrderId: null,
  contractId: null,
  irn: null,
  ackNumber: null,
  ackDate: null,
  irpStatus: "PENDING",
  purchaseOrder: null,
  contract: null,
  billedPayments: [],
  payment: null,
  organization: {
    name: "Wipro Limited",
    billingEmail: "ap@wipro.test",
    taxInfo: { gstin: "29AAACW0387R1Z0" },
  },
  lineItems: [
    {
      id: "line-1",
      description: "Career session",
      quantity: 1,
      unitPricePaise: 100_000,
      taxPaise: 18_000,
      paymentId: null,
      hsnCode: "998311",
    },
  ],
  creditNotes: [
    {
      id: "cn-1",
      creditNoteNumber: "WIPRO-CN-2026-0001",
      totalPaise: 11_800,
      issuedAt: ISSUED,
      reason: null,
    },
  ],
};

const snapshot = {
  currency: "INR",
  sacCode: "999293",
  taxRateBps: 1800,
  placeOfSupply: "29",
  placeOfSupplySource: "BUYER_DECLARED",
  supplierName: "Practitionist (OPC) Private Limited",
  supplierGstin: "06ABCDE1234F1Z5",
  supplierAddress: "Gurgaon, Haryana",
  supplierStateCode: "06",
  buyerName: "Priya Anderson",
  buyerEmail: "priya@example.com",
  buyerAddress: null,
  buyerStateCode: "29",
};

const consumerInvoiceRow = {
  ...snapshot,
  id: "ci-1",
  userId: "buyer-1",
  invoiceNumber: "FAM-2026-00001",
  issuedAt: ISSUED,
  supplyDate: ISSUED,
  taxableValuePaise: 100_000,
  cgstPaise: 0,
  sgstPaise: 0,
  igstPaise: 18_000,
  totalPaise: 118_000,
  pdfStoragePath: null,
  pdfGeneratedAt: null,
  payment: {
    originalAmount: 100_000,
    appointment: null,
    appointmentParticipants: [],
  },
};

beforeEach(() => {
  mockPdfDocs.length = 0;
  mockRenderedEmails.length = 0;
  mockBellPayloads.length = 0;
  utcServer();
  db.organizationInvoice.count.mockResolvedValue(1);
  db.organizationInvoice.findMany
    .mockReset()
    .mockResolvedValue([orgInvoiceRow]);
  db.organizationInvoice.findFirst.mockReset().mockResolvedValue(orgInvoiceRow);
  db.creditNote.findFirst.mockResolvedValue({
    id: "cn-1",
    creditNoteNumber: "WIPRO-CN-2026-0001",
    status: "ISSUED",
    issuedAt: ISSUED,
    createdAt: ISSUED,
    reason: "Refund",
    subtotalPaise: 10_000,
    igstPaise: 1_800,
    cgstPaise: 0,
    sgstPaise: 0,
    totalPaise: 11_800,
    organization: orgInvoiceRow.organization,
    invoice: { invoiceNumber: "WIPRO-2026-0001", issuedAt: ISSUED },
  });
  db.consumerInvoice.findUnique.mockResolvedValue(consumerInvoiceRow);
  db.consumerCreditNote.findFirst.mockResolvedValue({
    id: "ccn-1",
    creditNoteNumber: "FAM-CN-2026-0001",
    issuedAt: ISSUED,
    reason: "Refund",
    taxableValuePaise: 10_000,
    cgstPaise: 0,
    sgstPaise: 0,
    igstPaise: 1_800,
    totalPaise: 11_800,
    pdfStoragePath: null,
    pdfGeneratedAt: null,
    consumerInvoice: {
      ...snapshot,
      userId: "buyer-1",
      invoiceNumber: "FAM-2026-00001",
      issuedAt: ISSUED,
    },
  });
  db.user.findMany.mockResolvedValue([
    {
      id: "owner-1",
      email: "owner@wipro.test",
      name: "Owner",
      timezone: VIEWER_ZONE,
      notificationPreferences: null,
    },
  ]);
  db.membership.findMany.mockResolvedValue([{ userId: "owner-1" }]);
});

afterEach(() => jest.restoreAllMocks());

const req = (url = "http://localhost/x") => new NextRequest(url);

describe("an invoice issued at 23:33 UTC on 19 Oct reads 20 Oct 2026 (IST)", () => {
  it.each([
    [
      "org invoice",
      () =>
        orgInvoicePdf(req(), {
          params: Promise.resolve({ orgId: "org-1", invoiceId: "inv-1" }),
        }),
    ],
    [
      "org credit note",
      () =>
        orgCreditNotePdf(req(), {
          params: Promise.resolve({ orgId: "org-1", creditNoteId: "cn-1" }),
        }),
    ],
    [
      "consumer invoice",
      () =>
        consumerInvoicePdf(req(), {
          params: Promise.resolve({ paymentId: "pay-1" }),
        }),
    ],
    [
      "consumer credit note",
      () =>
        consumerCreditNotePdf(req(), {
          params: Promise.resolve({
            paymentId: "pay-1",
            creditNoteId: "ccn-1",
          }),
        }),
    ],
  ])("on the %s PDF", async (_name, download) => {
    const res = await download();
    expect(res.status).toBeLessThan(400);
    const lines = pdfLines(mockPdfDocs[0]);
    expect(lines.filter((l) => l.includes("2026"))).toEqual(
      expect.arrayContaining([expect.stringContaining("20 Oct 2026")]),
    );
    expect(lines.join("\n")).not.toMatch(/19 Oct|19\/10/);
    expect(lines.some((l) => l.includes("(IST)"))).toBe(true);
  });

  it("with the due date on the org invoice PDF in India time too", async () => {
    await orgInvoicePdf(req(), {
      params: Promise.resolve({ orgId: "org-1", invoiceId: "inv-1" }),
    });
    const lines = pdfLines(mockPdfDocs[0]);
    expect(lines).toEqual(
      expect.arrayContaining(["Issued: 20 Oct 2026", "Due: 19 Nov 2026"]),
    );
  });

  it("on the Billing list and drawer for a Los Angeles profile", async () => {
    const routes: Record<string, () => Promise<Response>> = {
      "/api/organizations/org-1/billing-account/invoices?perPage=50": () =>
        listInvoices(req("http://localhost/x?perPage=50"), {
          params: Promise.resolve({ orgId: "org-1" }),
        }),
      "/api/organizations/org-1/billing-account/invoices/inv-1": () =>
        invoiceDetail(req(), {
          params: Promise.resolve({ orgId: "org-1", invoiceId: "inv-1" }),
        }),
    };
    jest
      .spyOn(global, "fetch")
      .mockImplementation(async (url) => routes[String(url)]());

    const client = new QueryClient();
    client.setQueryData(
      ["org-billing-invoices", "org-1"],
      await fetchInvoices("org-1"),
    );
    client.setQueryData(
      ["org-invoice-detail", "org-1", "inv-1"],
      await fetchInvoiceDetail("org-1", "inv-1"),
    );
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <DisplayZoneProvider zone={VIEWER_ZONE}>
          <InvoicesPanel
            orgId="org-1"
            summary={{
              data: undefined,
              isPending: true,
              isError: false,
              refetch: () => undefined,
            }}
            canPay={false}
            moneyMoveBlocked={false}
            moneyMoveReason=""
          />
        </DisplayZoneProvider>
      </QueryClientProvider>,
    );
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

    expect(text).toContain("Issued (IST) 20 Oct 2026");
    expect(text).toContain("Due (IST) 19 Nov 2026");
    expect(text).toContain("WIPRO-CN-2026-0001 · 20 Oct 2026 (IST)");
    expect(text).not.toMatch(/19 Oct|18 Nov/);
  });

  it("in the CSV export", async () => {
    const res = await exportInvoices(req(), {
      params: Promise.resolve({ orgId: "org-1" }),
    });
    const [header, row] = (await res.text()).trim().split("\n");
    const cells = Object.fromEntries(
      header.split(",").map((name, i) => [name, row.split(",")[i]]),
    );

    expect(cells).toMatchObject({
      issue_date_ist: "20 Oct 2026",
      due_date_ist: "19 Nov 2026",
    });
  });

  it("in the issued and overdue emails to a Los Angeles recipient", async () => {
    await prepareOrgBillingEmail({
      recipientUserIds: ["owner-1"],
      organizationId: "org-1",
      orgName: "Wipro Limited",
      kind: "INVOICE_ISSUED",
      amountPaise: 118_000,
      currency: "INR",
      invoiceId: "inv-1",
      invoiceNumber: "WIPRO-2026-0001",
      dueDate: DUE,
      dashboardUrl: "/dashboard/organization/org-1/billing",
    });
    await prepareOrgInvoiceOverdueEmail({
      recipientUserIds: ["owner-1"],
      invoiceId: "inv-1",
      invoiceNumber: "WIPRO-2026-0001",
      orgName: "Wipro Limited",
      totalPaise: 118_000,
      currency: "INR",
      dueDate: DUE,
      daysLate: 3,
      reminderStage: 1,
      payUrl: "/pay",
    });

    const texts = mockRenderedEmails.map((e) =>
      renderToStaticMarkup(e as React.ReactElement).replace(/<[^>]+>/g, ""),
    );
    expect(texts).toHaveLength(2);
    for (const t of texts) expect(t).toContain("19 Nov 2026 (IST)");
  });

  it("in the invoice-issued bell", async () => {
    await notifyOrgInvoiceIssued("org-1", {
      organizationId: "org-1",
      orgName: "Wipro Limited",
      invoiceNumber: "WIPRO-2026-0001",
      totalPaise: 118_000,
      currency: "INR",
      dueDate: DUE.toISOString(),
      dashboardUrl: "/dashboard/organization/org-1/billing",
    });

    expect(mockBellPayloads).toEqual([
      expect.objectContaining({ dueDate: "19 Nov 2026 (IST)" }),
    ]);
  });

  describe("with the IRP", () => {
    /** `new Date("YYYY-MM-DD HH:mm:ss")` reads the wall time as UTC, as on Netlify. */
    function utcHostParse() {
      const RealDate = Date;
      const WALL = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
      class UtcHostDate extends RealDate {
        constructor(...args: unknown[]) {
          if (typeof args[0] === "string" && WALL.test(args[0])) {
            super(`${args[0].replace(" ", "T")}Z`);
          } else {
            super(...(args as []));
          }
        }
      }
      global.Date = UtcHostDate as DateConstructor;
      return () => {
        global.Date = RealDate;
      };
    }

    /** One uploader run whose IRP answers `ackDt`: what was filed, and what was stored. */
    async function fileWithIrp(ackDt: string) {
      db.organizationInvoice.findMany.mockResolvedValueOnce([
        {
          ...orgInvoiceRow,
          lutNumber: null,
          irpRetryCount: 0,
          organization: {
            name: "Wipro Limited",
            taxInfo: {
              gstin: "29AAACW0387R1Z0",
              gstStateCode: "29",
              hsnDefault: "999293",
            },
          },
          lineItems: [
            {
              position: 0,
              description: "Career session",
              quantity: 1,
              unitPricePaise: 100_000,
              hsnCode: "998311",
            },
          ],
        },
      ]);
      db.organizationInvoice.update.mockClear();
      let filed: { DocDtls: { Dt: string } } | undefined;
      jest.spyOn(global, "fetch").mockImplementation(async (_url, init) => {
        filed = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            data: { Irn: "irn-1", AckNo: 1, AckDt: ackDt, SignedQRCode: "qr" },
          }),
        );
      });
      const restore = utcHostParse();
      try {
        await expect(runIrpUploader({})).resolves.toMatchObject({
          processed: 1,
        });
      } finally {
        restore();
      }
      const stored = db.organizationInvoice.update.mock.calls[0][0].data;
      return { filed, ackDate: stored.ackDate as Date };
    }

    beforeEach(() => {
      process.env.PLATFORM_GSTIN = "06ABCDE1234F1Z5";
      process.env.CLEARTAX_API_KEY = "key";
      process.env.CLEARTAX_GSP_TOKEN = "token";
    });
    afterEach(() => {
      delete process.env.PLATFORM_GSTIN;
      delete process.env.CLEARTAX_API_KEY;
      delete process.env.CLEARTAX_GSP_TOKEN;
    });

    it("files the India issue date and stores the evening acknowledgement's true instant", async () => {
      // 21:15 IST on 20 Oct is 15:45 UTC.
      const { filed, ackDate } = await fileWithIrp("2026-10-20 21:15:00");

      expect(filed?.DocDtls.Dt).toBe("20/10/2026");
      expect(ackDate.toISOString()).toBe("2026-10-20T15:45:00.000Z");
    });

    it("prints an early-morning acknowledgement on its India date", async () => {
      // 03:00 IST on 20 Oct is 21:30 UTC on 19 Oct.
      const { ackDate } = await fileWithIrp("2026-10-20 03:00:00");
      db.organizationInvoice.findFirst.mockResolvedValueOnce({
        ...orgInvoiceRow,
        irn: "irn-1",
        ackNumber: "1",
        ackDate,
        irpStatus: "GENERATED",
      });
      await orgInvoicePdf(req(), {
        params: Promise.resolve({ orgId: "org-1", invoiceId: "inv-1" }),
      });

      const lines = pdfLines(mockPdfDocs[0]);
      expect(lines[lines.indexOf("Ack date (IST)") + 1]).toBe("20 Oct 2026");
    });

    it("names the original invoice's India date on a credit note payload", () => {
      const built = buildIrpPayload({
        invoice: {
          invoiceNumber: "WIP-CN-2026-0001",
          issuedAt: ISSUED,
          reverseCharge: false,
          lutNumber: null,
          subtotalPaise: 10_000,
          cgstPaise: 0,
          sgstPaise: 0,
          igstPaise: 1_800,
          totalPaise: 11_800,
          hsnCode: "998311",
          placeOfSupply: "29",
        },
        lineItems: [
          {
            position: 0,
            description: "Refund",
            quantity: 1,
            unitPricePaise: 10_000,
            hsnCode: null,
          },
        ],
        buyer: {
          name: "Wipro Limited",
          gstin: "29AAACW0387R1Z0",
          stateCode: "29",
          hsnDefault: "999293",
        },
        seller: {
          gstin: "06ABCDE1234F1Z5",
          legalName: "Practitionist (OPC) Private Limited",
          address1: "Sector 67",
          location: "Gurgaon",
          pincode: "122018",
          stateCode: "06",
        },
        docType: "CRN",
        originalInvoiceNumber: "WIPRO-2026-0001",
        originalInvoiceDate: ISSUED,
      });
      if (!built.ok) throw new Error(built.reason);

      expect(built.payload).toMatchObject({
        DocDtls: { Dt: "20/10/2026" },
        OrigDocDtls: { No: "WIPRO-2026-0001", Dt: "20/10/2026" },
      });
    });
  });
});
