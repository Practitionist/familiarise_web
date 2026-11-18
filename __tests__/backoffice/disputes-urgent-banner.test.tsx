import * as React from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let mockCanManage = true;
jest.mock(
  "../../components/dashboard/backoffice/BackofficeCapabilityProvider",
  () => ({
    useBackofficeCapability: () => ({
      basePath: "/dashboard/staff",
      can: (surface: string) =>
        surface === "disputes.manage" ? mockCanManage : false,
    }),
  }),
);
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/dashboard/staff/disputes",
  useSearchParams: () => new URLSearchParams(),
}));

import { DisputesPage } from "../../components/dashboard/shared/DisputesPage";

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

function renderPage() {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      disputes: [],
      total: 0,
      page: 1,
      limit: 20,
      totalPages: 0,
      urgentDisputes: 2,
      stats: { underReviewCount: 0, wonCount: 0 },
    }),
  });
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <DisputesPage apiEndpoint="/api/staff/disputes" />
    </QueryClientProvider>,
  );
}

describe("DisputesPage urgent banner", () => {
  it("tells a viewer who can manage disputes to submit evidence", async () => {
    mockCanManage = true;
    renderPage();
    expect(
      await screen.findByText(/Submit evidence before the deadline\./),
    ).toBeInTheDocument();
    expect(screen.queryByText(/escalate/i)).not.toBeInTheDocument();
  });

  it("tells a viewer who cannot to escalate to an admin", async () => {
    mockCanManage = false;
    renderPage();
    expect(await screen.findByText(/escalate to an admin/)).toBeInTheDocument();
  });
});
