/**
 * #1838 — the client hook carries no state of its own.
 *
 * The grace window is derived from the slot's end rather than stored, which is
 * what makes it correct across Lambda instances. The one place that could
 * quietly undo that is a hook that MEMOISES the window: a memo keyed on
 * something other than the clock would freeze the ladder on whichever rung it
 * happened to compute first, and on a long call that first render is T+0 —
 * which would leave a session displaying "you're in grace" for an hour while
 * nobody was counting the billable minutes.
 *
 * So the assertion is that the same mounted component walks the whole ladder as
 * the clock advances, with no server round trip in between.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { useOverrunLadder } from "../../lib/meetings/session-info";

const START = new Date("2026-08-01T12:30:00.000Z");
const END = new Date("2026-08-01T13:30:00.000Z");

let clock = new Date("2026-08-01T13:00:00.000Z");

function Probe({ hardStopAt = null as Date | null }) {
  const { ladder } = useOverrunLadder({
    bookedEndsAt: END,
    startsAt: START,
    hardStopAt,
    rate: { planPricePaise: 60_000, bookedMinutes: 60 },
    now: () => clock,
  });
  return <span data-testid="rung">{ladder.rung}</span>;
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  clock = new Date("2026-08-01T13:00:00.000Z");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function mount(props: { hardStopAt?: Date | null } = {}) {
  await act(async () => {
    root.render(<Probe {...props} />);
  });
}

async function advance(to: string) {
  clock = new Date(to);
  await act(async () => {
    jest.advanceTimersByTime(1000);
  });
}

const rung = () => host.querySelector('[data-testid="rung"]')?.textContent;

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

describe("the ladder hook tracks the clock rather than its own memory", () => {
  it("walks every rung in order as the session runs over", async () => {
    await mount();
    expect(rung()).toBe("in-progress");

    // T-5.
    await advance("2026-08-01T13:25:00.000Z");
    expect(rung()).toBe("wrapping-up");

    // T+0 — free grace opens.
    await advance("2026-08-01T13:30:00.000Z");
    expect(rung()).toBe("grace");

    // Grace ends and the free time runs out.
    await advance("2026-08-01T13:40:00.000Z");
    expect(rung()).toBe("grace-expired");

    // The fallback stop is 30 minutes past the booked end.
    await advance("2026-08-01T13:58:00.000Z");
    expect(rung()).toBe("hard-close-warning");

    await advance("2026-08-01T14:00:00.000Z");
    expect(rung()).toBe("closed");
  });

  it("uses a caller-supplied stop instead of the fallback", async () => {
    await mount({ hardStopAt: new Date("2026-08-01T15:00:00.000Z") });

    await advance("2026-08-01T13:40:00.000Z");
    expect(rung()).toBe("grace-expired");

    // 13:58 is inside two minutes of the FALLBACK stop, but nowhere near the
    // supplied one — so nothing is announced and nothing is sold at the cap.
    await advance("2026-08-01T13:58:00.000Z");
    expect(rung()).toBe("grace-expired");

    await advance("2026-08-01T14:58:00.000Z");
    expect(rung()).toBe("hard-close-warning");

    await advance("2026-08-01T15:00:00.000Z");
    expect(rung()).toBe("closed");
  });

  it("makes no request while it ticks", async () => {
    global.fetch = jest.fn(() => Promise.reject(new Error("no"))) as never;
    await mount();
    await advance("2026-08-01T13:31:00.000Z");
    // The issue's load requirement: no new poller. The tick is local.
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
