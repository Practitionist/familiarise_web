/**
 * Regular time: projection to UTC per fixed plan week, the off-grid refusal,
 * DST, the plan end, catch-up capacity and the derived conflict list.
 */
import {
  isOnLattice,
  placeableSlots,
  projectRegularSlots,
  regularSlotsRefusal,
  regularTimeLabel,
} from "@/lib/booking/regular-time/project";
import { backlog, weekCapacity } from "@/lib/booking/regular-time/catch-up";
import {
  conflictCount,
  deriveHorizonConflicts,
  isMissedWeek,
} from "@/lib/booking/regular-time/conflicts";
import { hostHoursPredicate } from "@/lib/booking/regular-time/availability";

const HOUR = 3_600_000;
const iso = (d: Date) => d.toISOString();

describe("projectRegularSlots", () => {
  it("T1: Mon/Wed/Fri 18:00 IST × 4 weeks gives 12 starts on the plan weeks", () => {
    // Plan starts Wed 4 Nov 2026 in Kolkata: week 0 is Wed 4 … Tue 10.
    const slots = projectRegularSlots({
      slots: [
        { weekday: 1, localStartMinutes: 18 * 60 },
        { weekday: 3, localStartMinutes: 18 * 60 },
        { weekday: 5, localStartMinutes: 18 * 60 },
      ],
      timeZone: "Asia/Kolkata",
      planStartsAt: new Date("2026-11-04T04:30:00Z"),
      planEndsAt: new Date("2027-05-04T00:00:00Z"),
      fromWeek: 0,
      weeks: 4,
      sessionMinutes: 60,
    });
    expect(slots).toHaveLength(12);
    expect(
      slots.slice(0, 4).map((s) => [s.weekIndex, iso(s.startsAt)]),
    ).toEqual([
      [0, "2026-11-04T12:30:00.000Z"],
      [0, "2026-11-06T12:30:00.000Z"],
      [0, "2026-11-09T12:30:00.000Z"],
      [1, "2026-11-11T12:30:00.000Z"],
    ]);
    expect(slots.map((s) => s.weekIndex)).toEqual([
      0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3,
    ]);
    expect(
      slots.every((s) => s.endsAt.getTime() - s.startsAt.getTime() === HOUR),
    ).toBe(true);
    expect(slots.every((s) => isOnLattice(s.startsAt))).toBe(true);
  });

  it("T2: Kathmandu 09:00 is refused off-grid, naming 08:45 and 09:15", () => {
    const ctx = {
      perWeek: 1,
      timeZone: "Asia/Kathmandu",
      planStartsAt: new Date("2026-11-02T03:00:00Z"),
      planEndsAt: new Date("2027-02-01T00:00:00Z"),
      fromWeek: 0,
      weeks: 13,
    };
    const refusal = regularSlotsRefusal(
      [{ weekday: 2, localStartMinutes: 9 * 60 }],
      ctx,
    );
    expect(refusal?.code).toBe("REGULAR_TIME_OFF_GRID");
    expect(refusal?.message).toContain("08:45");
    expect(refusal?.message).toContain("09:15");
    for (const minutes of [8 * 60 + 45, 9 * 60 + 15]) {
      expect(
        regularSlotsRefusal([{ weekday: 2, localStartMinutes: minutes }], ctx),
      ).toBeNull();
    }
  });

  it("T3: London spring-forward 01:30 resolves forward; fall-back 01:30 takes the first", () => {
    const spring = projectRegularSlots({
      slots: [{ weekday: 7, localStartMinutes: 90 }],
      timeZone: "Europe/London",
      planStartsAt: new Date("2027-03-22T09:00:00Z"),
      planEndsAt: new Date("2027-06-22T00:00:00Z"),
      fromWeek: 0,
      weeks: 1,
      sessionMinutes: 60,
    });
    // 01:30 GMT doesn't exist on 28 Mar 2027; 02:30 BST is 01:30Z.
    expect(iso(spring[0].startsAt)).toBe("2027-03-28T01:30:00.000Z");
    expect(isOnLattice(spring[0].startsAt)).toBe(true);

    const fall = projectRegularSlots({
      slots: [{ weekday: 7, localStartMinutes: 90 }],
      timeZone: "Europe/London",
      planStartsAt: new Date("2026-10-19T09:00:00Z"),
      planEndsAt: new Date("2027-01-19T00:00:00Z"),
      fromWeek: 0,
      weeks: 1,
      sessionMinutes: 60,
    });
    // 01:30 happens twice on 25 Oct 2026: 00:30Z (BST) then 01:30Z (GMT).
    expect(iso(fall[0].startsAt)).toBe("2026-10-25T00:30:00.000Z");
    expect(isOnLattice(fall[0].startsAt)).toBe(true);
  });

  it("T4: slots that end after planEndsAt are dropped as PAST_PLAN_END", () => {
    const slots = projectRegularSlots({
      slots: [
        { weekday: 1, localStartMinutes: 18 * 60 },
        { weekday: 5, localStartMinutes: 18 * 60 },
      ],
      timeZone: "Asia/Kolkata",
      planStartsAt: new Date("2026-11-02T04:30:00Z"),
      // Ends Thu 12 Nov, so week 1's Friday is past the end.
      planEndsAt: new Date("2026-11-12T00:00:00Z"),
      fromWeek: 0,
      weeks: 2,
      sessionMinutes: 60,
    });
    expect(slots.map((s) => s.pastPlanEnd)).toEqual([
      false,
      false,
      false,
      true,
    ]);
    expect(placeableSlots(slots)).toHaveLength(3);
  });

  it("refuses the wrong count and two slots on one day", () => {
    const ctx = {
      perWeek: 2,
      timeZone: "Asia/Kolkata",
      planStartsAt: new Date("2026-11-02T04:30:00Z"),
      planEndsAt: new Date("2027-02-02T00:00:00Z"),
      fromWeek: 0,
      weeks: 13,
    };
    expect(
      regularSlotsRefusal([{ weekday: 1, localStartMinutes: 600 }], ctx)?.code,
    ).toBe("REGULAR_TIME_SLOT_COUNT");
    expect(
      regularSlotsRefusal(
        [
          { weekday: 1, localStartMinutes: 600 },
          { weekday: 1, localStartMinutes: 900 },
        ],
        ctx,
      )?.code,
    ).toBe("REGULAR_TIME_SAME_DAY");
  });

  it("labels the Regular time plainly", () => {
    expect(
      regularTimeLabel([
        { weekday: 5, localStartMinutes: 1080 },
        { weekday: 1, localStartMinutes: 1080 },
        { weekday: 3, localStartMinutes: 1080 },
      ]),
    ).toBe("Mon, Wed, Fri at 18:00");
    expect(
      regularTimeLabel([
        { weekday: 4, localStartMinutes: 1080 },
        { weekday: 1, localStartMinutes: 540 },
      ]),
    ).toBe("Mon 09:00, Thu 18:00");
  });
});

describe("catch-up", () => {
  const base = {
    perWeek: 3,
    sessionsTotal: 12,
    sessionsRefunded: 0,
    daysInWeek: () => 7,
  };

  it("T5: two missed in week 1 → weeks 2 and 3 hold 4 until the backlog is 0", () => {
    // Week 0 held 1 of 3.
    expect(weekCapacity({ ...base, heldByWeek: [1] }, 1)).toBe(4);
    // Week 1 filled its 4: one left behind, week 2 still holds 4.
    expect(backlog({ ...base, heldByWeek: [1, 4] }, 2)).toBe(1);
    expect(weekCapacity({ ...base, heldByWeek: [1, 4] }, 2)).toBe(4);
    // Week 2 filled 4: caught up, week 3 is back to 3.
    expect(backlog({ ...base, heldByWeek: [1, 4, 4] }, 3)).toBe(0);
    expect(weekCapacity({ ...base, heldByWeek: [1, 4, 4] }, 3)).toBe(3);
    // Never two a day: a 3-day week holds 3 even with a backlog.
    expect(
      weekCapacity({ ...base, heldByWeek: [1], daysInWeek: () => 3 }, 1),
    ).toBe(3);
  });

  it("T6: sessionsRefunded reduces the backlog and the remaining total", () => {
    const refunded = { ...base, sessionsRefunded: 2, heldByWeek: [1] };
    expect(backlog(refunded, 1)).toBe(0);
    expect(weekCapacity(refunded, 1)).toBe(3);
    // 12 sold, 3 refunded, 8 held elsewhere: one session remains for week 3.
    const nearlyDone = {
      ...base,
      sessionsRefunded: 3,
      heldByWeek: [3, 3, 2, 0],
    };
    expect(weekCapacity(nearlyDone, 3)).toBe(1);
  });
});

describe("deriveHorizonConflicts", () => {
  const now = new Date("2026-11-09T00:00:00Z");
  const week = (k: number, held: number) => ({
    weekIndex: k,
    capacity: 3,
    held,
    startsAt: new Date(Date.UTC(2026, 10, 9 + 7 * (k - 1))),
    endsAt: new Date(Date.UTC(2026, 10, 16 + 7 * (k - 1))),
  });
  const slot = (k: number, startIso: string, pastPlanEnd = false) => ({
    weekIndex: k,
    weekday: 1,
    localStartMinutes: 0,
    startsAt: new Date(startIso),
    endsAt: new Date(new Date(startIso).getTime() + HOUR),
    pastPlanEnd,
  });

  it("T9: TAKEN, OUTSIDE_HOURS, HOURS_CHANGED and TOO_SOON", () => {
    const placedOutside = {
      id: "occ-1",
      startsAt: new Date("2026-11-13T12:00:00Z"),
      endsAt: new Date("2026-11-13T13:00:00Z"),
    };
    const views = deriveHorizonConflicts({
      weeks: [week(1, 1)],
      projected: [
        slot(1, "2026-11-09T00:10:00Z"), // inside the lead
        slot(1, "2026-11-10T12:00:00Z"), // another buyer holds it
        slot(1, "2026-11-11T20:00:00Z"), // hours shrank
        slot(1, "2026-11-13T12:00:00Z"), // placed
      ],
      own: [placedOutside],
      hostBusy: [
        {
          startsAt: new Date("2026-11-10T12:30:00Z"),
          endsAt: new Date("2026-11-10T13:30:00Z"),
        },
      ],
      isAvailable: (s) => s.getUTCHours() < 18 && s.getUTCDate() !== 13,
      now,
      leadMs: 15 * 60_000,
    });
    expect(views[0].conflicts.map((c) => c.reason)).toEqual([
      "TOO_SOON",
      "TAKEN",
      "OUTSIDE_HOURS",
      "HOURS_CHANGED",
    ]);
    expect(views[0].conflicts[3].occurrenceId).toBe("occ-1");
    expect(views[0].shortBy).toBe(2);
    expect(conflictCount(views)).toBe(4);
  });

  it("a full week lists no unplaced slots, and a past under-quota week is missed", () => {
    const views = deriveHorizonConflicts({
      weeks: [week(1, 3)],
      projected: [slot(1, "2026-11-11T20:00:00Z")],
      own: [],
      hostBusy: [],
      isAvailable: () => false,
      now,
      leadMs: 0,
    });
    expect(views[0].conflicts).toEqual([]);
    expect(isMissedWeek(week(0, 2), now)).toBe(true);
    expect(isMissedWeek(week(0, 3), now)).toBe(false);
  });

  it("T10: a multi-day custom row is availability for every day it covers", () => {
    const isAvailable = hostHoursPredicate({
      userId: "u1",
      scheduleType: "CUSTOM",
      availabilityWindowsWeekly: [],
      availabilityWindowsCustom: [
        {
          id: "row-1",
          startsAt: new Date("2026-11-09T00:00:00Z"),
          endsAt: new Date("2026-11-12T00:00:00Z"),
        },
      ],
    });
    const views = deriveHorizonConflicts({
      weeks: [week(1, 0)],
      projected: [
        slot(1, "2026-11-10T12:00:00Z"),
        slot(1, "2026-11-11T23:00:00Z"),
        slot(1, "2026-11-12T12:00:00Z"),
      ],
      own: [],
      hostBusy: [],
      isAvailable,
      now,
      leadMs: 0,
    });
    expect(views[0].conflicts.map((c) => [c.reason, iso(c.startsAt)])).toEqual([
      ["OUTSIDE_HOURS", "2026-11-12T12:00:00.000Z"],
    ]);
  });
});
