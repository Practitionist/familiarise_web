import { fireEvent, render, renderHook, screen } from "@testing-library/react";

import { CatalogPanel } from "../../app/dashboard/organization/[orgId]/catalog/CatalogPanel";
import type { CatalogRow } from "../../app/dashboard/organization/[orgId]/catalog/types";
import { useScrollToHashOnReady } from "../../hooks/useScrollToHashOnReady";

let reducedMotion = false;
beforeEach(() => {
  reducedMotion = false;
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
  const panel = (rows: CatalogRow[], initialArchived: boolean) => (
    <CatalogPanel
      kind="WEBINAR"
      rows={rows}
      initialArchived={initialArchived}
      isLoading={false}
      error={null}
      onToggleArchive={jest.fn()}
      isMutating={false}
      blocked={<p>Invite an expert first</p>}
    />
  );

  it("?status=archived lists withdrawn plans", () => {
    render(panel([row("live", null), row("old", "2026-10-01")], true));
    expect(screen.getAllByText("Plan old").length).toBeGreaterThan(0);
    expect(screen.queryByText("Plan live")).toBeNull();
    expect(screen.queryByText("Invite an expert first")).toBeNull();
  });

  it("shows the Archived chip beside the empty state, and it toggles", () => {
    render(panel([row("old", "2026-10-01")], false));
    expect(screen.getByText("Invite an expert first")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Archived" }));
    expect(screen.getAllByText("Plan old").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Archived" }));
    expect(screen.getByText("Invite an expert first")).toBeTruthy();
  });

  it("shows only the empty state when nothing is archived", () => {
    render(panel([], true));
    expect(screen.getByText("Invite an expert first")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Archived" })).toBeNull();
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
