/**
 * @jest-environment node
 *
 * CGST s.34(2): a credit note reduces output tax only until 30 November after
 * the supply's financial year. Past that, the note is commercial — base only,
 * every tax head zero.
 */
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("../../lib/payments/billing/credit-note-numbering", () => ({
  generateConsumerCreditNoteNumber: jest
    .fn()
    .mockResolvedValue({
      creditNoteNumber: "FAM-CN-2026-0001",
      fiscalYear: 2026,
    }),
}));

import { txDouble } from "../fixtures/tx-double";
import { gstCreditNoteCutoff } from "@/lib/compliance/gst-credit-note-cutoff";
import { mintConsumerCreditNote } from "@/lib/payments/billing/consumer-invoice";

it("ends the window on 30 November IST after the supply's financial year", () => {
  // FY 2024-25 supply (May 2024) → 30 Nov 2025, 23:59:59.999 IST.
  expect(
    gstCreditNoteCutoff(new Date("2024-05-01T00:00:00Z")).toISOString(),
  ).toBe("2025-11-30T18:29:59.999Z");
  // 31 March 23:00 IST still belongs to the FY that is ending.
  expect(
    gstCreditNoteCutoff(new Date("2025-03-31T17:30:00Z")).toISOString(),
  ).toBe("2025-11-30T18:29:59.999Z");
});

it("mints a zero-tax commercial credit note for a supply past the cutoff", async () => {
  const create = jest.fn().mockResolvedValue({ id: "ccn_1" });
  const tx = txDouble({
    consumerCreditNote: {
      findUnique: jest.fn().mockResolvedValue(null),
      aggregate: jest.fn().mockResolvedValue({ _sum: { totalPaise: null } }),
      create,
    },
    consumerInvoice: {
      findUnique: jest.fn().mockResolvedValue({
        id: "ci_1",
        supplyDate: new Date("2024-05-01T00:00:00Z"),
        taxableValuePaise: 100_000,
        cgstPaise: 9_000,
        sgstPaise: 9_000,
        igstPaise: 0,
        totalPaise: 118_000,
      }),
    },
    $executeRaw: jest.fn().mockResolvedValue(1),
  });

  await mintConsumerCreditNote(tx, {
    paymentId: "pay_1",
    refundId: "rf_1",
    amountPaise: 118_000,
    reason: "cancellation",
  });

  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        taxableValuePaise: 100_000,
        cgstPaise: 0,
        sgstPaise: 0,
        igstPaise: 0,
        totalPaise: 100_000,
        isCommercial: true,
        reason: expect.stringContaining("Commercial credit note"),
      }),
    }),
  );
});
