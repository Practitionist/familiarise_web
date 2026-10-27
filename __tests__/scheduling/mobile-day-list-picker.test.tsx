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

function Harness({
  client,
  initial = [],
  timesNeeded = 2,
  onChange,
  subscriptionId,
  releasingIds,
  dayCap,
}: Readonly<{
  client: QueryClient;
  initial?: DayListPick[];
  timesNeeded?: number;
  onChange?: (next: DayListPick[]) => void;
  subscriptionId?: string;
  releasingIds?: string[];
  dayCap?: { perDay: number; zone: string };
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
  it("reads the grid for the consultee in the display zone and lists 14 days", async () => {
    await mount();
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("consulteeUserId=buyer-1");
    expect(url).toContain("timezone=UTC");
    expect(url).toContain("startDateInUtc=2026-11-02T00:00:00.000Z");
    expect(url).toContain("endDateInUtc=2026-11-15T23:59:59.999Z");

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
});
