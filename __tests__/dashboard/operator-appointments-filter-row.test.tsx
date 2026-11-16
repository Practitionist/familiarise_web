import * as React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// A URL store that re-renders on writes, standing in for the App Router's
// sync of `history.replaceState` into `useSearchParams`.
const listeners = new Set<() => void>();
const urlStore = {
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  snapshot: () => window.location.search,
};

jest.mock("next/navigation", () => ({
  usePathname: () => "/backoffice/appointments",
  useSearchParams: () => {
    const search = React.useSyncExternalStore(
      urlStore.subscribe,
      urlStore.snapshot,
    );
    return React.useMemo(() => new URLSearchParams(search), [search]);
  },
}));
jest.mock("@/lib/navigation/history", () => ({
  replaceUrl: (target: string) => {
    window.history.replaceState(null, "", target);
    listeners.forEach((listener) => listener());
  },
}));
jest.mock("@/hooks/use-media-query", () => ({
  useMediaQuery: () => true,
}));
jest.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));
jest.mock("@/components/dashboard/shared/AppointmentTimeline", () => ({
  AppointmentTimeline: () => null,
}));

import { OperatorAppointmentsClient } from "@/components/dashboard/shared/OperatorAppointmentsClient";

const APPOINTMENT = {
  id: "apt_linked",
  type: "CONSULTATION",
  title: "Linked booking",
  consultant: { id: "c1", name: "Asha", email: null, avatar: null },
  consultee: { id: "u1", name: "Ravi", email: null, avatar: null },
  scheduledAt: "2026-11-20T10:00:00.000Z",
  duration: 30,
  status: "SCHEDULED",
  bookingSource: "DIRECT_CHECKOUT",
  free: true,
  hasIssue: false,
  issueType: null,
  payment: null,
  reschedule: null,
  createdAt: "2026-11-01T10:00:00.000Z",
};

const fetchMock = jest.fn();

function renderPage(url: string) {
  window.history.replaceState(null, "", url);
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <OperatorAppointmentsClient />
    </QueryClientProvider>,
  );
}

function searchParamOf(call: unknown[]) {
  return new URL(String(call[0]), "http://x").searchParams.get("search");
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input: string) => {
    const search = new URL(input, "http://x").searchParams.get("search");
    return {
      ok: true,
      json: async () => ({
        appointments: search === APPOINTMENT.id ? [APPOINTMENT] : [],
        counts: { all: 1, issues: 0, scheduled: 1, completed: 0 },
        pagination: {
          total: 1,
          page: 1,
          limit: 20,
          totalPages: 1,
          hasMore: false,
        },
      }),
    };
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  jest.useRealTimers();
});

it("?open=<id> fills the search, moves into q and opens the booking", async () => {
  renderPage("/backoffice/appointments?open=apt_linked&tab=completed");

  expect(
    await screen.findByRole("heading", { name: /Linked booking/ }),
  ).toBeInTheDocument();
  expect(screen.getByLabelText("Search appointments")).toHaveValue(
    "apt_linked",
  );
  expect(window.location.search).toBe("?q=apt_linked");
  expect(fetchMock.mock.calls.map(searchParamOf)).toContain("apt_linked");
});

it("typing searches after the pause, and Clear resets search and type", async () => {
  jest.useFakeTimers();
  renderPage("/backoffice/appointments?type=webinar");

  const input = screen.getByLabelText("Search appointments");
  fireEvent.change(input, { target: { value: "asha" } });
  expect(window.location.search).toBe("?type=webinar");
  await act(async () => {
    jest.advanceTimersByTime(300);
  });
  expect(window.location.search).toBe("?type=webinar&q=asha");

  fireEvent.click(screen.getByRole("button", { name: "Clear" }));
  expect(window.location.search).toBe("");
  expect(input).toHaveValue("");
});
