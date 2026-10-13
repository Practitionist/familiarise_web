/**
 * Cancel on the pending-checkout page: an ALREADY_PAID 409 means the booking
 * is live, so the page says so and never navigates away as if it cancelled.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const push = jest.fn();
const refresh = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));

import React, { act } from "react";
import { createRoot } from "react-dom/client";

import { PendingCheckoutClient } from "../../app/checkout/pending/[paymentId]/PendingCheckoutClient";
import type { PendingCheckout } from "../../lib/data/pending-checkout";

const pending: PendingCheckout = {
  paymentId: "pay-1",
  status: "PENDING",
  planTitle: "Career chat",
  currency: "INR",
  basePaise: 10000,
  discountPaise: 0,
  discountCode: null,
  taxPaise: 1800,
  creditsPaise: 0,
  totalPaise: 11800,
  currentTotalPaise: 11800,
  quoteStaleReason: null,
  expiresAt: null,
  appointmentId: "appt-1",
  consulteeProfileId: "cp-1",
};

it("keeps the buyer on the page and says the payment went through on ALREADY_PAID", async () => {
  Object.assign(globalThis, {
    fetch: jest.fn(async () => ({
      ok: false,
      status: 409,
      json: async () => ({ error: "already paid", code: "ALREADY_PAID" }),
    })),
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(<PendingCheckoutClient pending={pending} />),
  );

  const cancel = [...host.querySelectorAll("button")].find(
    (b) => b.textContent === "Cancel",
  );
  await act(async () => cancel?.click());

  expect(push).not.toHaveBeenCalled();
  expect(refresh).toHaveBeenCalled();
  expect(host.textContent).toContain("already gone through");
  act(() => root.unmount());
});

it("renders Current total diff and advisory notice when quoteStaleReason is present", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <PendingCheckoutClient
        pending={{
          ...pending,
          totalPaise: 9440,
          currentTotalPaise: 11800,
          quoteStaleReason: "TAX_CHANGED",
        }}
      />,
    ),
  );

  expect(host.textContent).toContain("Current total");
  expect(host.textContent).toContain("Applicable tax changed");
  act(() => root.unmount());
});
