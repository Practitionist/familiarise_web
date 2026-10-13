/**
 * @jest-environment node
 *
 * E-invoicing is B2B-only: the IRP uploader never selects an invoice that
 * carries no buyer GSTIN (a B2C supply), whatever else is pending.
 */
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

import { irpCandidateWhere } from "@/jobs/compliance/irp-uploader";

describe("IRP uploader scope", () => {
  it("selects only pending, in-window invoices that carry the buyer's GSTIN", () => {
    const since = new Date("2026-09-05T00:00:00Z");
    expect(irpCandidateWhere(since)).toEqual({
      irpStatus: "PENDING",
      issuedAt: { gte: since, not: null },
      gstin: { not: null },
    });
  });
});
