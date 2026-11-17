/**
 * A paged list whose current page empties (its last row was deleted) moves
 * back to the last page that has rows and keeps its pager, and a page the
 * operator moved to is never clamped against the previous page's total while
 * it loads.
 */

import {
  QueryClient,
  QueryClientProvider,
  keepPreviousData,
  useQuery,
} from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useState, type ReactNode } from "react";

jest.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

import { AnnouncementsPage } from "@/components/dashboard/shared/AnnouncementsPage";
import { usePageWithinTotal } from "@/components/dashboard/shared/paged-list-filters";

const withQueries = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
};

function announcement(n: number) {
  return {
    id: `a-${n}`,
    title: `Announcement ${n}`,
    content: `Body ${n}`,
    isActive: true,
    startDate: null,
    endDate: null,
    backgroundColor: "#000000",
    textColor: "#FFFFFF",
    linkUrl: null,
    linkText: null,
    createdAt: "2026-11-16T09:00:00.000Z",
  };
}

// The confirm dialog picks its layout from a media query; jsdom has none.
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }),
});

/** A 200 as `fetch` resolves it; jsdom has no `Response`. */
const reply = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

describe("AnnouncementsPage after the last row of a page is deleted", () => {
  let live: number[];
  beforeEach(() => {
    live = Array.from({ length: 21 }, (_, i) => i + 1);
    global.fetch = jest.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "http://test");
        if (init?.method === "DELETE") {
          live = live.filter(
            (n) => `/api/announcements/a-${n}` !== url.pathname,
          );
          return reply({ success: true });
        }
        const page = Number(url.searchParams.get("page") ?? "1");
        const rows = live.slice((page - 1) * 20, page * 20).map(announcement);
        return reply({
          success: true,
          data: rows,
          total: live.length,
          page,
          limit: 20,
        });
      },
    ) as typeof fetch;
  });

  it("returns to the last page with rows and keeps the pager", async () => {
    render(<AnnouncementsPage />, { wrapper: withQueries() });
    expect(await screen.findByText("1–20 of 21")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(await screen.findByText("Announcement 21")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /delete/i }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^delete$/i }));

    expect(await screen.findByText("1–20 of 20")).toBeTruthy();
    expect(await screen.findByText("Announcement 1")).toBeTruthy();
    expect(screen.getByLabelText("Pagination")).toBeTruthy();
  });
});

describe("a page that is still loading", () => {
  it("is not clamped against the previous page's total", async () => {
    // Page 1 answered with 5 rows in all; page 3 (of 60 rows) is slow to answer.
    let answerPage3: (total: number) => void = () => undefined;
    const fetchPage = (page: number) =>
      page === 1
        ? Promise.resolve({ total: 5 })
        : new Promise<{ total: number }>((resolve) => {
            answerPage3 = (total) => resolve({ total });
          });
    const { result } = renderHook(
      () => {
        const [page, setPage] = useState(1);
        const query = useQuery({
          queryKey: ["clamp", page],
          queryFn: () => fetchPage(page),
          placeholderData: keepPreviousData,
        });
        // The callers' wiring: only a settled answer for this page clamps it.
        usePageWithinTotal(
          page,
          setPage,
          query.isPlaceholderData ? undefined : query.data?.total,
          20,
        );
        return { page, setPage, settled: !query.isPlaceholderData };
      },
      { wrapper: withQueries() },
    );
    await waitFor(() => expect(result.current.settled).toBe(true));
    act(() => result.current.setPage(3));
    // Page 1's stale "5 rows" would put page 3 past the end; it must not bounce.
    await act(async () => undefined);
    expect(result.current.page).toBe(3);
    await act(async () => answerPage3(60));
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current.page).toBe(3);
  });

  it.each([
    "components/dashboard/backoffice/organizations/OrgVerificationQueue.tsx",
    "components/dashboard/shared/AnnouncementsPage.tsx",
    "components/dashboard/shared/ModerationPage.tsx",
  ])("%s clamps only on a settled answer", (file) => {
    const src = readFileSync(join(process.cwd(), file), "utf8");
    const calls = src.split("usePageWithinTotal(").slice(1);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.slice(0, 200)).toMatch(
        /[Pp]laceholder(Data)?\s*\?\s*undefined/,
      );
    }
  });
});
