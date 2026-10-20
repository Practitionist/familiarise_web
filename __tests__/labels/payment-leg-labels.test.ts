import { PaymentLegSource } from "@prisma/client";

import {
  PAYMENT_LEG_SOURCE_LABEL,
  paymentLegLabel,
} from "@/lib/labels/payment-leg-labels";

describe("payment leg labels", () => {
  it("names every PaymentLegSource in plain words, never the raw enum", () => {
    const sources = Object.values(PaymentLegSource);
    expect(Object.keys(PAYMENT_LEG_SOURCE_LABEL).sort()).toEqual(
      [...sources].sort(),
    );
    for (const source of sources) {
      const label = paymentLegLabel(source);
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toMatch(/[A-Z]_[A-Z]/);
    }
  });

  it("uses the learner-facing wording for the common rails", () => {
    expect(paymentLegLabel("CARD")).toBe("Card / UPI");
    expect(paymentLegLabel("WALLET")).toBe("Organisation wallet");
    expect(paymentLegLabel("INVOICE_ACCRUAL")).toBe(
      "Billed to your organisation",
    );
    expect(paymentLegLabel("LICENSE")).toBe(
      "Covered by your organisation's licence",
    );
    expect(paymentLegLabel("INVOICE_ACCRUAL_REVERSAL")).toBe(
      "Removed from your organisation's charge",
    );
    for (const source of [
      "INVOICE_ACCRUAL_REVERSAL",
      "OVERAGE_INVOICE_ACCRUAL_REVERSAL",
    ] as const) {
      expect(paymentLegLabel(source)).not.toMatch(/billed|refund/i);
    }
  });
});
