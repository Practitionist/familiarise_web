import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

import { SupportInboxShell } from "@/components/dashboard/backoffice/support/SupportInboxShell";

// The session-backed zone hook loads the auth client, which jsdom cannot import.
jest.mock("@/lib/time/use-viewer-zone", () => ({
  useViewerZone: () => ({ zone: "Asia/Kolkata", own: true }),
}));
jest.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/admin/support",
  useSelectedLayoutSegment: () => null,
  useSearchParams: () => {
    const search = useSyncExternalStore(
      (notify) => {
        window.addEventListener("popstate", notify);
        return () => window.removeEventListener("popstate", notify);
      },
      () => window.location.search,
    );
    return new URLSearchParams(search);
  },
}));

jest.mock("@/lib/navigation/history", () => ({
  replaceUrl: (target: string) => {
    window.history.replaceState(null, "", target);
    window.dispatchEvent(new PopStateEvent("popstate"));
  },
}));

jest.mock(
  "@/components/dashboard/backoffice/BackofficeCapabilityProvider",
  () => ({
    useBackofficeCapability: () => ({ basePath: "/dashboard/admin" }),
  }),
);
jest.mock("@/components/dashboard/backoffice/support/CaseList", () => ({
  CaseList: () => null,
}));
jest.mock(
  "@/components/dashboard/backoffice/support/StaffSupportComposeDialog",
  () => ({ StaffSupportComposeDialog: () => null }),
);

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

it("Clear cancels an unsubmitted search and preserves the selected view", () => {
  window.history.replaceState(
    null,
    "",
    "/dashboard/admin/support?view=sla-at-risk&status=OPEN&page=3",
  );
  const client = new QueryClient({
    defaultOptions: { queries: { enabled: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <SupportInboxShell>Pick a case</SupportInboxShell>
    </QueryClientProvider>,
  );

  fireEvent.change(screen.getByRole("searchbox", { name: "Search cases" }), {
    target: { value: "invoice" },
  });
  act(() => jest.advanceTimersByTime(100));
  fireEvent.click(screen.getByRole("button", { name: "Clear" }));
  act(() => jest.advanceTimersByTime(500));

  expect(screen.getByRole("searchbox", { name: "Search cases" })).toHaveValue(
    "",
  );
  expect(window.location.search).toBe("?view=sla-at-risk");
  expect(
    screen.queryByRole("button", { name: "Clear" }),
  ).not.toBeInTheDocument();
  client.clear();
});
