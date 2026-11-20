import * as React from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { BookingOpsView } from "../../lib/backoffice/booking-ops-types";

jest.mock(
  "../../components/dashboard/backoffice/BackofficeCapabilityProvider",
  () => ({
    useBackofficeCapability: () => ({
      basePath: "/dashboard/staff",
      can: () => true,
    }),
  }),
);
jest.mock(
  "../../components/dashboard/backoffice/money/BookingDocumentsOps",
  () => ({ BookingDocumentsOps: () => null }),
);
jest.mock(
  "../../components/dashboard/backoffice/money/ClassSeriesDoors",
  () => ({ ClassSeriesDoors: () => null }),
);
jest.mock("../../hooks/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));
jest.mock("../../lib/auth/reauth-client", () => ({
  fetchWithReauth: jest.fn(),
}));

import { BookingOpsPanel } from "../../components/dashboard/backoffice/money/BookingOpsPanel";

const APPT = "8b2f6c1e-1d2a-4f3b-9c4d-5e6f7a8b9c0d";

type Pay = BookingOpsView["payments"][number];

function pay(overrides: Partial<Pay>): Pay {
  return {
    id: "pay-1",
    status: "SUCCEEDED",
    amountPaise: 100_000,
    currency: "INR",
    refundedPaise: 0,
    pendingRefundPaise: 0,
    refundable: true,
    ...overrides,
  };
}

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

async function renderWith(payment: Pay) {
  const view: BookingOpsView = {
    appointmentId: APPT,
    type: "CONSULTATION",
    classId: null,
    subscriptionId: null,
    sessions: [],
    payments: [payment],
    removedSeats: [],
  };
  global.fetch = jest
    .fn()
    .mockResolvedValue({ ok: true, json: async () => view });
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <BookingOpsPanel appointmentId={APPT} />
    </QueryClientProvider>,
  );
  await screen.findAllByText(/₹/);
}

describe("BookingOpsPanel refund door", () => {
  it("offers a refund on a payment the server marks refundable", async () => {
    await renderWith(
      pay({ refundedPaise: 20_000, pendingRefundPaise: 10_000 }),
    );
    expect(
      screen.getByRole("link", { name: "Issue refund" }),
    ).toBeInTheDocument();
  });

  it.each([
    ["free ₹0 seat", pay({ amountPaise: 0, refundable: false })],
    ["restored credits booking", pay({ amountPaise: 0, refundable: false })],
    ["disputed card payment", pay({ refundable: false })],
  ])("hides the refund door on a %s", async (_, payment) => {
    await renderWith(payment);
    expect(
      screen.queryByRole("link", { name: "Issue refund" }),
    ).not.toBeInTheDocument();
  });
});
