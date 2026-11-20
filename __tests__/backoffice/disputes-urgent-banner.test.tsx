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

type Evidence = {
  open: number;
  deadlinePassed: number;
  notOpen: number;
  otherGateway: number;
};
const NONE: Evidence = {
  open: 0,
  deadlinePassed: 0,
  notOpen: 0,
  otherGateway: 0,
};

function renderPage(urgentEvidence: Evidence) {
  const urgentDisputes = Object.values(urgentEvidence).reduce(
    (a, n) => a + n,
    0,
  );
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      disputes: [],
      total: 0,
      page: 1,
      limit: 20,
      totalPages: 0,
      urgentDisputes,
      urgentEvidence,
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
  it("tells a viewer who can manage disputes to submit evidence on the open ones", async () => {
    mockCanManage = true;
    renderPage({ ...NONE, open: 2 });
    expect(
      await screen.findByText(/Submit evidence on 2 before the deadline\./),
    ).toBeInTheDocument();
    expect(screen.queryByText(/escalate/i)).not.toBeInTheDocument();
  });

  it("gives no evidence instruction when only an overdue case and a warning are urgent", async () => {
    mockCanManage = true;
    renderPage({ ...NONE, deadlinePassed: 1, notOpen: 1 });
    expect(
      await screen.findByText(/1 past the evidence deadline/),
    ).toBeInTheDocument();
    expect(screen.getByText(/1 early warning/)).toBeInTheDocument();
    expect(screen.queryByText(/Submit evidence/)).not.toBeInTheDocument();
  });

  it("tells a viewer who cannot to escalate the open ones to an admin", async () => {
    mockCanManage = false;
    renderPage({ ...NONE, open: 1, otherGateway: 1 });
    expect(
      await screen.findByText(/escalate 1 to an admin/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/1 on another gateway/)).toBeInTheDocument();
  });
});
