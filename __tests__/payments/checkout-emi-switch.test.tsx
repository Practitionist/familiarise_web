/**
 * #1780 row 1 — with ENABLE_CHECKOUT_EMI off (no provider, or emiEnabled
 * false) the plan checkout opens Razorpay with the EMI block hidden.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("../../hooks/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));
jest.mock("../../app/checkout/plans/utils", () => ({
  loadScript: jest.fn(async () => true),
  busyRetryToast: jest.fn(),
  checkoutNeedsGateway: () => true,
  fetchCheckoutWithBusyRetry: (call: () => Promise<unknown>) => call(),
  mintClientIdempotencyKey: () => "idem_1",
  reportPaymentsError: jest.fn(),
}));
jest.mock("../../lib/auth-client", () => ({
  useSession: () => ({ data: null }),
}));

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import RazorpayCheckout from "../../app/checkout/components/RazorpayCheckout";
import { CheckoutFlagsProvider } from "../../app/checkout/components/CheckoutFlags";
import type { CheckoutInput } from "../../schemas/checkout";

async function openedOptions(emiEnabled?: boolean) {
  const Razorpay = jest.fn(() => ({ on: jest.fn(), open: jest.fn() }));
  Object.assign(window, { Razorpay });
  process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = "rzp_test_key";
  global.fetch = jest.fn(async () => ({
    ok: true,
    json: async () => ({
      success: true,
      paymentIntent: { id: "order_1", amount: 500000, currency: "INR" },
    }),
  })) as unknown as typeof fetch;

  const container = document.createElement("div");
  const root = createRoot(container);
  const button = (
    <RazorpayCheckout
      checkoutData={{} as CheckoutInput}
      onPaymentSuccess={jest.fn()}
      onPaymentError={jest.fn()}
    />
  );
  await act(async () =>
    root.render(
      emiEnabled === undefined ? (
        button
      ) : (
        <CheckoutFlagsProvider emiEnabled={emiEnabled}>
          {button}
        </CheckoutFlagsProvider>
      ),
    ),
  );
  await act(async () => container.querySelector("button")?.click());
  act(() => root.unmount());
  return (Razorpay.mock.calls as unknown as [Record<string, unknown>][])[0][0];
}

it("hides EMI when the flag is off or the provider is missing", async () => {
  const hidden = {
    display: expect.objectContaining({ hide: [{ method: "emi" }] }),
  };
  expect((await openedOptions()).config).toEqual(hidden);
  expect((await openedOptions(false)).config).toEqual(hidden);
  expect(await openedOptions(true)).not.toHaveProperty("config");
});
