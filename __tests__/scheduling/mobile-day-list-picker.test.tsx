/**
 * The consultee's mobile picker: day chips over the next two weeks and the
 * whole-session starts each day offers, from the same grid endpoint as the
 * desktop heat map.
 */
import * as React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { MobileDayListPicker } from "@/components/scheduling/MobileDayListPicker";
import type { DayListPick } from "@/lib/scheduling/day-list";

const fetchMock = jest.fn();

function atom(iso: string, extra: Record<string, unknown> = {}) {
  return {
    startsAt: new Date(iso).toISOString(),
    endsAt: new Date(new Date(iso).getTime() + 30 * 60_000).toISOString(),
    isAllocated: false,
    bookingStatus: "available",
    ...extra,
  };
}

function grid(overrides: Record<string, unknown>[] = []) {
  const day = [
    atom("2026-11-02T09:00:00Z"),
    atom("2026-11-02T09:30:00Z"),
    atom("2026-11-02T10:00:00Z"),
    atom("2026-11-02T10:30:00Z", {
      bookingStatus: "partially-booked",
      isAllocated: true,
    }),
    atom("2026-11-02T11:00:00Z", { tooSoon: true }),
    atom("2026-11-02T11:30:00Z"),
    atom("2026-11-02T12:00:00Z", { limitReached: true }),
    atom("2026-11-02T12:30:00Z"),
    atom("2026-11-02T14:00:00Z"),
    atom("2026-11-02T14:30:00Z"),
  ].map((cell) => {
    const override = overrides.find((o) => o.startsAt === cell.startsAt);
    return override ? { ...cell, ...override } : cell;
  });
  return {
    status: 200,
    ok: true,
    json: async () => ({
      data: {
        "2026-11-02": day,
        "2026-11-04": [
          atom("2026-11-04T10:00:00Z"),
          atom("2026-11-04T10:30:00Z"),
        ],
      },
    }),
    headers: { get: () => null },
  };
}

/** A grid answer holding only the days inside the request's range. */
function rangedGrid(days: Record<string, string[]>) {
  return async (url: string) => {
    const params = new URL(url, "http://localhost").searchParams;
    const from = params.get("startDateInUtc") ?? "";
    const to = params.get("endDateInUtc") ?? "";
    const data = Object.fromEntries(
      Object.entries(days)
        .filter(([key]) => key >= from.slice(0, 10) && key <= to.slice(0, 10))
        .map(([key, starts]) => [key, starts.map((iso) => atom(iso))]),
    );
    return {
      status: 200,
      ok: true,
      json: async () => ({ data }),
      headers: { get: () => null },
    };
  };
}

function Harness({
  client,
  initial = [],
  timesNeeded = 2,
  onChange,
  subscriptionId,
  releasingIds,
  dayCap,
  allowedStart,
  allowedEnd,
  focusAt,
  lead,
  movingSessions,
}: Readonly<{
  client: QueryClient;
  initial?: DayListPick[];
  timesNeeded?: number;
  onChange?: (next: DayListPick[]) => void;
  subscriptionId?: string;
  releasingIds?: string[];
  dayCap?: { perDay: number; zone: string };
  allowedStart?: Date;
  allowedEnd?: Date;
  focusAt?: Date;
  lead?: { purpose: "book" | "allocate" | "reschedule"; unpaid?: boolean };
  movingSessions?: DayListPick[];
}>) {
  const [value, setValue] = React.useState<DayListPick[]>(initial);
  return (
    <QueryClientProvider client={client}>
      <MobileDayListPicker
        consultantId="cp-1"
        consulteeUserId="buyer-1"
        zone="UTC"
        sessionMinutes={60}
        timesNeeded={timesNeeded}
        subscriptionId={subscriptionId}
        releasingIds={releasingIds}
        dayCap={dayCap}
        allowedStart={allowedStart}
        allowedEnd={allowedEnd}
        focusAt={focusAt}
        lead={lead}
        movingSessions={movingSessions}
        value={value}
        onChange={(next) => {
          onChange?.(next);
          setValue(next);
        }}
      />
    </QueryClientProvider>
  );
}

/** react-query batches its notifications on a timer. */
async function settle() {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(10);
  });
}

async function mount(
  props: Partial<React.ComponentProps<typeof Harness>> = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(<Harness client={client} {...props} />);
  await settle();
  return { client, ...view };
}

beforeAll(() => {
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-11-02T08:00:00.000Z"));
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(grid());
});

afterEach(() => {
  jest.useRealTimers();
});

const times = () =>
  within(screen.getByRole("list", { name: /^Times on/ }))
    .getAllByRole("button")
    .map((button) => button.textContent);

describe("MobileDayListPicker", () => {
  it("is its own scroll area, so the host's footer sits below the list instead of over it", async () => {
    await mount();
    const root = screen.getByTestId("mobile-day-list");
    expect(root).toHaveClass("min-h-0", "overflow-y-auto");
  });

  it("reads the grid for the consultee in the display zone and lists 14 days", async () => {
    await mount();
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("consulteeUserId=buyer-1");
    expect(url).toContain("timezone=UTC");
    expect(url).toContain("startDateInUtc=2026-11-02T00:00:00.000Z");
    expect(url).toContain("endDateInUtc=2026-11-16T00:00:00.000Z");

    const days = within(
      screen.getByRole("radiogroup", { name: "Day" }),
    ).getAllByRole("radio");
    expect(days).toHaveLength(14);
    expect(days[0]).toHaveAttribute("aria-checked", "true");
    expect(days[0]).toHaveAccessibleName(/3 times free/);
    expect(days[1]).toBeDisabled();
    expect(days[1]).toHaveAccessibleName(/no free times/);
  });

  it("offers only starts whose every atom is free: no partly booked, too soon or limit reached", async () => {
    await mount();
    expect(times()).toEqual([
      "9:00 am – 10:00 am",
      "9:30 am – 10:30 am",
      "2:00 pm – 3:00 pm",
    ]);
  });

  it("stops at timesNeeded and lets a picked time be tapped off", async () => {
    await mount({ timesNeeded: 1 });
    const first = screen.getByRole("button", { name: "9:00 am – 10:00 am" });
    fireEvent.click(first);
    expect(first).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", { name: "2:00 pm – 3:00 pm" }),
    ).toBeDisabled();
    expect(
      screen.getByText("You've picked all 1 time — tap one to change it."),
    ).toBeInTheDocument();
    expect(screen.getByText(/1 of 1 time picked/)).toBeInTheDocument();

    fireEvent.click(first);
    expect(first).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.getByRole("button", { name: "2:00 pm – 3:00 pm" }),
    ).toBeEnabled();
  });

  it("never lets two picks overlap", async () => {
    const onChange = jest.fn();
    await mount({ timesNeeded: 2, onChange });
    fireEvent.click(screen.getByRole("button", { name: "9:00 am – 10:00 am" }));
    const overlapping = screen.getByRole("button", {
      name: /^9:30 am – 10:30 am/,
    });
    expect(overlapping).toBeDisabled();
    expect(overlapping).toHaveTextContent("Overlaps a time you picked");
    fireEvent.click(overlapping);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "2:00 pm – 3:00 pm" }),
    ).toBeEnabled();
  });

  it("holds a plan to its per-day cap and asks the grid for its limits", async () => {
    await mount({
      timesNeeded: 2,
      subscriptionId: "sub-1",
      releasingIds: ["occ-2", "occ-1"],
      dayCap: { perDay: 1, zone: "UTC" },
    });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("subscriptionId=sub-1");
    expect(url).toContain(`releasing=${encodeURIComponent("occ-1,occ-2")}`);
    fireEvent.click(screen.getByRole("button", { name: "9:00 am – 10:00 am" }));
    const sameDay = screen.getByRole("button", { name: /^2:00 pm – 3:00 pm/ });
    expect(sameDay).toBeDisabled();
    expect(sameDay).toHaveTextContent("You already picked a time on this day");
  });

  it("moves between days with the arrow keys, skipping days with nothing free", async () => {
    await mount();
    const group = screen.getByRole("radiogroup", { name: "Day" });
    const days = within(group).getAllByRole("radio");
    expect(days[0]).toHaveAttribute("tabindex", "0");
    expect(days[2]).toHaveAttribute("tabindex", "-1");
    days[0].focus();
    fireEvent.keyDown(days[0], { key: "ArrowRight" });
    expect(days[2]).toHaveAttribute("aria-checked", "true");
    expect(days[2]).toHaveFocus();
    expect(times()).toEqual(["10:00 am – 11:00 am"]);
  });

  it("paints a pick a poll took as Just taken once, drops it and says so", async () => {
    const changes: DayListPick[][] = [];
    const pick = {
      startsAt: "2026-11-02T09:00:00.000Z",
      endsAt: "2026-11-02T10:00:00.000Z",
    };
    const { client } = await mount({
      initial: [pick],
      onChange: (next) => changes.push(next),
    });
    expect(changes).toEqual([]);

    fetchMock.mockResolvedValue(
      grid([
        {
          startsAt: "2026-11-02T09:30:00.000Z",
          bookingStatus: "fully-booked",
          isAllocated: true,
        },
      ]),
    );
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((batch) => records.push(...batch));
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributeFilter: ["data-just-taken"],
      attributeOldValue: true,
    });
    await act(async () => {
      await client.refetchQueries();
      await jest.advanceTimersByTimeAsync(10);
    });
    records.push(...observer.takeRecords());
    const painted = records.some(
      (record) =>
        // The attribute was added (it had no old value) at some commit.
        (record.attributeName === "data-just-taken" &&
          record.oldValue === null) ||
        [...record.addedNodes].some(
          (node) =>
            node instanceof HTMLElement &&
            node.querySelector('[data-just-taken="true"]') !== null,
        ),
    );
    observer.disconnect();

    expect(painted).toBe(true);
    expect(changes.at(-1)).toEqual([]);
    expect(document.querySelector('[data-just-taken="true"]')).toBeNull();
    expect(
      screen.getByText(/is no longer free, so we removed it/),
    ).toBeInTheDocument();
    expect(document.querySelectorAll('[aria-live="polite"]')).toHaveLength(1);
  });

  it("shows plain copy and a retry when the first read fails, and never uses the word slot", async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      status: 500,
      ok: false,
      json: async () => ({ error: "Internal: redis down" }),
      headers: { get: () => null },
    });
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    await mount();
    // The hook retries once before it gives up.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(5_000);
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "We couldn't load the available times.",
    );
    expect(document.body.textContent).not.toMatch(/redis/);

    fetchMock.mockResolvedValue(grid());
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await settle();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.body.textContent).not.toMatch(/\bslots?\b/i);
    expect(document.body.textContent).not.toMatch(/Any time works/);
  });

  describe("windows past the first two weeks", () => {
    const lastUrl = () =>
      String(fetchMock.mock.calls[fetchMock.mock.calls.length - 1][0]);
    const chipNames = () =>
      within(screen.getByRole("radiogroup", { name: "Day" }))
        .getAllByRole("radio")
        .map((chip) => chip.getAttribute("aria-label"));

    it("opens a plan whose window starts a month out on that window, read and drawn alike", async () => {
      fetchMock.mockImplementation(
        rangedGrid({
          "2026-12-03": ["2026-12-03T10:00:00Z", "2026-12-03T10:30:00Z"],
        }),
      );
      await mount({
        allowedStart: new Date("2026-12-02T00:00:00.000Z"),
        allowedEnd: new Date("2027-01-31T00:00:00.000Z"),
      });
      expect(lastUrl()).toContain("startDateInUtc=2026-12-02T00:00:00.000Z");
      expect(lastUrl()).toContain("endDateInUtc=2026-12-16T00:00:00.000Z");
      expect(chipNames()[0]).toMatch(/^Wed, 2 Dec/);
      expect(chipNames()).toHaveLength(14);
      expect(times()).toEqual(["10:00 am – 11:00 am"]);
      expect(
        screen.getByRole("button", { name: "Previous 2 weeks" }),
      ).toBeDisabled();
    });

    it("pages to a day past day 14 and keeps picks from every page", async () => {
      fetchMock.mockImplementation(
        rangedGrid({
          "2026-11-04": ["2026-11-04T10:00:00Z", "2026-11-04T10:30:00Z"],
          "2026-11-20": ["2026-11-20T09:00:00Z", "2026-11-20T09:30:00Z"],
        }),
      );
      await mount({
        timesNeeded: 2,
        allowedEnd: new Date("2026-11-30T00:00:00.000Z"),
      });
      fireEvent.click(
        screen.getByRole("button", { name: "10:00 am – 11:00 am" }),
      );

      fireEvent.click(screen.getByRole("button", { name: "Next 2 weeks" }));
      await settle();
      expect(lastUrl()).toContain("startDateInUtc=2026-11-16T00:00:00.000Z");
      expect(lastUrl()).toContain("endDateInUtc=2026-11-30T00:00:00.000Z");
      expect(chipNames()[0]).toMatch(/^Mon, 16 Nov/);
      fireEvent.click(
        screen.getByRole("button", { name: "9:00 am – 10:00 am" }),
      );
      expect(screen.getByText(/2 of 2 times picked/)).toBeInTheDocument();
      // The window ends inside this page.
      expect(
        screen.getByRole("button", { name: "Next 2 weeks" }),
      ).toBeDisabled();

      fireEvent.click(screen.getByRole("button", { name: "Previous 2 weeks" }));
      await settle();
      expect(chipNames()[0]).toMatch(/^Mon, 2 Nov/);
      const yours = within(
        screen.getByRole("heading", { name: "Your times" }).parentElement!,
      );
      expect(yours.getByText(/4 Nov/)).toBeInTheDocument();
      expect(yours.getByText(/20 Nov/)).toBeInTheDocument();
    });

    it("opens on the focused session's two weeks and pages back no further than today", async () => {
      fetchMock.mockImplementation(rangedGrid({}));
      await mount({ focusAt: new Date("2026-11-25T09:00:00.000Z") });
      expect(lastUrl()).toContain("startDateInUtc=2026-11-25T00:00:00.000Z");

      fireEvent.click(screen.getByRole("button", { name: "Previous 2 weeks" }));
      await settle();
      expect(lastUrl()).toContain("startDateInUtc=2026-11-11T00:00:00.000Z");
      fireEvent.click(screen.getByRole("button", { name: "Previous 2 weeks" }));
      await settle();
      expect(lastUrl()).toContain("startDateInUtc=2026-11-02T00:00:00.000Z");
      expect(
        screen.getByRole("button", { name: "Previous 2 weeks" }),
      ).toBeDisabled();
    });
  });
});

describe("MobileDayListPicker agrees with the desktop grid", () => {
  /** One day's answer, with whatever overlays the test adds. */
  function answer(
    cells: ReturnType<typeof atom>[],
    extra: Record<string, unknown> = {},
  ) {
    return {
      status: 200,
      ok: true,
      json: async () => ({ data: { "2026-11-04": cells }, ...extra }),
      headers: { get: () => null },
    };
  }

  const QUOTA = {
    unit: "week",
    capacity: 3,
    weekNumber: 3,
    weekCount: 26,
    filled: 3,
    remainingThisCycle: 0,
    allBooked: false,
    windowStart: "2026-11-02T00:00:00.000Z",
    windowEnd: "2026-11-09T00:00:00.000Z",
    planEndsAt: "2027-04-01T00:00:00.000Z",
    perDayCap: 1,
    fullDays: [],
    schedulingTimezone: "UTC",
  };

  it("asks for the same purpose and unpaid lead the desktop grid sends", async () => {
    await mount({ lead: { purpose: "allocate", unpaid: true } });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("purpose=allocate");
    expect(url).toContain("unpaid=1");
  });

  it("applies the server's lead time between polls, not a fixed 15 minutes", async () => {
    // Read at 08:00 with a 2-hour lead: nothing at or before 10:00 may start.
    fetchMock.mockResolvedValue({
      ...grid(),
      json: async () => ({
        ...(await grid().json()),
        leadMs: 2 * 60 * 60 * 1000,
      }),
    });
    await mount({ lead: { purpose: "allocate", unpaid: true } });
    expect(times()).toEqual(["2:00 pm – 3:00 pm"]);
  });

  it("says the limit is reached, with the plan's week line, instead of no free times", async () => {
    fetchMock.mockResolvedValue(
      answer(
        [
          atom("2026-11-04T10:00:00Z", { limitReached: true }),
          atom("2026-11-04T10:30:00Z", { limitReached: true }),
        ],
        { quota: QUOTA },
      ),
    );
    await mount({ subscriptionId: "sub-1" });
    expect(screen.getByText("Limit reached")).toBeInTheDocument();
    expect(
      screen.getAllByText(/Week 3 of 26 is set · next opens Mon,? 9 Nov/)
        .length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText(/No free times in these two weeks/)).toBeNull();
  });

  it("uses the desktop's words when a pick slides inside the lead time", async () => {
    const pick = {
      startsAt: "2026-11-04T10:00:00.000Z",
      endsAt: "2026-11-04T11:00:00.000Z",
    };
    fetchMock.mockResolvedValue(
      answer([atom("2026-11-04T10:00:00Z"), atom("2026-11-04T10:30:00Z")]),
    );
    const changes: DayListPick[][] = [];
    const { client } = await mount({
      initial: [pick],
      onChange: (next) => changes.push(next),
    });
    expect(changes).toEqual([]);

    fetchMock.mockResolvedValue(
      answer([
        atom("2026-11-04T10:00:00Z", { tooSoon: true }),
        atom("2026-11-04T10:30:00Z"),
      ]),
    );
    await act(async () => {
      await client.refetchQueries();
      await jest.advanceTimersByTimeAsync(10);
    });

    expect(changes.at(-1)).toEqual([]);
    expect(screen.getByText(/can't be booked any more/)).toBeInTheDocument();
    expect(screen.queryByText(/is no longer free/)).toBeNull();
  });

  it("offers a time that overlaps the moving session's own slot", async () => {
    // The session being moved holds 10:00–11:00; 11:00–12:00 is free.
    const cells = [
      atom("2026-11-04T10:00:00Z", {
        bookingStatus: "fully-booked",
        isAllocated: true,
      }),
      atom("2026-11-04T10:30:00Z", {
        bookingStatus: "fully-booked",
        isAllocated: true,
      }),
      atom("2026-11-04T11:00:00Z"),
      atom("2026-11-04T11:30:00Z"),
    ];
    fetchMock.mockResolvedValue(answer(cells));
    await mount({
      movingSessions: [
        {
          startsAt: "2026-11-04T10:00:00.000Z",
          endsAt: "2026-11-04T11:00:00.000Z",
        },
      ],
    });
    expect(times()).toContain("10:30 am – 11:30 am");
    expect(times()).toContain("11:00 am – 12:00 pm");
  });

  it("says bookings open up to 90 days ahead when that is why nothing is offered", async () => {
    fetchMock.mockResolvedValue(
      answer([
        atom("2026-11-04T10:00:00Z", { beyondHorizon: true }),
        atom("2026-11-04T10:30:00Z", { beyondHorizon: true }),
      ]),
    );
    await mount();
    expect(
      screen.getByText("Bookings open up to 90 days ahead."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No free times in these two weeks/)).toBeNull();
  });

  it("keeps another booking's busy time closed", async () => {
    fetchMock.mockResolvedValue(
      answer([
        atom("2026-11-04T10:00:00Z", {
          bookingStatus: "fully-booked",
          isAllocated: true,
        }),
        atom("2026-11-04T10:30:00Z", {
          bookingStatus: "fully-booked",
          isAllocated: true,
        }),
        atom("2026-11-04T11:00:00Z"),
        atom("2026-11-04T11:30:00Z"),
      ]),
    );
    await mount();
    expect(times()).toEqual(["11:00 am – 12:00 pm"]);
  });
});
