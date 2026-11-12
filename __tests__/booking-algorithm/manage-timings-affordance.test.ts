/**
 * The three time-change affordances on the consultant's appointment menu.
 *
 * Manage Timings writes new times straight onto the calendar with no notice
 * requirement and no acceptance from anyone, so it may only be offered where
 * nobody else has committed to a time. Where somebody has, the negotiated
 * Reschedule takes its place — the two are alternatives, and offering both
 * would hand a consultant a way around the proposal (#1082).
 *
 * A webinar or class is re-planned only while no seat is live. Once a seat is
 * sold, a webinar moves by Re-time (attendees are told and may leave in full)
 * and a class by its series re-time or cancel + make-up; never by Timings.
 */

import {
  allowsManageTimings,
  occurrencesAllowReschedule,
  upcomingOccurrences,
} from "@/lib/appointments/occurrences";
import { allowsRetime } from "@/lib/booking/reschedule-proposals";
import type { AppointmentKind } from "@/lib/appointments/view-model";

type TestSlot = {
  startsAt: Date;
  isTentative?: boolean | null;
  completionStatus?: string | null;
};

const HOUR = 3_600_000;
const inHours = (hours: number) => new Date(Date.now() + hours * HOUR);
const confirmed: TestSlot[] = [
  { startsAt: inHours(72), isTentative: false, completionStatus: "SCHEDULED" },
];
const tentative: TestSlot[] = [
  { startsAt: inHours(72), isTentative: true, completionStatus: null },
];
const nothingAllocated: TestSlot[] = [];

const isGroup = (kind: AppointmentKind) =>
  kind === "WEBINAR" || kind === "CLASS";

/** Mirrors ConsultantAppointmentsAdapter's two guards, minus the status checks. */
function offered(kind: AppointmentKind, slots: TestSlot[], liveSeats = 0) {
  const timings = allowsManageTimings(kind, slots, liveSeats);
  return {
    timings,
    reschedule: !isGroup(kind) && !timings && occurrencesAllowReschedule(slots),
  };
}

/** All three menu gates together, which is how a consultant actually meets them. */
function menu(kind: AppointmentKind, slots: TestSlot[], liveSeats = 0) {
  return {
    ...offered(kind, slots, liveSeats),
    retime: allowsRetime(kind, slots),
  };
}

describe("allowsManageTimings", () => {
  it("keeps Timings on a scheduled webinar nobody has bought yet", () => {
    expect(offered("WEBINAR", confirmed)).toEqual({
      timings: true,
      reschedule: false,
    });
  });

  it("withdraws Timings from a webinar or class once a seat is live", () => {
    // A full re-plan would move paid attendees with no notice and no free
    // leave; the sold event moves by Re-time instead.
    expect(offered("WEBINAR", confirmed, 1)).toEqual({
      timings: false,
      reschedule: false,
    });
    expect(offered("CLASS", confirmed, 3)).toEqual({
      timings: false,
      reschedule: false,
    });
  });

  it("keeps Timings on a class instance", () => {
    expect(offered("CLASS", confirmed)).toEqual({
      timings: true,
      reschedule: false,
    });
  });

  it("keeps Timings on an offering that was never scheduled", () => {
    // The `unscheduled-class-…` / `unscheduled-webinar-…` rows: no Appointment
    // row at all, so no slots.
    expect(offered("CLASS", nothingAllocated)).toEqual({
      timings: true,
      reschedule: false,
    });
    expect(offered("WEBINAR", nothingAllocated)).toEqual({
      timings: true,
      reschedule: false,
    });
  });

  it("keeps Timings on a consultation whose slots are still tentative", () => {
    // Nothing has been placed — the request is awaiting allocation, so the
    // consultee holds no time yet.
    expect(offered("CONSULTATION", tentative)).toEqual({
      timings: true,
      reschedule: false,
    });
  });

  it("keeps Timings on an approved 1:1 with nothing allocated", () => {
    // "Not scheduled · 0/0". Reschedule refuses it for want of a time to move,
    // so Timings has to hold this case or the row would offer neither.
    expect(offered("CONSULTATION", nothingAllocated)).toEqual({
      timings: true,
      reschedule: false,
    });
  });

  it("replaces Timings with Reschedule on a confirmed consultation", () => {
    expect(offered("CONSULTATION", confirmed)).toEqual({
      timings: false,
      reschedule: true,
    });
  });

  it("replaces Timings with Reschedule on a confirmed subscription session", () => {
    expect(
      offered("SUBSCRIPTION", [
        {
          startsAt: inHours(72),
          isTentative: false,
          completionStatus: "SCHEDULED",
        },
        {
          startsAt: inHours(72),
          isTentative: false,
          completionStatus: "SCHEDULED",
        },
      ]),
    ).toEqual({ timings: false, reschedule: true });
  });

  it("refuses Timings on a confirmed trial", () => {
    // A trial is 1:1 and the consultant allocates the time, but the slot is
    // created non-tentative and the consultee is notified of it — so it is a
    // commitment by the same test as a consultation. The consultant's menu
    // offers a trial neither action today, because the reschedule API has no
    // TRIAL branch; that gap predates this and is out of scope.
    expect(allowsManageTimings("TRIAL", confirmed, 0)).toBe(false);
    expect(offered("TRIAL", confirmed)).toEqual({
      timings: false,
      reschedule: true,
    });
  });

  it("offers exactly one action in every settled case", () => {
    const cases: Array<[AppointmentKind, TestSlot[]]> = [
      ["WEBINAR", confirmed],
      ["CLASS", confirmed],
      ["CLASS", nothingAllocated],
      ["WEBINAR", nothingAllocated],
      ["CONSULTATION", tentative],
      ["CONSULTATION", nothingAllocated],
      ["CONSULTATION", confirmed],
      ["SUBSCRIPTION", confirmed],
      ["TRIAL", confirmed],
    ];
    for (const [kind, slots] of cases) {
      const { timings, reschedule } = offered(kind, slots);
      expect(timings).not.toBe(reschedule);
    }
  });

  it("offers neither only while a proposal is already live", () => {
    // The one deliberate gap: a released slot awaiting a new time IS the open
    // reschedule, so Reschedule would earn a 409 and Timings would write
    // straight over the proposal the consultee is still answering.
    const inFlight: TestSlot[] = [
      {
        startsAt: inHours(72),
        isTentative: false,
        completionStatus: "SCHEDULED",
      },
      {
        startsAt: inHours(72),
        isTentative: true,
        completionStatus: "RESCHEDULED",
      },
    ];
    expect(menu("CONSULTATION", inFlight)).toEqual({
      timings: false,
      reschedule: false,
      retime: false,
    });
  });

  it("refuses Timings when a LATER session is still committed", () => {
    // The reverse of the case above, and the one that actually bit: a partial
    // reschedule releases one session of a multi-session booking, so the
    // earliest slot is the released one while the consultee still holds a
    // confirmed time afterwards. Reading only slots[0] saw "tentative" and
    // handed back the unilateral surface.
    const releasedFirst: TestSlot[] = [
      {
        startsAt: inHours(72),
        isTentative: true,
        completionStatus: "RESCHEDULED",
      },
      {
        startsAt: inHours(72),
        isTentative: false,
        completionStatus: "SCHEDULED",
      },
    ];
    expect(menu("SUBSCRIPTION", releasedFirst).timings).toBe(false);
    expect(menu("CONSULTATION", releasedFirst).timings).toBe(false);
  });

  it("still offers Timings when every upcoming session is unallocated", () => {
    const allTentative: TestSlot[] = [
      { startsAt: inHours(72), isTentative: true, completionStatus: null },
      { startsAt: inHours(72), isTentative: true, completionStatus: null },
    ];
    expect(menu("SUBSCRIPTION", allTentative).timings).toBe(true);
  });
});

describe("allowsRetime", () => {
  it("offers an unsold confirmed webinar Timings AND a move to a new date, never Reschedule", () => {
    expect(menu("WEBINAR", confirmed)).toEqual({
      timings: true,
      reschedule: false,
      retime: true,
    });
  });

  it("offers a sold confirmed webinar only the move", () => {
    expect(menu("WEBINAR", confirmed, 12)).toEqual({
      timings: false,
      reschedule: false,
      retime: true,
    });
  });

  it("never offers a class the whole-event move: its sessions move by cancel + make-up", () => {
    expect(menu("CLASS", confirmed)).toEqual({
      timings: true,
      reschedule: false,
      retime: false,
    });
  });

  it("withholds the move from a webinar that was never scheduled", () => {
    expect(menu("WEBINAR", nothingAllocated)).toEqual({
      timings: true,
      reschedule: false,
      retime: false,
    });
    expect(allowsRetime("WEBINAR", tentative)).toBe(false);
  });

  it("withholds the move once the session is inside 24 hours or over", () => {
    for (const startsAt of [inHours(5), inHours(-2)]) {
      expect(
        allowsRetime("WEBINAR", [
          { startsAt, isTentative: false, completionStatus: "SCHEDULED" },
        ]),
      ).toBe(false);
    }
    expect(
      allowsRetime("WEBINAR", [
        {
          startsAt: inHours(72),
          isTentative: false,
          completionStatus: "COMPLETED",
        },
      ]),
    ).toBe(false);
  });

  it("never offers the move for a 1:1, whatever its slots look like", () => {
    // Releasing a time a counterparty holds is the negotiation Reschedule runs.
    const oneToOne: AppointmentKind[] = [
      "CONSULTATION",
      "SUBSCRIPTION",
      "TRIAL",
    ];
    for (const kind of oneToOne) {
      for (const slots of [confirmed, tentative, nothingAllocated]) {
        expect(allowsRetime(kind, slots)).toBe(false);
      }
    }
  });

  it("gives a confirmed 1:1 Reschedule and neither other action", () => {
    expect(menu("CONSULTATION", confirmed)).toEqual({
      timings: false,
      reschedule: true,
      retime: false,
    });
    expect(menu("SUBSCRIPTION", confirmed)).toEqual({
      timings: false,
      reschedule: true,
      retime: false,
    });
  });
});

describe("upcomingOccurrences", () => {
  const now = new Date("2026-08-01T12:00:00Z");
  const hoursFromNow = (h: number) =>
    new Date(now.getTime() + h * 3_600_000).toISOString();

  it("drops finished sessions and orders the rest", () => {
    const slots = [
      { startsAt: hoursFromNow(48), endsAt: hoursFromNow(49) },
      { startsAt: hoursFromNow(-48), endsAt: hoursFromNow(-47) },
      { startsAt: hoursFromNow(24), endsAt: hoursFromNow(25) },
    ];
    expect(upcomingOccurrences(slots, now).map((s) => s.startsAt)).toEqual([
      hoursFromNow(24),
      hoursFromNow(48),
    ]);
  });

  it("keeps Timings on a program whose remaining sessions are unallocated", () => {
    // A subscription part-way through: past sessions are confirmed, but the
    // consultee holds no future time. Deciding on the raw list would read the
    // finished session as a commitment and hide the action.
    const slots = [
      {
        startsAt: hoursFromNow(-48),
        endsAt: hoursFromNow(-47),
        isTentative: false,
        completionStatus: "COMPLETED",
      },
      {
        startsAt: hoursFromNow(24),
        endsAt: hoursFromNow(25),
        isTentative: true,
        completionStatus: null,
      },
    ];
    expect(
      allowsManageTimings("SUBSCRIPTION", upcomingOccurrences(slots, now), 0),
    ).toBe(true);
  });
});
