import * as React from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ tree: "admin" }),
}));
jest.mock(
  "../../components/dashboard/backoffice/money/RefundDoorDialog",
  () => ({
    RefundDoorDialog: () => null,
  }),
);

import { RefundDoorsPanel } from "../../components/dashboard/backoffice/money/RefundsTab";

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

it("lists an unsent support refund and links its case instead of a refund door", async () => {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      items: [
        {
          id: "rec_1",
          message:
            "Support case SR-2026-0042: an approved refund of ₹3000.00 failed. Retry or void it on the case.",
          createdAt: "2026-10-20T12:00:00.000Z",
          paymentId: "pay_1",
          occurrenceId: null,
          unitPaise: null,
          kind: "support-recommendation",
          caseId: "case_1",
        },
      ],
    }),
  });
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RefundDoorsPanel />
    </QueryClientProvider>,
  );
  expect(
    await screen.findByText(/SR-2026-0042: an approved refund/),
  ).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Open case" })).toHaveAttribute(
    "href",
    "/dashboard/admin/support/c_case_1",
  );
  expect(
    screen.queryByRole("button", { name: "Return credits" }),
  ).not.toBeInTheDocument();
});

it("keeps a session-count remedy's record refs in its details, not its message", async () => {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      items: [
        {
          id: "rec_2",
          message:
            "Support case SR-2026-0043: an approved refund of ₹1800.00 failed. Retry or void it on the case. The plan end is waiting for this refund: retry it or void it.",
          createdAt: "2026-10-20T12:00:00.000Z",
          paymentId: "pay_2",
          kind: "support-recommendation",
          caseId: "case_2",
          details: "Plan sub_2 · refund rec_2",
        },
      ],
    }),
  });
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RefundDoorsPanel />
    </QueryClientProvider>,
  );
  expect(
    await screen.findByText(/The plan end is waiting for this refund/),
  ).toBeInTheDocument();
  expect(screen.getByText("Details")).toBeInTheDocument();
  expect(screen.getByText("Plan sub_2 · refund rec_2")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Open case" })).toHaveAttribute(
    "href",
    "/dashboard/admin/support/c_case_2",
  );
});
