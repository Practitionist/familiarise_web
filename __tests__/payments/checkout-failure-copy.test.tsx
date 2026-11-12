(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const router = { push: jest.fn(), back: jest.fn() };
let searchParams = new URLSearchParams();
jest.mock("next/navigation", () => ({
  useRouter: () => router,
  useSearchParams: () => searchParams,
}));
jest.mock("../../app/checkout/CheckoutSkeletons", () => ({
  CheckoutResultSkeleton: () => <div data-testid="skeleton" />,
}));

import React, { act } from "react";
import { createRoot } from "react-dom/client";

import CheckoutFailurePage from "../../app/checkout/checkout-failure/page";

function renderWith(query: string): string {
  searchParams = new URLSearchParams(query);
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<CheckoutFailurePage />));
  const text = container.textContent ?? "";
  act(() => root.unmount());
  return text;
}

describe("checkout-failure copy", () => {
  it("never renders free text from the address bar", () => {
    const text = renderWith(
      "error=Refund+pending,+call+0000&code=Call+this+number",
    );
    expect(text).not.toContain("Refund pending");
    expect(text).not.toContain("Call this number");
    expect(text).toContain("Payment failed. Please try again.");
  });

  it("shows a payment reference only when it is an id", () => {
    expect(
      renderWith("payment_intent=Call+0000+to+get+your+refund"),
    ).not.toContain("Call 0000");
    expect(renderWith("payment_intent=order_Abc123")).toContain("order_Abc123");
  });

  it("shows the mapped copy for a known code", () => {
    expect(renderWith("code=WALLET_FROZEN")).toContain(
      "Your organisation's wallet is frozen",
    );
  });
});
