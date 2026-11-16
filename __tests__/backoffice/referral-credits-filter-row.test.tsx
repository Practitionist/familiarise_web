import * as React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/backoffice/referrals",
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock(
  "@/components/dashboard/backoffice/BackofficeCapabilityProvider",
  () => ({
    useBackofficeCapability: () => ({ can: () => false }),
  }),
);
jest.mock("@/hooks/use-media-query", () => ({
  useMediaQuery: () => true,
  useIsDesktop: () => true,
}));

import { ReferralCreditsPageClient } from "@/components/dashboard/backoffice/referrals/ReferralCreditsPageClient";

const fetchMock = jest.fn();

function creditQueries() {
  return fetchMock.mock.calls
    .map((call) => new URL(String(call[0]), "http://x"))
    .filter((url) => url.pathname === "/api/admin/referrals/credits")
    .map((url) => url.searchParams.get("q"));
}

beforeEach(() => {
  jest.useFakeTimers();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ data: [], total: 0, totalPages: 1 }),
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  jest.useRealTimers();
});

it("the credits search reaches the API after the pause, and Clear resets it", async () => {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ReferralCreditsPageClient />
    </QueryClientProvider>,
  );

  const input = screen.getByLabelText(
    "Search by email, name, or referral code",
  );
  expect(screen.getByLabelText("Filter by source")).toBeInTheDocument();
  expect(screen.getByLabelText("Filter by status")).toBeInTheDocument();

  fireEvent.change(input, { target: { value: "REF42" } });
  expect(creditQueries()).not.toContain("REF42");
  await act(async () => {
    jest.advanceTimersByTime(300);
  });
  expect(creditQueries()).toContain("REF42");

  fireEvent.click(screen.getByRole("button", { name: "Clear" }));
  expect(input).toHaveValue("");
  expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
});
