// Invariant: the Library date menu writes `from` and `to` as local YYYY-MM-DD
// days in one URL update.

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// The session-backed zone hook loads the auth client, which jsdom cannot import.
jest.mock("@/lib/time/use-viewer-zone", () => ({
  useViewerZone: () => ({ zone: "Asia/Kolkata", own: true }),
}));
jest.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/consultee/c1/library",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

const replaceUrl = jest.fn();
jest.mock("@/lib/navigation/history", () => ({
  replaceUrl: (url: string) => replaceUrl(url),
}));

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { PersonalLibrary } from "@/components/dashboard/library/PersonalLibrary";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  globalThis.fetch = jest.fn(
    () => new Promise(() => {}),
  ) as unknown as typeof fetch;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  replaceUrl.mockClear();
});

it("writes both days of a preset in one update", () => {
  const client = new QueryClient();
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <PersonalLibrary
          tree="consultee"
          profileId="c1"
          artifact="recordings"
        />
      </QueryClientProvider>,
    ),
  );
  const trigger = container.querySelector<HTMLButtonElement>(
    'button[aria-label^="Date:"]',
  );
  expect(trigger).not.toBeNull();
  act(() => {
    trigger?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    trigger?.click();
  });
  const today = Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === "Today",
  );
  expect(today).toBeDefined();
  act(() => today?.click());

  const now = new Date();
  const day = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
  expect(replaceUrl).toHaveBeenCalledTimes(1);
  const params = new URLSearchParams(
    String(replaceUrl.mock.calls[0][0]).split("?")[1],
  );
  expect(params.get("from")).toBe(day);
  expect(params.get("to")).toBe(day);
});
