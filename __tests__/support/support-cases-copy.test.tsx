import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "fs";
import { join } from "path";

jest.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: "u1" } } }),
}));
jest.mock("@/hooks/useListParams", () => ({
  useListParams: () => ({
    q: "",
    page: 1,
    sort: null,
    filters: { context: null, status: null },
    setPage: jest.fn(),
    setFilters: jest.fn(),
    setFilter: jest.fn(),
  }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/dashboard/consultee/c1/support",
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("@/components/support/PlatformSupportSheet", () => ({
  PlatformSupportSheet: () => null,
}));

import { SupportRequestsPage } from "@/components/dashboard/shared/support/SupportRequestsPage";

it("the personal support page says support cases, not requests", async () => {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      data: [],
      pagination: { page: 1, pageSize: 20, total: 0 },
    }),
  }) as unknown as typeof fetch;
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SupportRequestsPage
        basePath="/dashboard/consultee/c1"
        suggested={null}
      />
    </QueryClientProvider>,
  );
  expect(
    screen.getByRole("heading", { name: "Your support cases" }),
  ).toBeInTheDocument();
  expect(await screen.findByText("No support cases yet")).toBeInTheDocument();
  const button = screen.getByRole("button", { name: /New support case/ });
  fireEvent.click(button);
  expect(
    await screen.findByRole("heading", { name: "New support case" }),
  ).toBeInTheDocument();
  expect(screen.queryByText(/support request/i)).toBeNull();
});

it("the learner Library labels attended recordings Session recordings", () => {
  const src = readFileSync(
    join(process.cwd(), "components/dashboard/library/LibraryPage.tsx"),
    "utf8",
  );
  expect(src).toContain('recordings: "Session recordings"');
});
