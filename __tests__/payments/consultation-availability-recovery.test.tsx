jest.mock("../../hooks/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));
jest.mock("../../lib/auth-client", () => ({
  useSession: () => ({ data: null }),
}));
jest.mock("../../app/checkout/plans/utils", () => ({
  loadScript: jest.fn(async () => true),
  busyRetryToast: jest.fn(),
  checkoutNeedsGateway: () => true,
  fetchCheckoutWithBusyRetry: (attempt: () => Promise<unknown>) => attempt(),
  mintClientIdempotencyKey: () => "stable-key",
  reportPaymentsError: jest.fn(),
}));
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import RazorpayCheckout from "@/app/checkout/components/RazorpayCheckout";
import { AvailabilityRecovery } from "@/app/checkout/components/AvailabilityRecovery";
import {
  consultationRecoveryHref,
  isAvailabilityRefusal,
} from "@/lib/booking/checkout-recovery";
import type { CheckoutInput } from "@/schemas/checkout";

function Harness() {
  const [refusal, setRefusal] = useState<{ notCharged: boolean } | null>(null);
  return (
    <>
      {refusal && (
        <AvailabilityRecovery
          href={consultationRecoveryHref("expert", "plan")}
          notCharged={refusal.notCharged}
        />
      )}
      <RazorpayCheckout
        checkoutData={
          {
            appointmentType: "CONSULTATION",
            planId: "plan",
            paymentGateway: "RAZORPAY",
          } as CheckoutInput
        }
        disabled={!!refusal}
        onPaymentSuccess={jest.fn()}
        onPaymentError={(error) => {
          if (isAvailabilityRefusal({ errorType: error.code }))
            setRefusal({ notCharged: error.yourCardWasNotCharged === true });
        }}
      />
    </>
  );
}
it.each([true, false])(
  "a gateway checkout refusal offers reselection, never opens payment, and respects the not-charged flag (%s)",
  async (notCharged) => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const originalFetch = global.fetch;
    const gateway = jest.fn();
    Object.assign(window, { Razorpay: gateway });
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 409,
      json: async () => ({
        error: "This slot was taken",
        errorType: "AVAILABILITY_ERROR",
        yourCardWasNotCharged: notCharged,
      }),
    })) as unknown as typeof fetch;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Harness />));
      await act(async () => container.querySelector("button")!.click());
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "Your plan choice is saved",
      );
      expect(container.querySelector("a")?.getAttribute("href")).toBe(
        "/explore/experts/expert?plan=plan&action=book&conflict=1",
      );
      expect(container.querySelector("button")?.disabled).toBe(true);
      expect(
        container.textContent?.includes("Your card has not been charged"),
      ).toBe(notCharged);
      expect(gateway).not.toHaveBeenCalled();
      expect(global.fetch).toHaveBeenCalledTimes(1);
      await act(async () => container.querySelector("button")!.click());
      expect(global.fetch).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
      container.remove();
      global.fetch = originalFetch;
    }
  },
);
