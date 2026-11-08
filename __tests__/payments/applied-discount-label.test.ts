import { appliedDiscountLabel } from "@/app/checkout/plans/math";

const fmt = (paise: number) => `₹${(paise / 100).toFixed(2)}`;

describe("appliedDiscountLabel", () => {
  it("shows the capped amount, not the code's face value", () => {
    expect(
      appliedDiscountLabel(
        {
          code: "BIG",
          discountType: "FIXED_AMOUNT",
          discountValue: 275_800,
          discountAmount: 37_192,
        },
        fmt,
      ),
    ).toEqual({ label: "₹371.92 off", limited: true });
  });

  it("shows a percentage code as rupees once priced, without a limit note", () => {
    expect(
      appliedDiscountLabel(
        {
          code: "TEN",
          discountType: "PERCENTAGE",
          discountValue: 10,
          discountAmount: 10_000,
        },
        fmt,
      ),
    ).toEqual({ label: "₹100.00 off", limited: false });
  });

  it("falls back to the face value before the preview has priced it", () => {
    expect(
      appliedDiscountLabel(
        { code: "TEN", discountType: "PERCENTAGE", discountValue: 10 },
        fmt,
      ),
    ).toEqual({ label: "10% off", limited: false });
  });
});
