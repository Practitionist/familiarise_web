import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock(
  "../../components/dashboard/backoffice/BackofficeCapabilityProvider",
  () => ({
    useBackofficeCapability: () => ({
      basePath: "/dashboard/admin",
      can: () => true,
    }),
  }),
);
jest.mock(
  "../../components/dashboard/backoffice/money/BookingOpsPanel",
  () => ({ BookingOpsPanel: () => null }),
);
jest.mock("../../hooks/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));
const mockFetchWithReauth = jest.fn();
jest.mock("../../lib/auth/reauth-client", () => ({
  fetchWithReauth: (...args: unknown[]) => mockFetchWithReauth(...args),
}));

import { SubscriptionsPage } from "../../components/dashboard/shared/SubscriptionsPage";

const APPT = "8b2f6c1e-1d2a-4f3b-9c4d-5e6f7a8b9c0d";

function row(appointmentId: string | null) {
  return {
    id: "pay-1",
    paymentId: "pay-1",
    amount: 500_000,
    currency: "INR",
    gateway: "RAZORPAY",
    userName: "Learner",
    userEmail: "learner@example.com",
    consultantName: "Expert",
    startDate: null,
    endDate: null,
    status: "active",
    createdAt: "2026-10-01T00:00:00Z",
    subscriptionId: "sub-1",
    appointmentId,
  };
}

const QUOTE = {
  refundPct: 100,
  estimatedRefundPaise: 400_000,
  currency: "INR",
  hoursUntilNextSession: 72,
  prorated: true,
  fundingRail: "GATEWAY",
};

const originalFetch = global.fetch;
function serve(appointmentId: string | null) {
  global.fetch = jest.fn().mockImplementation(async (url: string) => ({
    ok: true,
    json: async () =>
      url.endsWith("/cancel/preview")
        ? QUOTE
        : {
            subscriptions: [row(appointmentId)],
            stats: { activeCount: 1, expiringCount: 0, expiredCount: 0 },
            pagination: { total: 1, limit: 20, offset: 0, hasMore: false },
          },
  }));
}

async function cancelWithReason(confirm: string) {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <SubscriptionsPage />
    </QueryClientProvider>,
  );
  fireEvent.click(
    (await screen.findAllByRole("button", { name: "Inspect" }))[0],
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Cancel Subscription" }),
  );
  fireEvent.change(
    await screen.findByLabelText("Reason (kept in the audit log)"),
    { target: { value: "Learner asked for it" } },
  );
  const button = await screen.findByRole("button", { name: confirm });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await waitFor(() => expect(mockFetchWithReauth).toHaveBeenCalled());
  const [url, init] = mockFetchWithReauth.mock.calls[0] as [
    string,
    { body: string },
  ];
  return { url, body: JSON.parse(init.body) as Record<string, unknown> };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFetchWithReauth.mockResolvedValue({ ok: true, json: async () => ({}) });
});
afterEach(() => {
  global.fetch = originalFetch;
});

describe("SubscriptionsPage operator cancel", () => {
  it("cancels a booked subscription through the staff cancel door, with the quote and a reason", async () => {
    serve(APPT);
    const { url, body } = await cancelWithReason("Cancel booking");
    expect(url).toBe(`/api/staff/appointments/${APPT}/cancel`);
    expect(body).toEqual({
      cancellationReason: "OTHER",
      expectedRefundPaise: 400_000,
      reason: "Learner asked for it",
    });
    const plainCalls = (global.fetch as jest.Mock).mock.calls.map(
      ([u]) => u as string,
    );
    expect(plainCalls).not.toContain(`/api/appointments/${APPT}/cancel`);
  });

  it("marks a subscription with no booking cancelled through the audited admin door", async () => {
    serve(null);
    const { url, body } = await cancelWithReason("Cancel subscription");
    expect(url).toBe("/api/admin/subscriptions");
    expect(body).toEqual({
      subscriptionId: "sub-1",
      action: "CANCEL",
      reason: "Learner asked for it",
    });
  });
});
