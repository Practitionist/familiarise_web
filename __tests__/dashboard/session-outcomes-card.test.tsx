import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * The decision queue card: what its sort headers and pager send parses
 * through the route's schema, its rows name the booking and people, and a row
 * opens its booking.
 */

jest.mock("@/hooks/use-media-query", () => ({ useMediaQuery: () => true }));
jest.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));
jest.mock("@/lib/auth/reauth-client", () => ({
  fetchWithReauth: (url: string, init: RequestInit) => fetch(url, init),
}));

import { z } from "zod";
import { SessionOutcomesCard } from "@/components/dashboard/backoffice/money/SessionOutcomesCard";
import { rereadToast } from "@/components/dashboard/backoffice/money/RereadAttendanceDialog";
import { opsReasonSchema } from "@/lib/backoffice/ops-reason";
import { NEGATIVE_MONEY_OUTCOMES } from "@/lib/booking/misses";
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
  canRereadAttendance: true,
  canConfirm: false,
  booking: {
    type: "CONSULTATION",
    title: "Career chat",
    expert: { id: "u-expert", name: "Asha", email: "a@x.test" },
    learner: { id: "u-learner", name: null, email: "r@x.test" },
    attendeeLabel: null,
    removed: false,
  },
};

const onePage = async (_url: string) => ({
  ok: true,
  json: async () => ({ items: [item], total: 45, page: 1, pageSize: 20 }),
});
const fetchMock = jest.fn(onePage);

const sentQueries = () =>
  fetchMock.mock.calls.map(([url]) =>
    needsHumanQuerySchema.parse(
      Object.fromEntries(new URL(url, "http://x").searchParams),
    ),
  );

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(onePage);
  global.fetch = fetchMock as unknown as typeof fetch;
});

it("sends whitelisted sorts and pages, names the people and the door, and opens the booking", async () => {
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
  expect(screen.getAllByText("Over 7 days").length).toBeGreaterThan(0);
  expect(
    screen.getAllByRole("button", {
      name: "Set outcome for Career chat, 1 Nov 2026, 3:30 pm IST",
    }).length,
  ).toBeGreaterThan(0);

  fireEvent.click(
    screen.getAllByRole("button", { name: "Outcome · minutes lost" })[0],
  );
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getAllByRole("button", { name: /Next/ })[0]);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  // The compact picker is the sort control on a phone, and reaches "Ended".
  fireEvent.change(screen.getByRole("combobox", { name: "Sort" }), {
    target: { value: "-endsAt" },
  });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));

  expect(sentQueries()).toEqual([
    { page: 1, sort: { key: "endsAt", dir: "asc" } },
    { page: 1, sort: { key: "lostMinutes", dir: "asc" } },
    { page: 2, sort: { key: "lostMinutes", dir: "asc" } },
    { page: 1, sort: { key: "endsAt", dir: "desc" } },
  ]);

  fireEvent.click(screen.getAllByText("Career chat")[0]);
  expect(onOpenBooking).toHaveBeenCalledWith("apt-1");
});

it("takes the error path on a 200 whose body is not a queue page", async () => {
  global.fetch = jest.fn(async () => ({
    ok: true,
    json: async () => ({ items: "nope", total: "many" }),
  })) as unknown as typeof fetch;
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <SessionOutcomesCard onOpenBooking={jest.fn()} />
    </QueryClientProvider>,
  );
  expect(
    (await screen.findAllByRole("button", { name: /retry|try again/i })).length,
  ).toBeGreaterThan(0);
  expect(screen.queryByText("Nothing is waiting.")).not.toBeInTheDocument();
});

it("the re-read door posts a reason the route's schema accepts, and words what Stream's record shows", async () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SessionOutcomesCard onOpenBooking={jest.fn()} />
    </QueryClientProvider>,
  );
  fireEvent.click(
    (
      await screen.findAllByRole("button", {
        name: "Read from Stream again for Career chat, 1 Nov 2026, 3:30 pm IST",
      })
    )[0],
  );
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "Stream was down for a day" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Read from Stream" }));
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(([url]) => url.endsWith("/attendance")),
    ).toBe(true),
  );
  const [url, init] = fetchMock.mock.calls.find(([u]) =>
    u.endsWith("/attendance"),
  ) as unknown as [string, RequestInit];
  expect(url).toBe("/api/admin/sessions/occ-1/attendance");
  expect(init.method).toBe("POST");
  // The route's body: its (empty) shape plus the required reason.
  expect(
    z
      .object({})
      .extend({ reason: opsReasonSchema })
      .strict()
      .parse(JSON.parse(String(init.body))),
  ).toEqual({ reason: "Stream was down for a day" });

  expect(
    rereadToast({
      result: "settled",
      verdict: { outcome: "HELD", deliveredMinutes: 58, lostMinutes: 2 },
    }),
  ).toBe(
    "Stream's record is stored. It reads as Held, 58 minutes delivered; set the outcome to apply it.",
  );
  expect(rereadToast({ result: "unavailable", verdict: null })).toMatch(
    /did not answer/,
  );
  expect(rereadToast({ result: "out-of-time", verdict: null })).toBe(
    "Stream took too long to answer, so nothing was stored; read it again.",
  );
});

it("the confirm door posts the outcome the row shows and a reason the route's schema accepts", async () => {
  const closed: NeedsHumanItem = {
    ...item,
    completionStatus: "COMPLETED",
    outcome: "LEARNER_ABSENT",
    canConfirm: true,
  };
  fetchMock.mockImplementation(async () => ({
    ok: true,
    json: async () => ({ items: [closed], total: 1, page: 1, pageSize: 20 }),
  }));
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SessionOutcomesCard onOpenBooking={jest.fn()} />
    </QueryClientProvider>,
  );
  fireEvent.click(
    (
      await screen.findAllByRole("button", {
        name: "Confirm outcome for Career chat, 1 Nov 2026, 3:30 pm IST",
      })
    )[0],
  );
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "Learner told support they forgot" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Confirm outcome" }));
  await waitFor(() =>
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/confirm"))).toBe(
      true,
    ),
  );
  const [url, init] = fetchMock.mock.calls.find(([u]) =>
    u.endsWith("/confirm"),
  ) as unknown as [string, RequestInit];
  expect(url).toBe("/api/admin/sessions/occ-1/confirm");
  expect(init.method).toBe("POST");
  // The route's body: the confirmable outcome plus the required reason.
  expect(
    z
      .object({ outcome: z.enum(NEGATIVE_MONEY_OUTCOMES) })
      .extend({ reason: opsReasonSchema })
      .strict()
      .parse(JSON.parse(String(init.body))),
  ).toEqual({
    outcome: "LEARNER_ABSENT",
    reason: "Learner told support they forgot",
  });
});

it("offers no Confirm on a row the reader did not mark confirmable", async () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SessionOutcomesCard onOpenBooking={jest.fn()} />
    </QueryClientProvider>,
  );
  expect((await screen.findAllByText("Career chat")).length).toBeGreaterThan(0);
  expect(
    screen.queryByRole("button", { name: /^Confirm outcome for/ }),
  ).not.toBeInTheDocument();
});
