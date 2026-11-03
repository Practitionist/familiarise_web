/**
 * One lead-time contract for every writer and every grid that paints for it:
 * book 15 min, request/allocate 15 min settled or 2 h unpaid, reschedule 24 h.
 * A writer that adds its own number, or a grid that paints free what its
 * writer refuses, fails here.
 */
import { MINIMUM_BOOKING_LEAD_TIME_MS } from "@/lib/payments/constants";
import { readFileSync } from "fs";
import { join } from "path";
import {
  assertRequestLeadFits,
  assertUnpaidApprovalFits,
  isTooSoonFor,
  leadMsFor,
  RESCHEDULE_MIN_LEAD_HOURS,
} from "@/lib/booking/lead-time";
import { slotStartRefusal } from "@/lib/payments/utils/slot-validation";
import {
  windowsForDay,
  isBookableWindow,
} from "@/lib/scheduling/booking-windows";
import {
  describeAtom,
  type AtomContext,
} from "@/lib/scheduling/week-grid-model";

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = new Date("2026-11-03T06:00:00.000Z");

describe("leadMsFor is the one table", () => {
  it.each([
    ["book", true, 15 * MIN],
    ["request", true, 15 * MIN],
    ["request", false, 2 * HOUR],
    ["allocate", true, 15 * MIN],
    ["allocate", false, 2 * HOUR],
    ["reschedule", true, RESCHEDULE_MIN_LEAD_HOURS * HOUR],
  ] as const)("%s (settled %s) → %d ms", (purpose, settled, ms) => {
    expect(leadMsFor(purpose, { settled })).toBe(ms);
  });
});

describe("one boundary", () => {
  it("a start exactly at now + lead is too soon; one ms later is not", () => {
    const now = NOW.getTime();
    const lead = leadMsFor("reschedule");
    expect(isTooSoonFor("reschedule", { settled: true }, now + lead, now)).toBe(
      true,
    );
    expect(
      isTooSoonFor("reschedule", { settled: true }, now + lead + 1, now),
    ).toBe(false);
  });

  it("an unpaid approval and a priced request share it", () => {
    const edge = new Date(NOW.getTime() + 2 * HOUR);
    expect(() => assertUnpaidApprovalFits(edge, NOW)).toThrow(
      expect.objectContaining({ code: "TOO_CLOSE_TO_START" }),
    );
    expect(() => assertRequestLeadFits(150_000, edge, NOW)).toThrow(
      expect.objectContaining({ code: "REQUEST_TOO_SOON" }),
    );
  });
});

describe("every writer honours its row", () => {
  it("checkout refuses at the book lead and accepts just past it", () => {
    // now = 06:15, so the lead edge is the on-grid start 06:30.
    const quarter = new Date(NOW.getTime() + 15 * MIN);
    const edge = new Date(quarter.getTime() + leadMsFor("book"));
    expect(slotStartRefusal(edge, quarter)?.code).toBe("SLOT_TOO_SOON");
    expect(
      slotStartRefusal(new Date(edge.getTime() + 30 * MIN), quarter),
    ).toBeNull();
    expect(leadMsFor("book")).toBe(MINIMUM_BOOKING_LEAD_TIME_MS);
  });

  it("an unpaid approval refuses inside 2 h", () => {
    expect(() =>
      assertUnpaidApprovalFits(new Date(NOW.getTime() + 90 * MIN), NOW),
    ).toThrow(expect.objectContaining({ code: "TOO_CLOSE_TO_START" }));
    expect(() =>
      assertUnpaidApprovalFits(
        new Date(NOW.getTime() + 2 * HOUR + 30 * MIN),
        NOW,
      ),
    ).not.toThrow();
  });

  it("a priced request refuses inside 2 h up front; a free one takes 30 min", () => {
    const soon = new Date(NOW.getTime() + 30 * MIN);
    expect(() => assertRequestLeadFits(150_000, soon, NOW)).toThrow(
      expect.objectContaining({ code: "REQUEST_TOO_SOON" }),
    );
    expect(() => assertRequestLeadFits(0, soon, NOW)).not.toThrow();
    expect(() =>
      assertRequestLeadFits(150_000, new Date(NOW.getTime() + 150 * MIN), NOW),
    ).not.toThrow();
  });
});

describe("the grids paint by the same table", () => {
  const atom = (startMs: number) => ({
    startsAt: new Date(startMs).toISOString(),
    endsAt: new Date(startMs + 30 * MIN).toISOString(),
    bookingStatus: "available" as const,
  });

  it("the expert page drops priced request times inside 2 h", () => {
    const atoms = [1, 2, 3, 4, 5, 6].map((i) =>
      atom(NOW.getTime() + i * 30 * MIN),
    );
    const offered = windowsForDay(
      atoms,
      0.5,
      "UTC",
      NOW.getTime(),
      leadMsFor("request", { settled: false }),
    ).filter(isBookableWindow);
    expect(offered.map((w) => w.startsAt)).toEqual([
      new Date(NOW.getTime() + 150 * MIN).toISOString(),
      new Date(NOW.getTime() + 180 * MIN).toISOString(),
    ]);
  });

  it("a partly booked half-hour is never offered to a buyer", () => {
    const partly = {
      ...atom(NOW.getTime() + 4 * HOUR),
      bookingStatus: "partially-booked" as const,
    };
    const [window] = windowsForDay([partly], 0.5, "UTC", NOW.getTime());
    expect(isBookableWindow(window)).toBe(false);
  });

  it("the heat map re-applies the server's lead between polls", () => {
    const startMs = NOW.getTime() + 20 * HOUR;
    const ctx: AtomContext = {
      serverCells: new Map([
        [
          startMs,
          {
            startMs,
            endMs: startMs + 30 * MIN,
            bookingStatus: "available",
            tooSoon: false,
            limitReached: false,
            overlappingAppointments: [],
          },
        ],
      ]),
      eventStarts: new Set(),
      tentativeStarts: new Set(),
      selectedStarts: new Set(),
      justTakenStarts: new Set(),
      requestedStarts: new Set(),
      nowMs: NOW.getTime(),
      leadMs: leadMsFor("reschedule"),
    };
    expect(describeAtom(startMs, startMs + 30 * MIN, ctx).isTooSoon).toBe(true);
    expect(
      describeAtom(startMs, startMs + 30 * MIN, {
        ...ctx,
        leadMs: leadMsFor("book"),
      }).isTooSoon,
    ).toBe(false);
  });
});

// Client components read the contract, so it never reaches server-only code.
it("keeps lead-time.ts free of server-side booking modules", () => {
  const src = readFileSync(
    join(process.cwd(), "lib/booking/lead-time.ts"),
    "utf8",
  );
  const imports = [...src.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
  expect(imports.sort()).toEqual([
    "@/lib/booking/booking-rule-error",
    "@/lib/payments/constants",
  ]);
});
