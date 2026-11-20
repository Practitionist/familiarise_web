/**
 * A free time an accepted co-host has not published cannot be picked, because
 * the allocator refuses it. The grid says why, naming the co-host when the
 * viewer may see names.
 */
import {
  CONSULTANT_LEGEND_KEYS,
  isFreeStatusKey,
  outsideCoHostHoursLabel,
  resolveSlotStatusKey,
  SLOT_STATUS_TOKENS,
} from "@/lib/scheduling/interval-status-tokens";
import {
  isBookableWindow,
  windowsForDay,
} from "@/lib/scheduling/booking-windows";
import {
  atomIsFree,
  atomIsPlaceable,
  describeAtom,
  weekDayFits,
  type AtomContext,
  type ServerCell,
} from "@/lib/scheduling/week-grid-model";

const ATOM = 30 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 18, 4, 30);
const T = Date.UTC(2026, 10, 23, 3, 30);

function cell(extra: Partial<ServerCell> = {}): ServerCell {
  return {
    startMs: T,
    endMs: T + ATOM,
    bookingStatus: "available",
    tooSoon: false,
    limitReached: false,
    overlappingAppointments: [],
    ...extra,
  };
}

function context(server: ServerCell): AtomContext {
  const none = new Set<number>();
  return {
    serverCells: new Map([[server.startMs, server]]),
    eventStarts: none,
    tentativeStarts: none,
    selectedStarts: none,
    justTakenStarts: none,
    requestedStarts: none,
    nowMs: NOW,
  };
}

describe("outside a co-host's hours", () => {
  it("is its own state with a glyph and a label, and cannot be picked", () => {
    const token = SLOT_STATUS_TOKENS.outsideCoHostHours;
    expect(token.interactive).toBe(false);
    expect(token.icon).toBe("people");
    expect(token.label).toBe("Outside a co-host's hours");
    expect(CONSULTANT_LEGEND_KEYS).toContain("outsideCoHostHours");
  });

  it("names the co-host when exactly one name is known", () => {
    expect(outsideCoHostHoursLabel(["Arjun"])).toBe("Outside Arjun's hours");
    expect(outsideCoHostHoursLabel([])).toBe("Outside a co-host's hours");
    expect(outsideCoHostHoursLabel(["Arjun", "Meera"])).toBe(
      "Outside a co-host's hours",
    );
  });

  it("paints a flagged cell with that state and never offers it", () => {
    const atom = describeAtom(
      T,
      T + ATOM,
      context(cell({ outsideCoHostHours: true })),
    );
    expect(atom.statusKey).toBe("outsideCoHostHours");
    expect(isFreeStatusKey(atom.statusKey)).toBe(false);
    expect(atomIsFree(atom)).toBe(false);
    expect(atomIsPlaceable(atom)).toBe(false);
  });

  it("is not a window a single-session picker offers", () => {
    const [window] = windowsForDay(
      [
        { startsAt: new Date(T).toISOString(), outsideCoHostHours: true },
        { startsAt: new Date(T + ATOM).toISOString() },
      ],
      1,
      "UTC",
      NOW,
    );
    expect(window.outsideCoHostHours).toBe(true);
    expect(isBookableWindow(window)).toBe(false);
  });

  it("yields to every reason a time cannot be picked", () => {
    const flags = {
      isSelected: false,
      isThisEventSlot: false,
      isRescheduling: false,
      isBookedForDisplay: false,
      isPartiallyBooked: false,
      isAvailable: true,
      isInPast: false,
      isOutsideCoHostHours: true,
    };
    expect(resolveSlotStatusKey(flags)).toBe("outsideCoHostHours");
    expect(resolveSlotStatusKey({ ...flags, isTooSoon: true })).toBe("tooSoon");
    expect(resolveSlotStatusKey({ ...flags, isLimitReached: true })).toBe(
      "limitReached",
    );
    expect(resolveSlotStatusKey({ ...flags, isSelected: true })).toBe(
      "selected",
    );
  });

  it("does not count toward the sessions a day holds", () => {
    const matrix = [
      [{ startMs: T, statusKey: "outsideCoHostHours" as const }],
      [{ startMs: T + ATOM, statusKey: "available" as const }],
    ];
    expect(weekDayFits(matrix, 2)).toEqual([0]);
  });
});
