/**
 * Closing the Razorpay sheet on a fresh checkout offers "Cancel checkout",
 * which releases the hold through DELETE /api/checkout/pending/[paymentId]; a
 * pay-link order (minted elsewhere) is never offered it.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mockToast = jest.fn();
jest.mock("../../hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));
jest.mock("../../app/checkout/plans/utils", () => ({
  loadScript: jest.fn(async () => true),
  busyRetryToast: jest.fn(),
  checkoutNeedsGateway: () => true,
  fetchCheckoutWithBusyRetry: (call: () => Promise<unknown>) => call(),
  useCheckoutAttemptKey: () => () => "idem_1",
  reportPaymentsError: jest.fn(),
}));
jest.mock("../../lib/auth-client", () => ({
  useSession: () => ({ data: null }),
}));

import React, { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import RazorpayCheckout from "../../app/checkout/components/RazorpayCheckout";
import type { CheckoutInput } from "../../schemas/checkout";

type SheetOptions = { modal?: { ondismiss?: () => void } };

async function openAndDismiss(
  props: Partial<React.ComponentProps<typeof RazorpayCheckout>>,
) {
  const Razorpay = jest.fn(() => ({ on: jest.fn(), open: jest.fn() }));
  Object.assign(window, { Razorpay });
  process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = "rzp_test_key";
  const fetchMock = jest.fn(async (url: string) => ({
    ok: true,
    json: async () =>
      url === "/api/checkout"
        ? {
            success: true,
            paymentId: "pay-1",
            paymentIntent: { id: "order_1", amount: 500000, currency: "INR" },
          }
        : {},
  }));
  global.fetch = fetchMock as unknown as typeof fetch;

  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <RazorpayCheckout
        {...(props as React.ComponentProps<typeof RazorpayCheckout>)}
        onPaymentSuccess={jest.fn()}
        onPaymentError={jest.fn()}
      />,
    ),
  );
  await act(async () => container.querySelector("button")?.click());
  const options = (Razorpay.mock.calls as unknown as [SheetOptions][])[0][0];
  act(() => options.modal?.ondismiss?.());
  act(() => root.unmount());
  const dismissToast = mockToast.mock.calls.at(-1)?.[0] as {
    action?: ReactElement<{ onClick: () => void }>;
  };
  return { dismissToast, fetchMock };
}

beforeEach(() => mockToast.mockReset());

it("offers to cancel a fresh checkout and releases its own payment's hold", async () => {
  const { dismissToast, fetchMock } = await openAndDismiss({
    checkoutData: {} as CheckoutInput,
  });

  expect(dismissToast.action).toBeDefined();
  await act(async () => dismissToast.action?.props.onClick());
  expect(fetchMock).toHaveBeenCalledWith("/api/checkout/pending/pay-1", {
    method: "DELETE",
  });
});

it("tells the buyer when the cancel request itself fails", async () => {
  const { dismissToast, fetchMock } = await openAndDismiss({
    checkoutData: {} as CheckoutInput,
  });
  fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));

  await act(async () => dismissToast.action?.props.onClick());

  expect(mockToast.mock.calls.at(-1)?.[0]).toMatchObject({
    title: "Couldn't cancel the checkout",
    variant: "destructive",
  });
});

it("never offers to cancel a pay-link order minted elsewhere", async () => {
  const { dismissToast } = await openAndDismiss({
    existingOrder: {
      orderId: "order_link",
      paymentId: "pay-link",
      amount: 500000,
      currency: "INR",
    },
  });

  expect(dismissToast.action).toBeUndefined();
});

it("shows the button busy from the click and ignores a second press while the pre-check runs", async () => {
  let release: (ok: boolean) => void = () => undefined;
  const onBeforeCheckout = jest.fn(
    () => new Promise<boolean>((resolve) => (release = resolve)),
  );
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <RazorpayCheckout
        checkoutData={{} as CheckoutInput}
        onBeforeCheckout={onBeforeCheckout}
        onPaymentSuccess={jest.fn()}
        onPaymentError={jest.fn()}
      />,
    ),
  );
  const button = container.querySelector("button")!;
  await act(async () => button.click());
  await act(async () => button.click());
  expect(button.textContent).toBe("Processing...");
  expect(onBeforeCheckout).toHaveBeenCalledTimes(1);
  await act(async () => release(false));
  expect(button.textContent).toBe("Pay with Razorpay");
  act(() => root.unmount());
});

it("passes a resumed order's amount and currency to the price-change notice, opening nothing", async () => {
  const Razorpay = jest.fn();
  Object.assign(window, { Razorpay });
  global.fetch = jest.fn(async () => ({
    ok: true,
    json: async () => ({
      success: true,
      reused: true,
      paymentId: "pay-1",
      paymentIntent: { id: "order_1", client_secret: null },
      amount: 117941,
      currency: "INR",
    }),
  })) as unknown as typeof fetch;
  const onPaidWhenFree = jest.fn();
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <RazorpayCheckout
        checkoutData={{} as CheckoutInput}
        onPaymentSuccess={jest.fn()}
        onPaymentError={jest.fn()}
        onPaidWhenFree={onPaidWhenFree}
        label="Confirm booking"
      />,
    ),
  );
  await act(async () => container.querySelector("button")?.click());
  expect(onPaidWhenFree).toHaveBeenCalledWith({
    amount: 117941,
    currency: "INR",
  });
  expect(Razorpay).not.toHaveBeenCalled();
  act(() => root.unmount());
});
