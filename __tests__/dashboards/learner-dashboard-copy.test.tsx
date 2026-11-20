/**
 * Learner dashboard copy: each screen states its state in proper sentences
 * and only promises what the server does.
 */

import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: null }),
}));
jest.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

import { PendingPaymentsWidget } from "@/app/dashboard/consultee/[consulteeId]/(features)/home/PendingPaymentsWidget";
import { ReferralsPage } from "@/components/dashboard/shared/ReferralsPage";
import { UnpaidRequestedBookingControls } from "@/app/dashboard/consultee/[consulteeId]/(features)/appointments/[appointmentId]/DetailPageClient";

function withClient(node: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{node}</QueryClientProvider>,
  );
}

describe("appointment detail: unpaid request banner", () => {
  it("reads as two sentences", () => {
    withClient(
      <UnpaidRequestedBookingControls appointmentId="appt-1" initialNotes="" />,
    );
    const banner = screen.getByTestId("unpaid-request-controls");
    expect(banner.textContent).toContain(
      "Unpaid booking request. You can edit your note before the expert responds.",
    );
  });
});

describe("Billing: Needs you rows", () => {
  const future = new Date(Date.now() + 20 * 60 * 1000).toISOString();
  const row = (over: Record<string, unknown>) => ({
    id: "pay-1",
    type: "consultation",
    title: "Career chat",
    consultantName: "Asha Rao",
    amount: 279_050,
    currency: "INR",
    paymentUrl: "",
    approvedAt: new Date().toISOString(),
    expiresAt: future,
    isExpiringSoon: false,
    ...over,
  });
  const renderWidget = (pendingPayments: unknown[]) => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    client.setQueryData(["pending-payments", "c-1"], {
      pendingPayments,
      lapsedPayLinks: [],
      failedRefunds: [],
    });
    return render(
      <QueryClientProvider client={client}>
        <PendingPaymentsWidget consulteeId="c-1" />
      </QueryClientProvider>,
    );
  };

  it("an open gateway order shows paise and reads Awaiting payment", () => {
    renderWidget([row({ source: "gateway_pending", referralCreditPaise: 0 })]);
    expect(screen.getByText("₹2,790.50")).toBeTruthy();
    expect(screen.getByText("Awaiting payment")).toBeTruthy();
    expect(screen.queryByText("Processing")).toBeNull();
  });

  it("an approved request's pay button names the amount in paise", () => {
    renderWidget([
      row({
        id: "cons-1",
        source: "approval_pending",
        paymentUrl: "/pay/pay-9",
        appointmentId: "appt-1",
      }),
    ]);
    expect(screen.getByRole("link", { name: "Pay ₹2,790.50" })).toBeTruthy();
  });

  /** The route as the dialog re-reads it when it opens. */
  const serveRows = (pendingPayments: unknown[]) => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ pendingPayments, lapsedPayLinks: [] }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  };

  it("the cancel dialog names the referral credit that goes back", async () => {
    const credited = row({
      source: "gateway_pending",
      referralCreditPaise: 20_000,
    });
    serveRows([credited]);
    renderWidget([credited]);
    fireEvent.click(screen.getByRole("button", { name: /Cancel/ }));
    expect(
      await screen.findByText(
        /Your ₹200\.00 referral credit goes back to your balance if it is still valid when you cancel\./,
      ),
    ).toBeTruthy();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Cancel booking" }),
      ).not.toBeDisabled(),
    );
  });

  it("the cancel dialog promises no credit when none was applied", async () => {
    const plain = row({ source: "gateway_pending", referralCreditPaise: 0 });
    serveRows([plain]);
    renderWidget([plain]);
    fireEvent.click(screen.getByRole("button", { name: /Cancel/ }));
    expect(
      await screen.findByText("Cancel this pending payment?"),
    ).toBeTruthy();
    expect(screen.queryByText(/referral credit/)).toBeNull();
  });

  it("the cancel dialog re-reads the order on open and drops credit a replacement order does not hold", async () => {
    const fetchMock = serveRows([
      row({ source: "gateway_pending", referralCreditPaise: 0 }),
    ]);
    renderWidget([
      row({ source: "gateway_pending", referralCreditPaise: 20_000 }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: /Cancel/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByText(/referral credit/)).toBeNull(),
    );
    expect(
      screen.getByRole("button", { name: "Cancel booking" }),
    ).not.toBeDisabled();
  });
});

describe("Referrals: a programme taking no new referrals", () => {
  it("says so in plain words, outside the green offer box, whether it is not open yet, paused or out of budget", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    client.setQueryData(["referral-code"], {
      data: {
        id: "rc-1",
        code: "ASHA10",
        customCode: null,
        totalReferrals: 0,
        successfulReferrals: 0,
        totalEarned: 0,
        isActive: true,
        maxReferrals: 50,
      },
      terms: null,
      feeWaivers: [],
    });
    client.setQueryData(["referrals"], { data: [] });
    client.setQueryData(["referral-credits"], {
      data: { totalAvailable: 0, history: [] },
    });
    render(
      <QueryClientProvider client={client}>
        <ReferralsPage role="CONSULTEE" />
      </QueryClientProvider>,
    );
    const text = document.body.textContent ?? "";
    expect(text).toContain(
      "The referral programme is not taking new referrals right now. A friend who signs up now gets no welcome discount, and the sign-up is not counted as your referral.",
    );
    expect(text).not.toMatch(/paused|reopens|resume|earn you nothing/);
    const box = screen.getByTestId("referral-offer");
    expect(box.className).not.toMatch(/emerald/);
  });
});
