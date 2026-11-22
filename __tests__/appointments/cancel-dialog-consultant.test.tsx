import * as React from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { CancelConfirmationDialog } from "../../components/appointments/consultee/CancelConfirmationDialog";
import { EXPERT_CANCEL_RELIABILITY_LINE } from "../../lib/booking/expert-reliability-rules";
import { FREE_BOOKING_REFUND_LINE } from "../../lib/appointments/payment-display";

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

function openAsLearner(previewUrl?: string) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CancelConfirmationDialog
        isOpen
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
        title="Plan"
        consultant="Priya"
        appointmentType={previewUrl ? "Trial" : "Consultation"}
        appointmentId="apt-1"
        previewUrl={previewUrl}
      />
    </QueryClientProvider>,
  );
}

it("tells a learner cancelling an unpaid hold that nothing was paid, never 'Paid by you'", async () => {
  respond(200, {
    ...QUOTE,
    estimatedRefundPaise: 0,
    grossPaise: undefined,
    expectedPaid: false,
  });
  openAsLearner();
  await screen.findByText(FREE_BOOKING_REFUND_LINE);
  expect(screen.queryByText(/Paid by you/)).toBeNull();
});

it("reads a free trial's answer as nothing to refund", async () => {
  respond(200, { paid: false });
  openAsLearner("/api/trials/t-1/cancel/preview");
  expect(await screen.findByText(FREE_BOOKING_REFUND_LINE)).toBeTruthy();
  expect(screen.queryByText(/couldn't load the refund estimate/)).toBeNull();
});

it("names the plan, not a placeholder audience, when a host cancels a group session", async () => {
  respond(500, {});
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CancelConfirmationDialog
        isOpen
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
        title="System Design Cohort"
        consultant={null}
        appointmentType="Class"
        appointmentId="apt-1"
        viewerRole="consultant"
      />
    </QueryClientProvider>,
  );
  const refundLine = await screen.findByText(
    /Everyone who paid is refunded what they're owed/,
  );
  expect(refundLine).toHaveTextContent(
    "Everyone who paid is refunded what they're owed. Anyone who already had sessions is settled by our team.",
  );
  expect(screen.queryByText(/gets a full refund/)).toBeNull();
  const question = screen.getByText(/Are you sure you want to cancel/);
  expect(question).toHaveTextContent(
    'Are you sure you want to cancel "System Design Cohort"?',
  );
  expect(screen.queryByText(/Enrolled learners/)).toBeNull();
});
