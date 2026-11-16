import * as React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock(
  "@/components/dashboard/backoffice/BackofficeCapabilityProvider",
  () => ({
    useBackofficeCapability: () => ({ can: () => false }),
  }),
);
jest.mock("@/components/ui/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));
jest.mock("@/hooks/use-media-query", () => ({
  useMediaQuery: () => true,
  useIsDesktop: () => true,
}));

import { NewsletterManagement } from "@/components/admin/NewsletterManagement";

const fetchMock = jest.fn();

function listSearches() {
  return fetchMock.mock.calls
    .map((call) => new URL(String(call[0]), "http://x"))
    .filter((url) => url.pathname === "/api/admin/newsletter")
    .map((url) => url.searchParams.get("search"));
}

beforeEach(() => {
  jest.useFakeTimers();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({
      items: [],
      total: 0,
      page: 1,
      perPage: 50,
      stats: {},
    }),
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  jest.useRealTimers();
});

it("searches subscribers live after the pause, and Clear resets it", async () => {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <NewsletterManagement />
    </QueryClientProvider>,
  );

  expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
  const input = screen.getByLabelText("Search subscribers");
  expect(input).toHaveAttribute("placeholder", "Search by email or name");

  fireEvent.change(input, { target: { value: "ravi@" } });
  expect(listSearches()).not.toContain("ravi@");
  await act(async () => {
    jest.advanceTimersByTime(300);
  });
  expect(listSearches()).toContain("ravi@");

  fireEvent.click(screen.getByRole("button", { name: "Clear" }));
  expect(input).toHaveValue("");
  expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
});
