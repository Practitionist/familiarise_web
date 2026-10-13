/**
 * @jest-environment node
 */

jest.mock("../../lib/enterprise/outbound-webhooks/dispatch", () => ({
  dispatchWebhookEvent: jest.fn(),
}));
jest.mock("../../lib/novu/org-workflows", () => ({
  notifyOrgInvoiceIssued: jest.fn(),
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));
jest.mock("../../lib/payments/billing/consumer-invoice", () => ({
  supplierStateCode: () => "29",
  SupplierStateMismatchError: class extends Error {},
}));
const mockGenerateNumber = jest.fn();
jest.mock("../../lib/payments/billing/invoice-numbering", () => ({
  generateOrgInvoiceNumber: (...a: unknown[]) => mockGenerateNumber(...a),
}));
jest.mock("../../lib/payments/billing/org-invoice-journal", () => ({
  postInvoiceIssuedJournal: jest.fn(),
}));
jest.mock("../../lib/payments/billing/purchase-order-draw", () => ({
  drawPurchaseOrder: jest.fn(),
}));

import {
  createOrgInvoice,
  CreateOrgInvoiceSchema,
} from "../../lib/payments/billing/create-org-invoice";
import { OpsRefusal } from "../../lib/backoffice/ops-refusal-error";
import type { Tx } from "../../lib/prisma";

const base = {
  dueDate: "2026-11-30",
  items: [{ description: "Seats", quantity: 1, unitPrice: 100 }],
};

describe("CreateOrgInvoiceSchema line-item bounds", () => {
  it("accepts the largest allowed quantity and unit price", () => {
    const parsed = CreateOrgInvoiceSchema.safeParse({
      ...base,
      items: [
        { description: "Seats", quantity: 100_000, unitPrice: 10_000_000_000 },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it.each([
    ["quantity", { quantity: 100_001, unitPrice: 1 }],
    ["unitPrice", { quantity: 1, unitPrice: 10_000_000_001 }],
    ["fractional unitPrice", { quantity: 1, unitPrice: 1.5 }],
  ])("rejects an out-of-range %s", (_label, line) => {
    const parsed = CreateOrgInvoiceSchema.safeParse({
      ...base,
      items: [{ description: "Seats", ...line }],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("createOrgInvoice total overflow", () => {
  it("refuses a total beyond a safe integer before numbering the invoice", async () => {
    const tx = {
      organization: {
        findUnique: jest.fn(async () => ({
          id: "org_1",
          name: "Acme",
          slug: "acme",
          taxInfo: { gstStateCode: "29", gstin: null, hsnDefault: null },
          dataResidencyRegion: "IN",
          billingAccountId: "ba_1",
          invoiceNumberPrefix: null,
          requiresPO: false,
        })),
      },
    } as unknown as Tx;
    const input = CreateOrgInvoiceSchema.parse({
      ...base,
      items: Array.from({ length: 10 }, () => ({
        description: "Seats",
        quantity: 100_000,
        unitPrice: 10_000_000_000,
      })),
    });

    const result = createOrgInvoice(tx, {
      orgId: "org_1",
      actorMembershipId: "m_1",
      input,
    });

    await expect(result).rejects.toBeInstanceOf(OpsRefusal);
    await expect(result).rejects.toMatchObject({
      code: "INVOICE_AMOUNT_TOO_LARGE",
      httpStatus: 400,
    });
    expect(mockGenerateNumber).not.toHaveBeenCalled();
  });
});
