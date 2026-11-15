/**
 * The single-time picker: the month is a keyboard grid; a host sees booked
 * times labelled and reveals outside-hours times with a switch; a buyer sees
 * free times, and booked or held ones behind "Show N taken times", each with
 * "Notify me"; a pick a later read shows gone is cleared, the pane says so and
 * the taken list opens.
 */
import * as React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";

let mockMonth: Record<string, unknown[]> = {};
let mockReadAt = 0;
jest.mock("@/lib/scheduling/use-availability-window", () => ({
  ...jest.requireActual("@/lib/scheduling/use-availability-window"),
  useAvailabilityMonth: ({ timezone }: { timezone: string | null }) => ({
    data: timezone ? mockMonth : undefined,
    dataUpdatedAt: mockReadAt,
    isPending: !timezone,
    isError: false,
    refetch: jest.fn(),
  }),
}));
jest.mock("@/components/booking/NotifyWhenFreeButton", () => ({
  NotifyWhenFreeButton: () => <span>Notify me</span>,
}));

import {
  SingleTimePicker,
  TIME_JUST_TAKEN_MESSAGE,
  type SingleTimePickerProps,
  type SingleTimeValue,
} from "@/components/scheduling/SingleTimePicker";

const HOUR = 3_600_000;
const DAY = Date.parse("2026-11-04T00:00:00.000Z");

function atoms(fromH: number, toH: number, booked: number[] = []) {
  const out = [];
  for (let h = fromH; h < toH; h += 0.5) {
    out.push({
      startsAt: new Date(DAY + h * HOUR).toISOString(),
      endsAt: new Date(DAY + (h + 0.5) * HOUR).toISOString(),
      bookingStatus: booked.includes(h) ? "fully-booked" : "available",
    });
  }
  return out;
}

function Harness(
  props: Partial<SingleTimePickerProps> & {
    onPick?: (value: SingleTimeValue | null) => void;
  },
) {
  const [value, setValue] = React.useState<SingleTimeValue | null>(null);
  return (
    <SingleTimePicker
      consultantId="cp-1"
      sessionMinutes={60}
      zone="UTC"
      theme="light"
      audience="buyer"
      purpose="book"
      value={value}
      onChange={(next) => {
        props.onPick?.(next);
        setValue(next);
      }}
      {...props}
    />
  );
}

beforeEach(() => {
  mockReadAt = 0;
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-11-02T09:00:00.000Z"));
  mockMonth = { "2026-11-04": atoms(9, 13, [11]) };
});
afterEach(() => jest.useRealTimers());

const time = (name: RegExp) => screen.getByRole("button", { name });

it("moves through the month with the keyboard", () => {
  render(<Harness />);
  const day4 = screen.getByRole("button", { name: /\b4 November/ });
  expect(day4).toHaveAttribute("tabindex", "0");
  act(() => day4.focus());
  fireEvent.keyDown(day4, { key: "ArrowDown" });
  expect(screen.getByRole("button", { name: /11 November/ })).toHaveFocus();
  fireEvent.keyDown(document.activeElement as Element, { key: "End" });
  expect(screen.getByRole("button", { name: /15 November/ })).toHaveFocus();
  fireEvent.keyDown(document.activeElement as Element, { key: "PageDown" });
  expect(screen.getByRole("heading", { name: "December 2026" })).toBeVisible();
  expect(screen.getByRole("button", { name: /15 December/ })).toHaveFocus();
});

it("shows a buyer free times and lists booked and held ones behind a disclosure", () => {
  render(
    <Harness
      heldStarts={new Map([[DAY + 9 * HOUR, Date.now()]])}
      notifyPlan={{ planKind: "CONSULTATION", planId: "plan-1" }}
    />,
  );
  expect(screen.getByText("Times in UTC")).toBeVisible();
  expect(time(/^9:30 am to 10:30 am, free/)).toBeEnabled();
  expect(screen.queryByRole("button", { name: /^9:00 am/ })).toBeNull();
  const toggle = screen.getByRole("button", { name: "Show 3 taken times" });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByText("Notify me")).toBeNull();
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(toggle).toHaveTextContent("Hide taken times");
  const rows = screen.getAllByRole("listitem");
  expect(rows.map((row) => row.textContent)).toEqual([
    expect.stringMatching(/^9:00 am to 10:00 am, taken, someone else/),
    expect.stringMatching(/^10:30 am to 11:30 am, taken/),
    expect.stringMatching(/^11:00 am to 12:00 pm, taken/),
  ]);
  expect(screen.getAllByText("Notify me")).toHaveLength(3);
  expect(screen.getByText("You can wait on up to 3 times.")).toBeVisible();
});

it("lets a host reveal times outside their hours", () => {
  render(<Harness audience="host" purpose="create" />);
  expect(time(/^10:30 am to 11:30 am, booked/)).toHaveTextContent("Booked");
  expect(screen.queryByRole("button", { name: /^1:00 pm/ })).toBeNull();
  fireEvent.click(
    screen.getByRole("switch", { name: /Show times outside my hours/ }),
  );
  fireEvent.click(time(/^1:00 pm to 2:00 pm, outside your hours/));
  expect(time(/^1:00 pm to 2:00 pm/)).toHaveAttribute("aria-pressed", "true");
});

it("clears a pick a later read shows taken, and says so", () => {
  const picks: (SingleTimeValue | null)[] = [];
  const { rerender } = render(<Harness onPick={(v) => picks.push(v)} />);
  fireEvent.click(time(/^9:00 am to 10:00 am, free/));
  mockMonth = { "2026-11-04": atoms(9, 13, [9, 11]) };
  act(() => {
    rerender(<Harness onPick={(v) => picks.push(v)} />);
  });
  expect(picks.at(-1)).toBeNull();
  expect(screen.getByRole("status")).toHaveTextContent(TIME_JUST_TAKEN_MESSAGE);
  expect(
    screen.getByRole("button", { name: "Hide taken times" }),
  ).toHaveAttribute("aria-expanded", "true");
});

it("drops the pick when another day is chosen", () => {
  const picks: (SingleTimeValue | null)[] = [];
  render(<Harness onPick={(v) => picks.push(v)} />);
  fireEvent.click(time(/^9:30 am to 10:30 am, free/));
  expect(picks.at(-1)).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /\b5 November/ }));
  expect(picks.at(-1)).toBeNull();
});

it("keeps the pick's availability row current when a save re-ids it", () => {
  const withRow = (id: string) =>
    atoms(9, 13).map((cell) => ({
      ...cell,
      availabilityWindowId: id,
      type: "WEEKLY",
    }));
  mockMonth = { "2026-11-04": withRow("row-a") };
  const picks: (SingleTimeValue | null)[] = [];
  const { rerender } = render(<Harness onPick={(v) => picks.push(v)} />);
  fireEvent.click(time(/^9:30 am to 10:30 am, free/));
  expect(picks.at(-1)?.window?.id).toBe("row-a");
  mockMonth = { "2026-11-04": withRow("row-b") };
  act(() => {
    rerender(<Harness onPick={(v) => picks.push(v)} />);
  });
  expect(picks.at(-1)?.window).toEqual({ id: "row-b", type: "WEEKLY" });
});

it("lets a grid read newer than a refusal answer for that time again", () => {
  const held = new Map([[DAY + 9 * HOUR, Date.now()]]);
  mockReadAt = Date.now() + 1;
  render(<Harness heldStarts={held} />);
  expect(time(/^9:00 am to 10:00 am, free/)).toBeEnabled();
});

it("puts the panes side by side only when its own width allows", () => {
  let resize: ResizeObserverCallback = () => {};
  const original = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) {
      resize = callback;
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  try {
    const { container } = render(<Harness />);
    const root = container.firstElementChild as HTMLElement;
    const widthOf = (width: number) =>
      act(() =>
        resize(
          [{ contentRect: { width } } as ResizeObserverEntry],
          {} as ResizeObserver,
        ),
      );
    expect(root).toHaveAttribute("data-layout", "stacked");
    widthOf(900);
    expect(root).toHaveAttribute("data-layout", "side-by-side");
    widthOf(480);
    expect(root).toHaveAttribute("data-layout", "stacked");
  } finally {
    globalThis.ResizeObserver = original;
  }
});
