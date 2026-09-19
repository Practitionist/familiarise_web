/**
 * QA #1741 case 8 — /checkout/checkout-success exhausted its back-off and
 * rendered "Payment Verification Failed" for a payment that was merely still
 * PENDING (every verify answered 400), the exact state the page's own comment
 * says must never read as a failure. The terminal state for a PENDING poll is
 * the "still confirming" card; the failure card is reserved for an explicit
 * FAILED/EXPIRED answer.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const push = jest.fn();
// Stable identities: the page's effect lists `router` in its deps, so a fresh
// object per render would restart the poll on every render.
const router = { push };
const searchParams = new URLSearchParams("payment_intent=order_1");
jest.mock("next/navigation", () => ({
  useRouter: () => router,
  useSearchParams: () => searchParams,
}));
jest.mock("../../app/checkout/CheckoutSkeletons", () => ({
  CheckoutResultSkeleton: () => <div data-testid="skeleton" />,
}));
jest.mock("../../app/checkout/plans/utils", () => ({
  reportPaymentsError: jest.fn(),
}));

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import CheckoutSuccessPage from "../../app/checkout/checkout-success/page";

let container: HTMLDivElement;
let root: Root;

function verifyAnswer(status: number, body: Record<string, unknown>) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  };
}

/** Let the effect's fetch settle, then advance past the next back-off step. */
async function step(ms: number) {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  push.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (global as { fetch?: unknown }).fetch;
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe("checkout-success terminal states", () => {
  it("stays on the still-confirming card after nine PENDING 400s, never the failure card", async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      verifyAnswer(400, {
        error: "Payment not completed",
        status: "PENDING",
      }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await act(async () => {
      root.render(<CheckoutSuccessPage />);
    });
    // The nine back-off waits; a generous step each so every timer fires.
    for (let i = 0; i < 10; i++) await step(20_000);

    expect(fetchMock).toHaveBeenCalledTimes(10);
    expect(
      container.querySelector('[data-testid="checkout-still-confirming"]'),
    ).not.toBeNull();
    expect(container.textContent).not.toContain("Payment Verification Failed");
    expect(container.textContent).toContain("Retry now");
    expect(push).not.toHaveBeenCalled();
  });

  it("renders the failure card only for an explicit FAILED answer", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        verifyAnswer(400, { error: "Payment not completed", status: "FAILED" }),
      ) as unknown as typeof fetch;

    await act(async () => {
      root.render(<CheckoutSuccessPage />);
    });
    await step(0);

    expect(container.textContent).toContain("Payment Verification Failed");
  });

  // #1586 P1-J08 — the SUBSCRIPTION card headlined "Activated!" over a
  // request the consultant had not approved.
  it("never says Activated for a PENDING_APPROVAL subscription", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      verifyAnswer(200, {
        appointmentType: "SUBSCRIPTION",
        status: "SUCCEEDED",
        bookingState: "PENDING_APPROVAL",
      }),
    ) as unknown as typeof fetch;

    await act(async () => {
      root.render(<CheckoutSuccessPage />);
    });
    await step(0);

    expect(container.textContent).toContain("awaiting consultant approval");
    expect(container.textContent).not.toContain("Activated");
  });

  // #1586 P1-J32 — a typed 500 is the route failing, not the payment.
  it("keeps the confirming card on a VERIFICATION_FAILED 500", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      verifyAnswer(500, {
        error: "Internal server error",
        errorType: "VERIFICATION_FAILED",
      }),
    ) as unknown as typeof fetch;

    await act(async () => {
      root.render(<CheckoutSuccessPage />);
    });
    for (let i = 0; i < 10; i++) await step(20_000);

    expect(push).not.toHaveBeenCalledWith("/checkout/checkout-failure");
    expect(
      container.querySelector('[data-testid="checkout-still-confirming"]'),
    ).not.toBeNull();
  });
});
