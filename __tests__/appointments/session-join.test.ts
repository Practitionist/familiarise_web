/**
 * @jest-environment node
 */

/**
 * #1554 — a booking's held call is ONE `AppointmentOccurrence` row carrying its
 * real `endsAt`. Before the reset it was N half-hour rows that every surface
 * grouped back into a "run" (#1061), and the video room used to be keyed to
 * whichever row the clicking surface happened to pick.
 *
 * These pin the occurrence as the unit both the join window and the room key
 * are measured over: one row, one window, one room.
 */

import {
  buildOccurrence,
  CONSULTANT_JOIN_WINDOW_MS,
  DEFAULT_MEETING_DURATION_MS,
  CONSULTEE_JOIN_WINDOW_MS,
  getCurrentOrNextOccurrence,
  getJoinableOccurrence,
  getOccurrenceJoinState,
  intervalStartsOf,
  liveOccurrencesOf,
  type JoinableOccurrence,
} from "@/lib/appointments/occurrences";

/** All fixtures live on one day so the clock reads like the issue's timeline. */
const at = (hhmm: string) => new Date(`2026-08-01T${hhmm}:00.000Z`);

function row(
  id: string,
  start: string,
  end: string,
  extra: Partial<JoinableOccurrence> = {},
): JoinableOccurrence {
  return {
    id,
    appointmentId: "appt-1",
    startsAt: at(start),
    endsAt: at(end),
    isTentative: false,
    completionStatus: "SCHEDULED",
    ...extra,
  };
}

/** A 10:00–11:00 consultation as the booking engine now stores it. */
const oneHour = () => [row("A", "10:00", "11:00")];

describe("a 60-minute consultation is one occurrence row", () => {
  it("builds one row with the real end, not two half-hour atoms", () => {
    const occurrence = buildOccurrence({
      startsAt: at("10:00"),
      durationInHours: 1,
      consultantProfileId: "cp-1",
    });

    expect(occurrence.ordinal).toBe(1);
    expect(occurrence.startsAt).toEqual(at("10:00"));
    expect(occurrence.endsAt).toEqual(at("11:00"));
    // The engine still counts in 30-minute intervals; the row covers two.
    expect(intervalStartsOf(occurrence)).toEqual([at("10:00"), at("10:30")]);
  });

  it("rounds a partial interval up, matching getSlotsPerCall", () => {
    const occurrence = buildOccurrence({
      startsAt: at("10:00"),
      durationInHours: 0.75,
      consultantProfileId: "cp-1",
    });

    expect(occurrence.endsAt).toEqual(at("11:00"));
  });

  it("renders as one entry — nothing is left to group", () => {
    expect(liveOccurrencesOf(oneHour())).toHaveLength(1);
  });

  it("drops cancelled and rescheduled rows from the live set", () => {
    const rows = [
      row("A", "10:00", "11:00", { completionStatus: "CANCELLED" }),
      row("B", "14:00", "15:00"),
      row("C", "16:00", "17:00", { completionStatus: "RESCHEDULED" }),
    ];

    expect(liveOccurrencesOf(rows).map((r) => r.id)).toEqual(["B"]);
  });
});

describe("two parties in one booking resolve the same room", () => {
  /**
   * The consultant clicks Join five minutes in and the consultee twenty-five
   * minutes in. Both must come back with row A, because
   * `getOrCreateAppointmentMeeting` mints `occurrence-${id}` from whatever it
   * is handed.
   */
  it("gives the consultant, the consultee and a late joiner row A", () => {
    const slots = oneHour();

    const consultant = getJoinableOccurrence(slots, {
      joinWindowMs: CONSULTANT_JOIN_WINDOW_MS,
      now: at("10:05"),
    });
    const consultee = getJoinableOccurrence(slots, {
      joinWindowMs: CONSULTEE_JOIN_WINDOW_MS,
      now: at("10:25"),
    });
    const lateJoiner = getJoinableOccurrence(slots, {
      joinWindowMs: CONSULTEE_JOIN_WINDOW_MS,
      now: at("10:35"),
    });

    expect(consultant?.id).toBe("A");
    expect(consultee?.id).toBe("A");
    expect(lateJoiner?.id).toBe("A");
  });

  it("holds across a two-hour session", () => {
    const slots = [row("A", "10:00", "12:00")];
    const times = ["09:50", "10:29", "10:31", "11:15", "11:59"];

    for (const now of times) {
      expect(
        getJoinableOccurrence(slots, {
          joinWindowMs: CONSULTEE_JOIN_WINDOW_MS,
          now: at(now),
        })?.id,
      ).toBe("A");
    }
  });
});

describe("the join window spans the whole occurrence", () => {
  const joinable = (now: string) =>
    getJoinableOccurrence(oneHour(), {
      joinWindowMs: CONSULTEE_JOIN_WINDOW_MS,
      now: at(now),
    }) !== null;

  it("opens 10 minutes before the call starts", () => {
    expect(joinable("09:45")).toBe(false);
    expect(joinable("09:52")).toBe(true);
  });

  it("stays open through the second half hour", () => {
    expect(joinable("10:05")).toBe(true);
    expect(joinable("10:29")).toBe(true);
    expect(joinable("10:45")).toBe(true);
    expect(joinable("10:59")).toBe(true);
  });

  it("closes at the end of the occurrence", () => {
    expect(joinable("11:01")).toBe(false);
  });

  it("still closes at 10:30 for a genuine 30-minute booking", () => {
    const slots = [row("A", "10:00", "10:30")];
    const at1029 = getJoinableOccurrence(slots, {
      joinWindowMs: CONSULTEE_JOIN_WINDOW_MS,
      now: at("10:29"),
    });
    const at1031 = getJoinableOccurrence(slots, {
      joinWindowMs: CONSULTEE_JOIN_WINDOW_MS,
      now: at("10:31"),
    });

    expect(at1029?.id).toBe("A");
    expect(at1031).toBeNull();
  });

  it("falls back to the default duration when a row has no endsAt", () => {
    // `MeetingSlot` declares `endsAt` nullable and the join surfaces do hand
    // that shape over, so the bounds depend on this fallback.
    expect(DEFAULT_MEETING_DURATION_MS).toBe(60 * 60 * 1000);
    const slot = row("A", "10:00", "10:30", { endsAt: null });

    expect(
      getOccurrenceJoinState(slot, {
        joinWindowMs: CONSULTEE_JOIN_WINDOW_MS,
        now: at("10:45"),
      }),
    ).toBe("joinable");
    expect(
      getOccurrenceJoinState(slot, {
        joinWindowMs: CONSULTEE_JOIN_WINDOW_MS,
        // DEFAULT_MEETING_DURATION_MS is one hour, so the fallback end is 11:00.
        now: at("11:01"),
      }),
    ).toBe("ended");
  });
});

describe("ending the call ends the occurrence", () => {
  // #1270 — a DELIBERATE end (`call_ended`). The `session_timeout` counterpart
  // is asserted below, because the distinction between them is the whole point
  // of `isDeliberateEnd`.
  const ended = {
    id: "ms-1",
    endedAt: at("10:10"),
    endedReason: "call_ended",
  };

  it("does not re-light Join later in the booked hour", () => {
    const slots = oneHour();
    slots[0].meetingSession = ended;

    for (const now of ["10:25", "10:45", "10:59"]) {
      expect(
        getJoinableOccurrence(slots, {
          joinWindowMs: CONSULTEE_JOIN_WINDOW_MS,
          now: at(now),
        }),
      ).toBeNull();
    }
  });

  it("does NOT end the occurrence when Stream merely timed out the room", () => {
    // #1270 — the bug this predicate exists for. Stream fires
    // `call.session_ended` `inactivity_timeout_seconds` after the LAST
    // participant leaves, so one party stepping out for coffee at 09:56 of a
    // 10:00-11:00 booking produced this row. Treating it like a host closing
    // the room locked BOTH sides out of a session they had paid for.
    const slot = row("A", "10:00", "11:00", {
      meetingSession: {
        id: "ms-1",
        endedAt: at("10:10"),
        endedReason: "session_timeout",
      },
    });

    expect(getOccurrenceJoinState(slot, { now: at("10:25") })).toBe("joinable");
  });

  it("treats a reconciler's guess as non-terminal too", () => {
    // `reconciled_no_end` and `stream_not_found` are the orphan sweeper saying
    // "I could not tell", which is not the same as "the host closed it".
    for (const reason of ["reconciled_no_end", "stream_not_found"]) {
      const slot = row("A", "10:00", "11:00", {
        meetingSession: {
          id: "ms-1",
          endedAt: at("10:10"),
          endedReason: reason,
        },
      });

      expect(getOccurrenceJoinState(slot, { now: at("10:25") })).toBe(
        "joinable",
      );
    }
  });

  it("treats a row with no reason as terminal, for historical safety", () => {
    // Rows written before the column existed carry no reason. Reading those as
    // deliberate is the conservative direction; the REQUIRED field on the
    // occurrence shape is what stops a forgetful projection reaching this.
    const slot = row("A", "10:00", "11:00", {
      meetingSession: { id: "ms-1", endedAt: at("10:10"), endedReason: null },
    });

    expect(getOccurrenceJoinState(slot, { now: at("10:25") })).toBe("ended");
  });
});

describe("state of an occurrence that is not joinable", () => {
  it("counts down before the window opens", () => {
    expect(getOccurrenceJoinState(oneHour()[0], { now: at("09:00") })).toBe(
      "countdown",
    );
  });

  it("is disabled while the row is only a tentative placeholder", () => {
    const slots = [row("A", "10:00", "11:00", { isTentative: true })];

    expect(getOccurrenceJoinState(slots[0], { now: at("10:05") })).toBe(
      "disabled",
    );
    expect(getJoinableOccurrence(slots, { now: at("10:05") })).toBeNull();
  });

  it("has ended once the row is over", () => {
    expect(getOccurrenceJoinState(oneHour()[0], { now: at("11:30") })).toBe(
      "ended",
    );
  });
});

describe("current-or-next occurrence", () => {
  const two = () => [
    ...oneHour(),
    row("C", "14:00", "14:30", { appointmentId: "appt-2" }),
  ];

  it("returns the live call rather than the one after it", () => {
    expect(getCurrentOrNextOccurrence(two(), at("10:25"))?.id).toBe("A");
  });

  it("falls forward once the live call is over", () => {
    expect(getCurrentOrNextOccurrence(two(), at("11:05"))?.id).toBe("C");
  });

  it("falls back to the most recent past call", () => {
    expect(getCurrentOrNextOccurrence(oneHour(), at("18:00"))?.id).toBe("A");
  });

  it("returns null when there is nothing live to show", () => {
    expect(getCurrentOrNextOccurrence([], at("10:00"))).toBeNull();
  });
});
