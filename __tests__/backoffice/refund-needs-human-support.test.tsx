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
