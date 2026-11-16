import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * The decision queue card: what its sort headers and pager send parses
 * through the route's schema, its rows name the booking and people, and a row
 * opens its booking.
 */

jest.mock("@/hooks/use-media-query", () => ({ useMediaQuery: () => true }));

import { SessionOutcomesCard } from "@/components/dashboard/backoffice/money/SessionOutcomesCard";
import {
  needsHumanQuerySchema,
  type NeedsHumanItem,
} from "@/lib/backoffice/needs-human-queue";

const item: NeedsHumanItem = {
  id: "occ-1",
  appointmentId: "apt-1",
  startsAt: "2026-11-01T10:00:00.000Z",
  endsAt: "2026-11-01T11:00:00.000Z",
  outcomeAt: "2026-11-01T12:00:00.000Z",
  completionStatus: "UNVERIFIED",
  outcome: "INCONCLUSIVE",
  lostMinutes: 40,
  endedReason: null,
  aged: true,
  booking: {
    type: "CONSULTATION",
    title: "Career chat",
    expert: { id: "u-expert", name: "Asha", email: "a@x.test" },
    learner: { id: "u-learner", name: null, email: "r@x.test" },
    attendeeLabel: null,
    removed: false,
  },
};

const fetchMock = jest.fn(async (_url: string) => ({
  ok: true,
  json: async () => ({ items: [item], total: 45, page: 1, pageSize: 20 }),
}));

const sentQueries = () =>
  fetchMock.mock.calls.map(([url]) =>
    needsHumanQuerySchema.parse(
      Object.fromEntries(new URL(url, "http://x").searchParams),
    ),
  );

beforeEach(() => {
  fetchMock.mockClear();
  global.fetch = fetchMock as unknown as typeof fetch;
});

it("sends whitelisted sorts and pages, names the people, and opens the booking", async () => {
  const onOpenBooking = jest.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SessionOutcomesCard onOpenBooking={onOpenBooking} />
    </QueryClientProvider>,
  );

  // The table and its small-screen cards both render the row.
  expect((await screen.findAllByText("Career chat")).length).toBeGreaterThan(0);
  expect(screen.getAllByText("Asha").length).toBeGreaterThan(0);
  expect(screen.getAllByText("r@x.test").length).toBeGreaterThan(0);
  expect(screen.getAllByText(/settlement on hold/).length).toBeGreaterThan(0);

  fireEvent.click(screen.getAllByRole("button", { name: "Lost" })[0]);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getAllByRole("button", { name: /Next/ })[0]);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

  expect(sentQueries()).toEqual([
    { page: 1, sort: { key: "endsAt", dir: "asc" } },
    { page: 1, sort: { key: "lostMinutes", dir: "asc" } },
    { page: 2, sort: { key: "lostMinutes", dir: "asc" } },
  ]);

  fireEvent.click(screen.getAllByText("Career chat")[0]);
  expect(onOpenBooking).toHaveBeenCalledWith("apt-1");
});
