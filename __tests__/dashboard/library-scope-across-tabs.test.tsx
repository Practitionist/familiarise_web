// Invariant: the org Library's Mine · Everyone pick survives a switch between
// Session documents and Session recordings; the tab links read the live URL.

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Next's patched replaceState re-syncs `useSearchParams`; mirror that here.
const urlListeners = new Set<() => void>();
// The session-backed zone hook loads the auth client, which jsdom cannot import.
jest.mock("@/lib/time/use-viewer-zone", () => ({
  useViewerZone: () => ({ zone: "Asia/Kolkata", own: true }),
}));
jest.mock("next/navigation", () => {
  const { useSyncExternalStore } = jest.requireActual("react");
  return {
    usePathname: () => globalThis.location.pathname,
    useSearchParams: () => {
      const search = useSyncExternalStore(
        (notify: () => void) => {
          urlListeners.add(notify);
          return () => urlListeners.delete(notify);
        },
        () => globalThis.location.search,
      );
      return new URLSearchParams(search);
    },
    useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  };
});

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { LibraryTabNav } from "@/components/dashboard/library/LibraryTabNav";
import { OrgLibrary } from "@/components/dashboard/library/OrgLibrary";

const BASE = "/dashboard/organization/o1/library";
const nativeReplaceState = globalThis.history.replaceState.bind(
  globalThis.history,
);

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  globalThis.history.replaceState = (...args) => {
    nativeReplaceState(...args);
    urlListeners.forEach((notify) => notify());
  };
  nativeReplaceState(null, "", `${BASE}?tab=documents`);
  globalThis.fetch = jest.fn(
    () => new Promise(() => {}),
  ) as unknown as typeof fetch;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.history.replaceState = nativeReplaceState;
});

function render(tab: "documents" | "recordings") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <LibraryTabNav
          title="Library"
          basePath={BASE}
          tabs={["documents", "recordings"]}
          active={tab}
          carryScope
        />
        <OrgLibrary key={tab} orgId="o1" artifact={tab} canSeeEveryone />
      </QueryClientProvider>,
    ),
  );
}

const tabLink = (label: string) =>
  Array.from(container.querySelectorAll("a")).find(
    (a) => a.textContent === label,
  );
const scopeTrigger = (label: string) =>
  Array.from(container.querySelectorAll('[role="tab"]')).find(
    (t) => t.textContent === label,
  );

it("keeps Everyone when switching from Session documents to Session recordings", () => {
  render("documents");
  expect(tabLink("Session recordings")?.getAttribute("href")).toBe(
    `${BASE}?tab=recordings`,
  );

  act(() => {
    scopeTrigger("Everyone")?.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0 }),
    );
  });
  expect(globalThis.location.search).toContain("scope=everyone");
  const href = tabLink("Session recordings")?.getAttribute("href");
  expect(href).toBe(`${BASE}?tab=recordings&scope=everyone`);

  // The tab link is a server navigation; land on its URL with the new tab.
  nativeReplaceState(null, "", href);
  render("recordings");
  expect(scopeTrigger("Everyone")?.getAttribute("aria-selected")).toBe("true");
  expect(tabLink("Session documents")?.getAttribute("href")).toBe(
    `${BASE}?tab=documents&scope=everyone`,
  );
});

it("keeps Mine when the page opened on Everyone", () => {
  nativeReplaceState(null, "", `${BASE}?tab=documents&scope=everyone`);
  render("documents");
  act(() => {
    scopeTrigger("Mine")?.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0 }),
    );
  });
  expect(tabLink("Session recordings")?.getAttribute("href")).toBe(
    `${BASE}?tab=recordings&scope=mine`,
  );
});

it("carries no scope for a personal Library", () => {
  nativeReplaceState(
    null,
    "",
    "/dashboard/consultee/c1/library?scope=everyone",
  );
  act(() =>
    root.render(
      <LibraryTabNav
        title="Library"
        basePath="/dashboard/consultee/c1/library"
        tabs={["purchases", "recordings", "documents"]}
        active="purchases"
        carryScope={false}
      />,
    ),
  );
  expect(tabLink("Session documents")?.getAttribute("href")).toBe(
    "/dashboard/consultee/c1/library?tab=documents",
  );
});
