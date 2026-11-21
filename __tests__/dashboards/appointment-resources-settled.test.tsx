/**
 * @jest-environment jsdom
 */

/**
 * The booking page's Resources cards settle instead of waiting on reads the
 * server can only refuse: a closed booking and an operator's view send none,
 * and a refusal is asked once, not retried.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: React.ReactNode }) =>
    React.createElement("a", { href }, children),
}));

import {
  ResourceSnapshot,
  type ResourcesWithheld,
} from "@/components/appointments/detail/ResourceSnapshot";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const HREFS = { documents: "/docs", recordings: "/recs" };
const fetchMock = jest.fn();
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(
  withheld: ResourcesWithheld | null,
  documents = true,
  endedRefunded = false,
) {
  // The app's client retries twice by default (providers/ReactQueryProvider.tsx).
  const client = new QueryClient({
    defaultOptions: { queries: { retry: 2, retryDelay: 0 } },
  });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ResourceSnapshot
          appointmentId="appt-1"
          supportsDocuments={documents}
          hrefs={HREFS}
          withheld={withheld}
          endedRefunded={endedRefunded}
        />
      </QueryClientProvider>,
    ),
  );
}

// The shape `answerFileRoute` sends for a refusal; jsdom has no `Response`.
const notFound = () => ({
  ok: false,
  status: 404,
  json: async () => ({ code: "NOT_FOUND", error: "Not found." }),
});

describe("Resources on the booking page", () => {
  it("a closed booking settles on one sentence and sends no read", async () => {
    await render("closed");
    expect(container.textContent).toBe("No resources for this booking.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an operator is told whose resources these are and sends no read", async () => {
    await render("operator");
    expect(container.textContent).toBe(
      "Only the learner and the expert can open this booking's resources.",
    );
    await render("operator", false);
    expect(container.textContent).toBe(
      "Only the attendees and the host can open this booking's resources.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a refused read is asked once and settles on its sentence", async () => {
    fetchMock.mockImplementation(async () => notFound());
    await render(null);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls.sort()).toEqual([
      "/api/appointments/appt-1/documents",
      "/api/appointments/appt-1/materials",
      "/api/appointments/appt-1/recordings",
    ]);
    expect(container.textContent).toContain(
      "Recordings are available to this booking's attendees.",
    );
    expect(container.querySelector(".animate-pulse")).toBeNull();
  });

  it("a refused Recordings read names the cancelled and refunded booking as the reason", async () => {
    fetchMock.mockImplementation(async () => notFound());
    await render(null, true, true);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(container.textContent).toContain(
      "Recordings are no longer available because this booking was cancelled and refunded.",
    );
    expect(container.textContent).not.toContain("available to this booking's");
  });
});
