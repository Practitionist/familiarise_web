import {
  buyerDisplayPricePaise,
  buyerPriceLabelInr,
  buyerPriceNote,
  withBuyerPriceNote,
} from "@/lib/payments/pricing/display-price";
import { determineTax } from "@/lib/payments/tax/tax-engine";
import { describeFeeRates } from "@/lib/payments/pricing/platform-fee";
import { productPriceLabel } from "@/lib/digital-products/price-label";

jest.mock("../../lib/compliance/lut", () => ({
  hasValidPlatformLut: () => false,
}));

describe("buyerDisplayPricePaise", () => {
  it("is the list price while the platform is unregistered", () => {
    expect(buyerDisplayPricePaise(100_000, false)).toBe(100_000);
  });

  it("adds 18% GST once registered", () => {
    expect(buyerDisplayPricePaise(100_000, true)).toBe(118_000);
  });

  it("keeps free free", () => {
    expect(buyerDisplayPricePaise(0, true)).toBe(0);
    expect(buyerDisplayPricePaise(0, false)).toBe(0);
  });

  it.each([1, 49_999, 99_950, 123_457, 3_333_333])(
    "equals what checkout charges for a %i paise list price",
    (list) => {
      const tax = determineTax({ baseAmountPaise: list, buyerCountry: "IN" });
      expect(buyerDisplayPricePaise(list, true)).toBe(list + tax.taxAmount);
    },
  );
});

describe("buyer price note", () => {
  it("says incl. GST only for a priced item once registered", () => {
    expect(buyerPriceNote(100_000, true)).toBe("incl. GST");
    expect(buyerPriceNote(100_000, false)).toBeNull();
    expect(buyerPriceNote(0, true)).toBeNull();
  });

  it("appends the note to a formatted price", () => {
    expect(withBuyerPriceNote("₹1,180", 100_000, true)).toBe(
      "₹1,180 incl. GST",
    );
    expect(withBuyerPriceNote("₹1,000", 100_000, false)).toBe("₹1,000");
  });

  it("labels INR listings all-in", () => {
    expect(buyerPriceLabelInr(100_000, true)).toBe("₹1,180.00 incl. GST");
    expect(buyerPriceLabelInr(100_000, false)).toBe("₹1,000.00");
  });

  it("labels a digital product, with Free staying Free", () => {
    expect(productPriceLabel(0, true)).toBe("Free");
    expect(productPriceLabel(50_000, true)).toBe("₹590.00 incl. GST");
    expect(productPriceLabel(50_000, false)).toBe("₹500.00");
  });
});

describe("describeFeeRates", () => {
  it("shows one keep figure when both rates match", () => {
    expect(
      describeFeeRates({ marketplaceBps: 2000, ownLinkBps: 2000 }),
    ).toEqual({ marketplaceFeePct: "20", ownLinkFeePct: "20", keepPct: "80" });
  });

  it("shows the keep range when the own-link rate is lower", () => {
    expect(
      describeFeeRates({ marketplaceBps: 2000, ownLinkBps: 1000 }),
    ).toEqual({
      marketplaceFeePct: "20",
      ownLinkFeePct: "10",
      keepPct: "80–90",
    });
  });

  it("keeps fractional rates exact", () => {
    expect(
      describeFeeRates({ marketplaceBps: 1250, ownLinkBps: 1250 }),
    ).toEqual({
      marketplaceFeePct: "12.5",
      ownLinkFeePct: "12.5",
      keepPct: "87.5",
    });
  });
});
