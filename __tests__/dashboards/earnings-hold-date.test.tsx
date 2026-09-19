/**
 * #1675 item 4 — the consultant earnings table typed `holdUntil` but never
 * rendered it, so an earner could not see when a PENDING row would release.
 * Pins that a PENDING row renders "available on <date>".
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("../../lib/time/use-viewer-zone", () => ({
  useViewerZone: () => ({ zone: "Asia/Kolkata", own: true }),
}));
jest.mock("../../components/payouts/IndiaOnlyPayoutNotice", () => ({
  IndiaOnlyPayoutNotice: () => null,
}));

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { EarningsSummaryPanel } from "../../app/dashboard/consultant/[consultantId]/(features)/earnings/EarningsSummaryPanel";

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
  eligibility: { isEligible: false, readyAmount: 0, minimumAmount: 50000 },
  earnings: [
    {
      id: "earn_1",
      consultantSharePaise: 1000,
      platformFeePaise: 200,
      status: "PENDING",
      // A future hold (the panel hides one that has already matured).
      holdUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      createdAt: "2026-09-19T12:00:00.000Z",
      role: "OWNER",
      shareBps: 10000,
      payment: {
        id: "pay_1",
        amount: 1200,
        originalAmount: 1200,
        currency: "INR",
        createdAt: "2026-09-19T12:00:00.000Z",
        appointment: { id: "appt_1", appointmentType: "CONSULTATION" },
      },
      payout: null,
    },
  ],
  pagination: { total: 1, limit: 15, offset: 0, hasMore: false },
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
  // Let the query resolve and the table render.
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }

  expect(container.textContent).toMatch(/available on \d{1,2} \w{3} \d{4}/);
});
