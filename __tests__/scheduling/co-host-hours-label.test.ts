/**
 * A free time an accepted co-host has not published stays pickable: the grid
 * only labels it, naming the co-host when the viewer may see names.
 */
import {
  CONSULTANT_LEGEND_KEYS,
  isFreeStatusKey,
  outsideCoHostHoursLabel,
  resolveSlotStatusKey,
  SLOT_STATUS_TOKENS,
} from "@/lib/scheduling/interval-status-tokens";
import {
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
  it("is its own selectable state with a glyph and a label", () => {
    const token = SLOT_STATUS_TOKENS.outsideCoHostHours;
    expect(token.interactive).toBe(true);
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

  it("paints a flagged free cell with that state and keeps it free", () => {
    const atom = describeAtom(
      T,
      T + ATOM,
      context(cell({ outsideCoHostHours: true })),
    );
    expect(atom.statusKey).toBe("outsideCoHostHours");
    expect(atom.isAvailable).toBe(true);
    expect(isFreeStatusKey(atom.statusKey)).toBe(true);
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

  it("counts toward the sessions a day holds", () => {
    const matrix = [
      [{ startMs: T, statusKey: "outsideCoHostHours" as const }],
      [{ startMs: T + ATOM, statusKey: "available" as const }],
    ];
    expect(weekDayFits(matrix, 2)).toEqual([1]);
  });
});
