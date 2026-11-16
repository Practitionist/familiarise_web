import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock(
  "../../components/dashboard/backoffice/BackofficeCapabilityProvider",
  () => ({
    useBackofficeCapability: () => ({
      basePath: "/dashboard/admin",
      can: () => false,
    }),
  }),
);
jest.mock("../../hooks/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

import { ModerationPage } from "../../components/dashboard/shared/ModerationPage";

const originalFetch = global.fetch;
let fetchMock: jest.Mock;

function reportUrls(): string[] {
  return fetchMock.mock.calls
    .map((c) => String(c[0]))
    .filter((u) => u.startsWith("/api/staff/moderation/reports"));
}

beforeEach(() => {
  window.matchMedia = jest.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  }));
  fetchMock = jest.fn().mockImplementation(async () => ({
    ok: true,
    json: async () => ({ reports: [], reviews: [], stats: {} }),
  }));
  global.fetch = fetchMock;
});
afterEach(() => {
  global.fetch = originalFetch;
});

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ModerationPage />
    </QueryClientProvider>,
  );
}

describe("ModerationPage reports filter", () => {
  it("defaults to Pending and offers no Clear until a filter changes", async () => {
    renderPage();
    await waitFor(() => expect(reportUrls().length).toBeGreaterThan(0));
    expect(reportUrls()[0]).toContain("status=PENDING");
    expect(screen.getByRole("combobox", { name: "Status" })).toHaveTextContent(
      "Pending",
    );
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
  });

  it("Clear returns the search to empty and the status to Pending", async () => {
    renderPage();
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search reports" }),
      {
        target: { value: "spam" },
      },
    );
    await waitFor(() =>
      expect(reportUrls().some((u) => u.includes("search=spam"))).toBe(true),
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Clear" })).toBeNull(),
    );
    expect(
      screen.getByRole("searchbox", { name: "Search reports" }),
    ).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "Status" })).toHaveTextContent(
      "Pending",
    );
  });
});
