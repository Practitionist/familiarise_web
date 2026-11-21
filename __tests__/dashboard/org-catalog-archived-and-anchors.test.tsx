let mockSearch = new URLSearchParams();
jest.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/organization/o1/catalog",
  useSearchParams: () => mockSearch,
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    refresh: jest.fn(),
  }),
}));

// The chips write `?status=` through replaceUrl; mirror it into the mock URL.
jest.mock("../../lib/navigation/history", () => ({
  replaceUrl: (target: string) => {
    mockSearch = new URLSearchParams(target.split("?")[1] ?? "");
  },
}));

import {
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { CatalogClient } from "../../app/dashboard/organization/[orgId]/catalog/CatalogClient";
import { CatalogPanel } from "../../app/dashboard/organization/[orgId]/catalog/CatalogPanel";
import type { CatalogRow } from "../../app/dashboard/organization/[orgId]/catalog/types";
import { useScrollToHashOnReady } from "../../hooks/useScrollToHashOnReady";

let reducedMotion = false;
beforeEach(() => {
  reducedMotion = false;
  mockSearch = new URLSearchParams();
  window.matchMedia = (query: string) => ({
    matches: query.includes("reduce") && reducedMotion,
    media: query,
    onchange: null,
    addListener: jest.fn(),
    removeListener: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  });
});

const row = (id: string, archivedAt: string | null): CatalogRow => ({
  id,
  title: `Plan ${id}`,
  price: "50000",
  visibility: "PUBLIC",
  maxParticipants: 10,
  consultantProfileId: null,
  archivedAt,
});

describe("Catalog with no experts", () => {
  const panel = (rows: CatalogRow[], archived: boolean) => {
    mockSearch = new URLSearchParams(archived ? "status=archived" : "");
    return <Panel rows={rows} />;
  };
  const Panel = ({ rows }: { rows: CatalogRow[] }) => (
    <CatalogPanel
      kind="WEBINAR"
      rows={rows}
      isLoading={false}
      error={null}
      onToggleArchive={jest.fn()}
      isMutating={false}
      creationBlocked={<p>Invite an expert first</p>}
    />
  );

  it("?status=archived lists withdrawn plans", () => {
    render(panel([row("live", null), row("old", "2026-10-01")], true));
    expect(screen.getAllByText("Plan old").length).toBeGreaterThan(0);
    expect(screen.queryByText("Plan live")).toBeNull();
    expect(screen.queryByText("Invite an expert first")).toBeNull();
  });

  it("keeps listing live plans beside the creation notice", () => {
    render(panel([row("live", null), row("old", "2026-10-01")], false));
    expect(screen.getByText("Invite an expert first")).toBeTruthy();
    expect(screen.getAllByText("Plan live").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Published" })).toBeTruthy();
  });

  it("shows the Archived chip beside the notice, and it toggles", () => {
    const rows = [row("old", "2026-10-01")];
    const { rerender } = render(panel(rows, false));
    expect(screen.getByText("Invite an expert first")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Archived" }));
    expect(mockSearch.get("status")).toBe("archived");
    rerender(<Panel rows={rows} />);
    expect(screen.getAllByText("Plan old").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Archived" }));
    expect(mockSearch.get("status")).toBeNull();
    rerender(<Panel rows={rows} />);
    expect(screen.getByText("Invite an expert first")).toBeTruthy();
  });

  it("shows only the empty state when nothing is archived", () => {
    render(panel([], false));
    expect(screen.getByText("Invite an expert first")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Archived" })).toBeNull();
  });
});

describe("?status=archived never shows live rows", () => {
  const panel = (rows: CatalogRow[]) => (
    <CatalogPanel
      kind="WEBINAR"
      rows={rows}
      isLoading={false}
      error={null}
      onToggleArchive={jest.fn()}
      isMutating={false}
    />
  );

  it("says nothing is archived instead of falling back to All statuses", () => {
    mockSearch = new URLSearchParams("status=archived");
    const rows = [row("live", null)];
    const { rerender } = render(panel(rows));
    expect(screen.getByText("No archived webinars")).toBeTruthy();
    expect(screen.queryByText("Plan live")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show live webinars" }));
    rerender(panel(rows));
    expect(screen.getAllByText("Plan live").length).toBeGreaterThan(0);
  });
});

describe("CatalogClient under ?status=archived", () => {
  const body = {
    webinars: [{ ...row("live-webinar", null), title: "Live webinar" }],
    classes: [
      { ...row("live-class", null), title: "Live class" },
      { ...row("old-class", "2026-10-01"), title: "Archived class" },
    ],
  };
  const catalog = (client: QueryClient) => (
    <QueryClientProvider client={client}>
      <CatalogClient
        orgId="o1"
        experts={[
          { consultantProfileId: "cp1", name: "Expert", isVerified: true },
        ]}
        materials={[]}
        materialsTotal={0}
        orgPlans={[]}
      />
    </QueryClientProvider>
  );
  const selectedTab = () =>
    screen.getByRole("tab", { selected: true }).textContent;

  beforeEach(() => {
    globalThis.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => body,
    })) as unknown as typeof fetch;
  });

  it("opens the Classes tab when only classes are archived", async () => {
    mockSearch = new URLSearchParams("status=archived");
    render(
      catalog(
        new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      ),
    );
    await waitFor(() =>
      expect(screen.getAllByText("Archived class").length).toBeGreaterThan(0),
    );
    expect(screen.queryByText("Live webinar")).toBeNull();
    expect(screen.queryByText("Live class")).toBeNull();
  });

  it("follows ?status= when it changes after mount", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mockSearch = new URLSearchParams("status=archived");
    const { rerender } = render(catalog(client));
    await waitFor(() =>
      expect(screen.getAllByText("Archived class").length).toBeGreaterThan(0),
    );
    expect(selectedTab()).toBe("Classes");

    // Back to the bare Catalog URL: live rows, first tab.
    mockSearch = new URLSearchParams();
    rerender(catalog(client));
    expect(selectedTab()).toBe("Webinars");
    expect(screen.getAllByText("Live webinar").length).toBeGreaterThan(0);
    expect(screen.queryByText("Archived class")).toBeNull();

    // Forward into the archived view again, with the same component mounted.
    mockSearch = new URLSearchParams("status=archived");
    rerender(catalog(client));
    expect(selectedTab()).toBe("Classes");
    expect(screen.getAllByText("Archived class").length).toBeGreaterThan(0);
    expect(screen.queryByText("Live class")).toBeNull();
  });
});

describe("useScrollToHashOnReady", () => {
  let scroll: jest.Mock;
  beforeEach(() => {
    document.body.innerHTML = '<section id="earnings"></section>';
    scroll = jest.fn();
    document.getElementById("earnings")!.scrollIntoView = scroll;
    window.history.replaceState(null, "", "/payouts?tab=runs#earnings");
  });

  it("scrolls once, after the data is ready", () => {
    const { rerender } = renderHook(
      ({ ready }) => useScrollToHashOnReady("earnings", ready),
      { initialProps: { ready: false } },
    );
    expect(scroll).not.toHaveBeenCalled();
    rerender({ ready: true });
    expect(scroll).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    rerender({ ready: false });
    rerender({ ready: true });
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it("jumps without animation under reduced motion", () => {
    reducedMotion = true;
    renderHook(() => useScrollToHashOnReady("earnings", true));
    expect(scroll).toHaveBeenCalledWith({ behavior: "auto", block: "start" });
  });

  it("ignores a hash naming another section", () => {
    window.history.replaceState(null, "", "/payouts?tab=runs#other");
    renderHook(() => useScrollToHashOnReady("earnings", true));
    expect(scroll).not.toHaveBeenCalled();
  });
});
