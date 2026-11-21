/**
 * @jest-environment jsdom
 */

/** A list opened from a Home tile sends the tile's status on its first request. */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import { BackofficeCapabilityProvider } from "@/components/dashboard/backoffice/BackofficeCapabilityProvider";
import { DisputesPage } from "@/components/dashboard/shared/DisputesPage";
import { PaymentsPage } from "@/components/dashboard/shared/PaymentsPage";
import { RefundsPage } from "@/components/dashboard/shared/RefundsPage";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

function renderInShell(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <BackofficeCapabilityProvider
        value={{
          tree: "admin",
          basePath: "/dashboard/admin",
          role: "ADMIN",
          audience: "ADMIN",
        }}
        viewerId="admin-1"
      >
        {node}
      </BackofficeCapabilityProvider>
    </QueryClientProvider>,
  );
}

const firstRequest = async () => {
  await waitFor(() => expect(global.fetch).toHaveBeenCalled());
  const url = String((global.fetch as jest.Mock).mock.calls[0][0]);
  return new URL(url, "http://localhost").searchParams.get("status");
};

beforeEach(() => {
  global.fetch = jest
    .fn()
    .mockResolvedValue({ ok: false, json: async () => null });
});
afterEach(cleanup);

it.each([
  ["payments", <PaymentsPage key="p" initialStatus="SUCCEEDED" />, "SUCCEEDED"],
  ["refunds", <RefundsPage key="r" initialStatus="SUCCEEDED" />, "SUCCEEDED"],
  ["disputes", <DisputesPage key="d" initialStatus="OPEN" />, "OPEN"],
])("%s sends the tile status", async (_name, page, status) => {
  renderInShell(page);
  expect(await firstRequest()).toBe(status);
});
