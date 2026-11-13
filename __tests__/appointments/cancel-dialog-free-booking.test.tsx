import * as React from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { CancelConfirmationDialog } from "../../components/appointments/consultee/CancelConfirmationDialog";

const QUOTE = {
  refundPct: 100,
  estimatedRefundPaise: 0,
  currency: "INR",
  hoursUntilNextSession: 48,
  prorated: false,
  fundingRail: "CREDITS",
  creditRestoresInFull: true,
  expectedPaid: true,
};

function open(quote: unknown) {
  globalThis.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => quote,
  }) as unknown as typeof fetch;
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CancelConfirmationDialog
        isOpen
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
        title="Intro call"
        consultant="Priya"
        appointmentType="Consultation"
        appointmentId="apt-1"
      />
    </QueryClientProvider>,
  );
}

it("describes a free booking as free, with no credit or payer sentence", async () => {
  open({ ...QUOTE, freeBooking: true });
  await screen.findByText(/there is nothing to refund/);
  expect(screen.queryByText(/referral credit/i)).toBeNull();
  expect(screen.queryByText(/Paid by you/)).toBeNull();
});

it("keeps the credit wording when referral credit paid for the booking", async () => {
  open({ ...QUOTE, freeBooking: false });
  await screen.findByText(/You paid with referral credits/);
  expect(screen.getByText(/Paid by you/)).toBeInTheDocument();
});
