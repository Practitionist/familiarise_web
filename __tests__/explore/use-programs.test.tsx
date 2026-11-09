/**
 * @jest-environment jsdom
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import { usePrograms } from "@/app/explore/programs/hooks/usePrograms";
import type { ProgramFilters } from "@/lib/explore/programs";

type Call = { url: string; signal: AbortSignal | null | undefined };

const calls: Call[] = [];
const pending = new Map<string, (body: unknown) => void>();

const plansBody = (titles: string[]) => ({
  data: titles.map((title, i) => ({
    id: `${title}-${i}`,
    title,
    imageUrl: null,
  })),
  meta: { page: 1, totalPages: 1 },
});

const asResponse = (body: unknown) =>
  ({ ok: true, json: async () => body }) as Response;

beforeEach(() => {
  calls.length = 0;
  pending.clear();
  // An unfiltered request answers at once; a searched one waits, so the test
  // controls when it lands, and rejects the way fetch does when it is aborted.
  globalThis.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, signal: init?.signal });
    if (!url.includes("search=")) {
      return Promise.resolve(asResponse(plansBody(["Alpha"])));
    }
    return new Promise<Response>((resolve, reject) => {
      pending.set(url, (body) => resolve(asResponse(body)));
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("Aborted", "AbortError")),
      );
    });
  }) as unknown as typeof fetch;
});

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(
    ({ filters }: { filters: ProgramFilters }) =>
      usePrograms("class", { filters }),
    { wrapper, initialProps: { filters: {} as ProgramFilters } },
  );
}

const titles = (programs: { title: string }[]) => programs.map((p) => p.title);

describe("usePrograms while the search changes", () => {
  it("keeps the previous results on screen until the new ones arrive", async () => {
    const { result, rerender } = setup();
    await waitFor(() =>
      expect(titles(result.current.programs)).toEqual(["Alpha"]),
    );

    rerender({ filters: { search: "py" } });

    await waitFor(() => expect(result.current.isRefreshing).toBe(true));
    expect(titles(result.current.programs)).toEqual(["Alpha"]);
    // Paging belongs to what is on screen, not to the results being replaced.
    expect(result.current.hasMore).toBe(false);

    const [searchUrl] = [...pending.keys()];
    act(() => pending.get(searchUrl)?.(plansBody(["Beta"])));

    await waitFor(() =>
      expect(titles(result.current.programs)).toEqual(["Beta"]),
    );
    expect(result.current.isRefreshing).toBe(false);
  });

  it("cancels a request the reader has already typed past", async () => {
    const { result, rerender } = setup();
    await waitFor(() =>
      expect(titles(result.current.programs)).toEqual(["Alpha"]),
    );

    rerender({ filters: { search: "py" } });
    await waitFor(() => expect(pending.size).toBe(1));
    const first = calls.find((c) => c.url.includes("search=py"));
    expect(first?.signal?.aborted).toBe(false);

    rerender({ filters: { search: "pyt" } });
    await waitFor(() => expect(first?.signal?.aborted).toBe(true));
  });
});
