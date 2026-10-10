/**
 * @jest-environment node
 *
 * pdfkit's `#standard-fonts/*` subpath is invisible to the file tracer, so every
 * PDF route must name it; a render failure must reach the route's catch.
 */
import fs from "node:fs";
import path from "node:path";

const captureException = jest.fn();
jest.mock("@sentry/nextjs", () => ({
  captureException: (...a: unknown[]) => captureException(...a),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    organizationInvoice: {
      findFirst: jest.fn().mockResolvedValue({
        id: "inv1",
        status: "ISSUED",
        pdfStoragePath: null,
        pdfGeneratedAt: null,
        organization: { name: "Org", billingEmail: null, taxInfo: null },
        lineItems: [],
      }),
    },
  },
}));
jest.mock("../../lib/auth-helpers", () => ({
  requireOrgAccess: jest.fn().mockResolvedValue({ member: { id: "m1" } }),
  requireBackofficeSurface: jest.fn(),
}));
jest.mock("../../lib/rate-limit", () => ({
  applyRateLimit: jest.fn().mockResolvedValue(null),
  moneyOpsLimiter: {},
}));
jest.mock("../../lib/pdf/supplier", () => ({
  getPlatformSupplier: jest.fn().mockReturnValue({ name: "Supplier" }),
}));
jest.mock("../../lib/pdf/storage", () => ({
  pdfStoragePathFor: jest.fn(),
  uploadInvoicePdf: jest.fn(),
  createInvoicePdfSignedUrl: jest.fn(),
}));
jest.mock("../../lib/pdf/invoice-renderer", () => ({
  renderOrgInvoicePdf: jest
    .fn()
    .mockRejectedValue(new Error("Cannot find module Helvetica.cjs")),
}));

import { GET } from "@/app/api/organizations/[orgId]/billing-account/invoices/[invoiceId]/pdf/route";

describe("PDF routes", () => {
  it("answers 500 JSON and reports once when the render rejects", async () => {
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await GET({} as never, {
      params: Promise.resolve({ orgId: "o1", invoiceId: "inv1" }),
    });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Failed to generate invoice PDF");
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it("traces pdfkit's standard fonts for all four PDF routes", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "next.config.mjs"),
      "utf8",
    );
    const block = src.slice(src.indexOf("outputFileTracingIncludes"));
    const routes = [
      "/api/payments/[paymentId]/invoice/pdf",
      "/api/payments/[paymentId]/credit-note/[creditNoteId]/pdf",
      "/api/organizations/[orgId]/billing-account/invoices/[invoiceId]/pdf",
      "/api/organizations/[orgId]/billing-account/credit-notes/[creditNoteId]/pdf",
    ];
    for (const r of routes) {
      const start = block.indexOf(`"${r}"`);
      expect(start).toBeGreaterThan(-1);
      expect(block.slice(start, start + 260)).toContain("...PDFKIT_FONT_FILES");
    }
    expect(src).toContain("node_modules/pdfkit/js/standard-fonts/**");
  });
});
