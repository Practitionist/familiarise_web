// Invariant: a Library list never shows another list's rows as its placeholder;
// switching Session recordings -> Session documents shows a loading state, not
// recording rows read as documents, while the documents request is pending.

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

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { PersonalLibrary } from "@/components/dashboard/library/PersonalLibrary";

const recordingsPage = {
  groups: [
    {
      session: {
        appointmentId: "a1",
        kind: "CONSULTATION",
        title: "Recorded session title",
        startsAt: "2026-10-01T10:00:00.000Z",
        sessionCount: 1,
        expertName: "Expert",
        counterpartName: "Expert",
      },
      files: [
        {
          id: "a1:slot-1",
          title: "Recorded session title",
          slotOrdinal: 1,
          sessionAt: "2026-10-01T10:00:00.000Z",
          state: "recorded",
          durationInMinutes: 30,
          catchUp: null,
          removed: null,
          declinedBy: null,
          keptUntil: null,
          parts: [],
          removedParts: [],
        },
      ],
    },
  ],
  total: 1,
  page: 1,
  pageSize: 10,
};

let root: Root;
let container: HTMLDivElement;
const fetchMock = jest.fn();

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await flush();
}

it("drops the recordings rows while the documents request is pending", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  fetchMock.mockImplementation((url: string) =>
    url.includes("/recordings")
      ? Promise.resolve({ ok: true, json: async () => recordingsPage })
      : new Promise(() => {}),
  );
  const view = (artifact: "documents" | "recordings") => (
    <QueryClientProvider client={client}>
      <PersonalLibrary tree="consultee" profileId="c1" artifact={artifact} />
    </QueryClientProvider>
  );

  act(() => root.render(view("recordings")));
  await waitFor(() =>
    (container.textContent ?? "").includes("Recorded session title"),
  );
  expect(container.textContent).toContain("Recorded session title");

  act(() => root.render(view("documents")));
  await waitFor(() => fetchMock.mock.calls.length > 1);
  await flush();
  expect(fetchMock).toHaveBeenLastCalledWith(
    "/api/dashboard/consultee/c1/documents",
  );
  expect(container.textContent).not.toContain("Recorded session title");
});
