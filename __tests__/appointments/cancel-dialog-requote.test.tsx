import * as React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { CancelConfirmationDialog } from "../../components/appointments/consultee/CancelConfirmationDialog";
import {
  applyRefundRequote,
  cancelPreviewUrl,
  readRefundQuoteChanged,
  refundChangedToast,
} from "../../lib/appointments/cancel-requote";

const QUOTE = {
  refundPct: 100,
  estimatedRefundPaise: 150_000,
  currency: "INR",
  hoursUntilNextSession: 48,
  prorated: false,
  fundingRail: "GATEWAY",
  creditRestoresInFull: false,
  expectedPaid: true,
};

function renderDialog(queryClient: QueryClient, onConfirm: jest.Mock) {
  const onCancel = jest.fn();
  globalThis.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => QUOTE,
  }) as unknown as typeof fetch;
  render(
    <QueryClientProvider client={queryClient}>
      <CancelConfirmationDialog
        isOpen
        onConfirm={onConfirm}
        onCancel={onCancel}
        title="Intro call"
        consultant="Priya"
        appointmentType="Consultation"
        appointmentId="apt-1"
      />
    </QueryClientProvider>,
  );
  return { onCancel };
}

describe("a re-quoted cancel keeps the dialog open on the new amount", () => {
  it("confirming does not close the dialog before the answer returns", async () => {
    const onConfirm = jest.fn();
    const { onCancel } = renderDialog(new QueryClient(), onConfirm);
    const confirm = await screen.findByRole("button", {
      name: "Cancel booking",
    });
    await screen.findByText(/₹1,500/);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ estimatedRefundPaise: 150_000 }),
    );
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("names the new refund once the server re-quotes it", async () => {
    const queryClient = new QueryClient();
    renderDialog(queryClient, jest.fn());
    await screen.findByText(/₹1,500/);
    act(() => {
      applyRefundRequote(queryClient, cancelPreviewUrl("apt-1"), {
        code: "REFUND_QUOTE_CHANGED",
        refundPaise: 75_000,
        refundPct: 50,
        creditRestoresInFull: false,
      });
    });
    expect(
      await screen.findByText(
        /The refund changed while this was open\. It is now ₹750\.00\./,
      ),
    ).toBeInTheDocument();
  });
});

describe("the re-quote reader and toast", () => {
  it("reads the trial door's body, which nests the quote", () => {
    expect(
      readRefundQuoteChanged({
        code: "REFUND_QUOTE_CHANGED",
        error: "The refund for this trial has changed.",
        quote: {
          estimatedRefundPaise: 40_000,
          refundPct: 50,
          creditRestoresInFull: false,
          currency: "INR",
        },
      }),
    ).toEqual({
      code: "REFUND_QUOTE_CHANGED",
      refundPaise: 40_000,
      refundPct: 50,
      creditRestoresInFull: false,
    });
  });

  it("puts the new amount in the toast", () => {
    expect(
      refundChangedToast(
        {
          code: "REFUND_QUOTE_CHANGED",
          refundPaise: 75_000,
          refundPct: 50,
          creditRestoresInFull: false,
        },
        "INR",
      ),
    ).toEqual({
      title: "The refund has changed",
      description:
        "It is now ₹750.00. Check it in the dialog and confirm again.",
    });
  });
});
