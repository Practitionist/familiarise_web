import * as React from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { CancelConfirmationDialog } from "../../components/appointments/consultee/CancelConfirmationDialog";
import { EXPERT_CANCEL_RELIABILITY_LINE } from "../../lib/booking/expert-reliability-rules";

const QUOTE = {
  refundPct: 100,
  estimatedRefundPaise: 120_000,
  grossPaise: 150_000,
  currency: "INR",
  hoursUntilNextSession: 48,
  prorated: true,
  fundingRail: "GATEWAY",
  expectedPaid: true,
};

function openAsConsultant() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CancelConfirmationDialog
        isOpen
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
        title="Cancel subscription?"
        consultant="Priya"
        appointmentType="Subscription"
        appointmentId="apt-1"
        viewerRole="consultant"
      />
    </QueryClientProvider>,
  );
}

const respond = (status: number, body: unknown) => {
  globalThis.fetch = jest.fn().mockResolvedValue({
    ok: status < 400,
    status,
    json: async () => body,
  }) as unknown as typeof fetch;
};

it("names the refund the click will pay, not the original charge", async () => {
  respond(200, QUOTE);
  openAsConsultant();
  const line = await screen.findByText(/gets a full refund of/);
  expect(line).toHaveTextContent("1,200");
  expect(line).not.toHaveTextContent("1,500");
  expect(screen.getByText(EXPERT_CANCEL_RELIABILITY_LINE)).toBeTruthy();
});

it("keeps the reliability warning when the quote cannot be loaded", async () => {
  respond(500, {});
  openAsConsultant();
  await screen.findByText(/If they paid, Priya gets a full refund/);
  expect(screen.getByText(EXPERT_CANCEL_RELIABILITY_LINE)).toBeTruthy();
});
