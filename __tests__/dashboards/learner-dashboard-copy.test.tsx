/**
 * Learner dashboard copy: each screen states its state in proper sentences
 * and only promises what the server does.
 */

import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
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

  it("the cancel dialog names the referral credit that goes back", () => {
    renderWidget([
      row({ source: "gateway_pending", referralCreditPaise: 20_000 }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: /Cancel/ }));
    expect(
      screen.getByText(
        /Your ₹200\.00 referral credit goes back to your balance\./,
      ),
    ).toBeTruthy();
  });

  it("the cancel dialog promises no credit when none was applied", () => {
    renderWidget([row({ source: "gateway_pending", referralCreditPaise: 0 })]);
    fireEvent.click(screen.getByRole("button", { name: /Cancel/ }));
    expect(screen.getByText("Cancel this pending payment?")).toBeTruthy();
    expect(screen.queryByText(/referral credit/)).toBeNull();
  });
});

describe("Referrals: a programme taking no new referrals", () => {
  it("says so in words true whether it is not open yet, paused or out of budget", () => {
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
      "The referral programme is not taking new referrals right now.",
    );
    expect(text).not.toMatch(/paused|reopens|resume/);
  });
});
