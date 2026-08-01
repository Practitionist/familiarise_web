// #1073 — the instant the slot picker opens on, and where that instant lands
// on the grid. Target selection is per-surface only in the sense that each
// surface hands the resolver a different set of sessions, so these cases are
// written as the shapes those subjects actually arrive in.

import type { SlotLike } from "@/lib/appointments/view-model";
import {
  earliestAvailabilityRow,
  focusGridPosition,
  resolveFocusTarget,
} from "@/lib/scheduling/slot-picker-focus";

const NOW = new Date("2026-08-01T09:00:00Z");

function session(
  id: string,
  startsAt: string,
  overrides: Partial<SlotLike> = {},
): SlotLike {
  return {
    id,
    appointmentId: `appt-${id}`,
    startsAt,
    endsAt: new Date(
      new Date(startsAt).getTime() + 60 * 60 * 1000,
    ).toISOString(),
    isTentative: false,
    ...overrides,
  };
}

describe("resolveFocusTarget", () => {
  it("targets the one session of a single-session consultation", () => {
    const focus = resolveFocusTarget(
      { slots: [session("s1", "2026-08-08T05:00:00Z")] },
      NOW,
    );

    expect(focus).toEqual({
      at: new Date("2026-08-08T05:00:00Z"),
      precision: "session",
    });
  });

  it("targets a past session when the single session has already run", () => {
    const focus = resolveFocusTarget(
      { slots: [session("s1", "2026-07-20T05:00:00Z")] },
      NOW,
    );

    expect(focus).toEqual({
      at: new Date("2026-07-20T05:00:00Z"),
      precision: "session",
    });
  });

  it("prefers the session awaiting a time over the next upcoming one", () => {
    // The released session is LATER than the next confirmed one, so picking it
    // cannot be an accident of sort order.
    const focus = resolveFocusTarget(
      {
        slots: [
          session("done", "2026-07-20T05:00:00Z"),
          session("next", "2026-08-02T05:00:00Z"),
          session("released", "2026-08-06T05:00:00Z", { isTentative: true }),
        ],
      },
      NOW,
    );

    expect(focus).toEqual({
      at: new Date("2026-08-06T05:00:00Z"),
      precision: "session",
    });
  });

  it("targets the next upcoming session of a fully-placed program", () => {
    const focus = resolveFocusTarget(
      {
        slots: [
          session("w1", "2026-07-20T05:00:00Z"),
          session("w3", "2026-08-10T05:00:00Z"),
          session("w2", "2026-08-04T05:00:00Z"),
        ],
      },
      NOW,
    );

    expect(focus).toEqual({
      at: new Date("2026-08-04T05:00:00Z"),
      precision: "session",
    });
  });

  it("falls back to the most recent session of a finished program", () => {
    const focus = resolveFocusTarget(
      {
        slots: [
          session("w1", "2026-06-01T05:00:00Z"),
          session("w3", "2026-07-15T05:00:00Z"),
          session("w2", "2026-06-20T05:00:00Z"),
        ],
      },
      NOW,
    );

    expect(focus).toEqual({
      at: new Date("2026-07-15T05:00:00Z"),
      precision: "session",
    });
  });

  it("ignores sessions that were cancelled or already moved", () => {
    const focus = resolveFocusTarget(
      {
        slots: [
          session("gone", "2026-08-02T05:00:00Z", {
            completionStatus: "CANCELLED",
          }),
          session("moved", "2026-08-03T05:00:00Z", {
            completionStatus: "RESCHEDULED",
          }),
          session("live", "2026-08-09T05:00:00Z"),
        ],
      },
      NOW,
    );

    expect(focus.at).toEqual(new Date("2026-08-09T05:00:00Z"));
  });

  it("targets the start of the scheduling period when nothing is scheduled", () => {
    // An `unscheduled-class-<id>` subject: a period, and no sessions at all.
    const focus = resolveFocusTarget(
      {
        allowedStart: new Date("2026-09-01T00:00:00Z"),
        allowedEnd: new Date("2026-11-30T00:00:00Z"),
      },
      NOW,
    );

    expect(focus).toEqual({
      at: new Date("2026-09-01T00:00:00Z"),
      precision: "period",
    });
  });

  it("never opens on a period start that has already passed", () => {
    const focus = resolveFocusTarget(
      {
        allowedStart: new Date("2026-07-01T00:00:00Z"),
        allowedEnd: new Date("2026-11-30T00:00:00Z"),
      },
      NOW,
    );

    expect(focus).toEqual({ at: NOW, precision: "period" });
  });

  it("opens on the last day of a period that has already closed", () => {
    const focus = resolveFocusTarget(
      {
        allowedStart: new Date("2026-05-01T00:00:00Z"),
        allowedEnd: new Date("2026-06-30T00:00:00Z"),
      },
      NOW,
    );

    expect(focus).toEqual({
      at: new Date("2026-06-30T00:00:00Z"),
      precision: "period",
    });
  });

  it("falls back to now when there is neither a session nor a period", () => {
    expect(resolveFocusTarget({}, NOW)).toEqual({
      at: NOW,
      precision: "period",
    });
  });
});

describe("focusGridPosition", () => {
  // One instant, three zones. The row and the calendar date both move with the
  // zone — reading either in the viewer's zone instead of the grid's is how
  // focus lands an offset away (#1064's defect class).
  const at = new Date("2026-08-01T02:30:00Z");

  it("reads the row in the timezone it is given, not the viewer's", () => {
    expect(focusGridPosition(at, "UTC")).toEqual({
      year: 2026,
      month: 8,
      day: 1,
      hour: 2,
      minute: 30,
      rowIndex: 5,
    });

    expect(focusGridPosition(at, "Asia/Kolkata")).toEqual({
      year: 2026,
      month: 8,
      day: 1,
      hour: 8,
      minute: 0,
      rowIndex: 16,
    });
  });

  it("moves the calendar date too when the zone pushes across midnight", () => {
    // 22:30 the previous evening in New York — a different day, and therefore
    // a different week column, from the same instant.
    expect(focusGridPosition(at, "America/New_York")).toEqual({
      year: 2026,
      month: 7,
      day: 31,
      hour: 22,
      minute: 30,
      rowIndex: 45,
    });
  });

  it("puts midnight on the first row", () => {
    expect(
      focusGridPosition(new Date("2026-08-01T00:00:00Z"), "UTC").rowIndex,
    ).toBe(0);
  });
});

describe("earliestAvailabilityRow", () => {
  it("returns the earliest published time of day across the week", () => {
    const row = earliestAvailabilityRow(
      [
        { startTime: new Date("2026-08-03T14:00:00Z") },
        { startTime: new Date("2026-08-04T09:30:00Z") },
        { startTime: new Date("2026-08-05T11:00:00Z") },
      ],
      "UTC",
    );

    expect(row).toBe(19); // 09:30
  });

  it("returns null when the consultant has published nothing", () => {
    expect(earliestAvailabilityRow([], "UTC")).toBeNull();
  });
});
