/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react";

jest.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: null }),
}));

import { BillingStateSelect } from "@/app/checkout/components/BillingStateSelect";
import { BuyerPriceProvider } from "@/components/pricing/BuyerPriceProvider";
import { pricingFaqs, pricingHowItWorks } from "@/app/(pages)/constants";

const props = { value: null, onChange: jest.fn(), required: true, error: null };

function renderSelect(gstRegistered: boolean) {
  render(
    <BuyerPriceProvider gstRegistered={gstRegistered}>
      <BillingStateSelect {...props} />
    </BuyerPriceProvider>,
  );
}

describe("billing state hint", () => {
  it("names the GST invoice once registered", () => {
    renderSelect(true);
    expect(screen.getByText("Needed for your GST invoice.")).toBeTruthy();
    expect(screen.getByText("Billing state (for GST)")).toBeTruthy();
  });

  it("names the receipt while unregistered and still requires the state", () => {
    renderSelect(false);
    expect(
      screen.getByText("Needed for your receipt and tax records."),
    ).toBeTruthy();
    expect(screen.getByText("Billing state")).toBeTruthy();
    expect(
      screen.getByRole("combobox").getAttribute("aria-invalid"),
    ).toBeNull();
  });
});

describe("pricing page copy", () => {
  it("states 18% GST only when registered", () => {
    expect(pricingHowItWorks(true).join(" ")).toContain("GST at 18%");
    expect(pricingHowItWorks(false).join(" ")).not.toContain("18%");
    expect(JSON.stringify(pricingFaqs(false))).not.toContain("18%");
    expect(JSON.stringify(pricingFaqs(true))).toContain("18%");
  });
});
