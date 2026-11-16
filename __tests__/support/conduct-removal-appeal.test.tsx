/**
 * @jest-environment jsdom
 */
/** An overturned removal went the learner's way: no appeal link, deadline or anchor anywhere on the case page. */
import * as React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ResolvedFollowUp } from "@/components/dashboard/shared/support/ResolvedFollowUp";
import { CustomerCaseResolution } from "@/components/support/resolution/CustomerCaseResolution";

const appealUntil = new Date(Date.now() + 5 * 86_400_000).toISOString();
/** The payload GET /api/support/cases/[caseId]/actions answers a learner with. */
const resolution = (outcome: "OVERTURNED" | "UPHELD") => ({
  data: {
    decisions: [
      {
        id: "d-1",
        outcome,
        explanation: "The recording settles it.",
        privateRationale: null,
        createdAt: new Date().toISOString(),
        appealUntil,
        supersedesDecisionId: null,
      },
    ],
    recommendations: [],
    holds: [],
    evidenceRequests: [],
    recipients: [],
    canManage: false,
    canExecuteMoney: false,
    canManageHolds: false,
    canVoidRecommendations: false,
    refundLimitPaise: null,
    planRefund: null,
    ownershipScope: "PERSONAL",
    updatedAt: new Date().toISOString(),
    caseKind: "INCIDENT",
    isAppeal: false,
    reviewsRemoval: true,
    legalHoldAt: null,
    isAdmin: false,
  },
});

function renderPage(outcome: "OVERTURNED" | "UPHELD") {
  globalThis.fetch = jest.fn(async () => ({
    ok: true,
    json: async () => resolution(outcome),
  })) as unknown as typeof fetch;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <CustomerCaseResolution caseId="case-1" />
      <ResolvedFollowUp
        caseId="case-1"
        resolvedAt={new Date().toISOString()}
        disabled={false}
        onReopen={() => undefined}
      />
    </QueryClientProvider>,
  );
}

it("shows no appeal of an overturned removal", async () => {
  renderPage("OVERTURNED");
  await screen.findByText(/not given back/);
  expect(screen.queryByText(/Appeal by/)).toBeNull();
  expect(screen.queryByText(/You can appeal until/)).toBeNull();
  expect(
    document.querySelector('a[href="#support-case-resolution"]'),
  ).toBeNull();
});

it("still offers the appeal of an upheld removal", async () => {
  renderPage("UPHELD");
  await waitFor(() => expect(screen.getByText(/Appeal by/)).toBeTruthy());
});
