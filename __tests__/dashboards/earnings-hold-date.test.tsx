/**
 * #1675 item 4 — the consultant earnings list typed `holdUntil` but never
 * rendered it, so an earner could not see when a PENDING row would release.
 * Pins, through the query container, that a PENDING row renders
 * "available on <date>" from `earnings-state.ts` rather than an inline rule.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("../../components/payouts/IndiaOnlyPayoutNotice", () => ({
  IndiaOnlyPayoutNotice: () => null,
}));

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { EarningsSummaryPanel } from "../../app/dashboard/consultant/[consultantId]/(features)/earnings/EarningsSummaryPanel";

const AT = "2026-09-19T12:00:00.000Z";

const response = {
  summary: {
    consultantProfileId: "cp_1",
    totalEarnings: 1000,
    pendingEarnings: 1000,
    readyEarnings: 0,
    batchedEarnings: 0,
    paidEarnings: 0,
    heldEarnings: 0,
    pendingTrustEarnings: 0,
  },
  eligibility: {
    consultantProfileId: "cp_1",
    isEligible: false,
    readyAmount: 0,
    minimumAmount: 50000,
    hasPayoutAccount: true,
  },
  earnings: [
    {
      id: "earn_1",
      consultantProfileId: "cp_1",
      paymentId: "pay_1",
      payoutId: null,
      grossAmount: 1200,
      platformFeePaise: 200,
      consultantSharePaise: 1000,
      refundedShareAmount: 0,
      gstTcsAccruedPaise: null,
      role: "OWNER",
      shareBps: 10000,
      appointmentOccurrenceId: null,
      status: "PENDING",
      // A future hold; a matured one reads "releasing shortly".
      holdUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      paidAt: null,
      preDisputeStatus: null,
      currency: "INR",
      createdAt: AT,
      updatedAt: AT,
      title: "Career coaching",
      sponsorOrgName: null,
      payment: {
        id: "pay_1",
        amount: 1200,
        originalAmount: 1200,
        currency: "INR",
        createdAt: AT,
        paymentMethod: "CARD",
        organizationId: null,
        organization: null,
        legs: [],
        appointment: { id: "appt_1", appointmentType: "CONSULTATION" },
      },
      payout: null,
    },
  ],
  payouts: [],
  pagination: { total: 1, limit: 200, offset: 0, hasMore: false },
  livePayoutsEnabled: false,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => response,
  }) as unknown as typeof fetch;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (global as { fetch?: unknown }).fetch;
});

it("renders the hold date on a PENDING row", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <EarningsSummaryPanel consultantId="c_1" />
      </QueryClientProvider>,
    );
  });
  // Let the query resolve and the list render.
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }

  const pending = Array.from(container.querySelectorAll("button")).find((b) =>
    b.textContent?.startsWith("Pending"),
  );
  expect(pending).toBeDefined();
  await act(async () => {
    pending!.click();
  });

  expect(container.textContent).toMatch(/available on \d{1,2} \w{3}/);
  expect(container.textContent).not.toMatch(/PENDING/);
});
