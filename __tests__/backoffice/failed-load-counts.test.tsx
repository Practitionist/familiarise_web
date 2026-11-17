/**
 * A list whose read failed shows its error state, never a count of zero it
 * did not read ("0 people on the platform").
 */
import * as React from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock(
  "@/components/dashboard/backoffice/BackofficeCapabilityProvider",
  () => ({
    useBackofficeCapability: () => ({ basePath: "/dashboard/admin" }),
  }),
);

import { OperatorUsersPage } from "@/components/dashboard/shared/OperatorUsersPage";
import { countLabel } from "@/lib/ui/count-label";

it("the Users header names the failed load instead of 0 people", async () => {
  globalThis.fetch = jest.fn().mockResolvedValue({
    ok: false,
    status: 500,
    json: async () => ({ error: "boom" }),
  }) as unknown as typeof fetch;
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <OperatorUsersPage />
    </QueryClientProvider>,
  );
  expect(
    await screen.findByText(/The people on the platform couldn't be loaded/),
  ).toBeInTheDocument();
  expect(screen.queryByText(/^0 people on the platform/)).toBeNull();
  // A pager over a read that never answered would count rows it did not read.
  expect(screen.queryByText(/0–0 of 0/)).toBeNull();
});

it("countLabel prints a count only once the read answered", () => {
  const words = (n: number) => `${n} credits`;
  expect(countLabel({ loading: true, failed: false }, 0, words, "x")).toBe(
    "Loading…",
  );
  expect(
    countLabel({ loading: false, failed: true }, 0, words, "Couldn't load"),
  ).toBe("Couldn't load");
  expect(countLabel({ loading: false, failed: false }, 3, words, "x")).toBe(
    "3 credits",
  );
});
