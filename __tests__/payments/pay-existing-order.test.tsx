/**
 * #1775 P-1 — a Razorpay approval "pay-link" is the order id, so every Pay
 * button guarded on `^https?://` and nothing could be paid. The href helper
 * now resolves an order id to our pay page, and the page opens the EXISTING
 * order in the Razorpay sheet without minting a new one through checkout.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("../../app/checkout/plans/utils", () => ({
  loadScript: jest.fn(async () => true),
  busyRetryToast: jest.fn(),
  checkoutNeedsGateway: jest.fn(),
  fetchCheckoutWithBusyRetry: jest.fn(),
  mintClientIdempotencyKey: () => "key",
  reportPaymentsError: jest.fn(),
}));
jest.mock("../../hooks/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

import React, { act } from "react";
import { createRoot } from "react-dom/client";

import RazorpayCheckout from "../../app/checkout/components/RazorpayCheckout";
import { payLinkHref } from "../../lib/payments/pay-link-href";

describe("payLinkHref", () => {
  it("resolves a Razorpay order id to the pay page and keeps hosted links", () => {
    expect(payLinkHref({ paymentId: "pay_1", checkoutUrl: "order_Nx1" })).toBe(
      "/checkout/pay/pay_1",
    );
    expect(
      payLinkHref({ paymentId: "pay_1", checkoutUrl: "https://rzp.io/l/x" }),
    ).toBe("https://rzp.io/l/x");
    expect(
      payLinkHref({ paymentId: null, checkoutUrl: "order_Nx1" }),
    ).toBeNull();
  });
});

describe("RazorpayCheckout existing-order mode", () => {
  it("opens the order it was given and never calls /api/checkout", async () => {
    process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = "rzp_test_key";
    const open = jest.fn();
    const Razorpay = jest.fn(() => ({ on: jest.fn(), open }));
    Object.assign(window, { Razorpay });
    const fetchSpy = jest.fn();
    Object.assign(globalThis, { fetch: fetchSpy });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <RazorpayCheckout
          existingOrder={{
            orderId: "order_Nx1",
            paymentId: "pay_1",
            amount: 118000,
            currency: "INR",
          }}
          onPaymentSuccess={jest.fn()}
          onPaymentError={jest.fn()}
        />,
      );
    });
    await act(async () => {
      container.querySelector("button")!.click();
    });

    expect(Razorpay).toHaveBeenCalledWith(
      expect.objectContaining({ order_id: "order_Nx1", amount: 118000 }),
    );
    expect(open).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});
