/**
 * One rule set for host-set event times: the UTC half-hour lattice, a lead per
 * purpose, and an end computed in minutes (a 90-minute webinar ends 90 minutes
 * later; the old wall-clock `setHours` truncated it to 60).
 */

import {
  EVENT_SCHEDULE_LEAD_MS,
  eventEndOf,
  eventTimeRefusal,
} from "@/lib/booking/event-time-rules";

const NOW = new Date("2026-11-16T04:00:00.000Z");
const HOUR = 3_600_000;

describe("eventTimeRefusal", () => {
  it("accepts a half-hour start an hour or more ahead for a new webinar", () => {
    expect(
      eventTimeRefusal(new Date(NOW.getTime() + 2 * HOUR), "create", NOW),
    ).toBeNull();
    expect(
      eventTimeRefusal(
        new Date(NOW.getTime() + EVENT_SCHEDULE_LEAD_MS),
        "makeup",
        NOW,
      ),
    ).toBeNull();
  });

  it("refuses a start off the half-hour lattice, including a :45 local time", () => {
    // 10:15 IST is 04:45 UTC: on the clock face a quarter past, off the grid.
    const refusal = eventTimeRefusal(
      new Date("2026-11-17T04:45:00.000Z"),
      "create",
      NOW,
    );
    expect(refusal).toEqual({
      code: "EVENT_TIME_INVALID",
      message: "Pick a start time on the hour or half hour.",
    });
  });

  it("refuses a start inside the purpose's lead", () => {
    expect(
      eventTimeRefusal(new Date(NOW.getTime() + 30 * 60_000), "makeup", NOW)
        ?.message,
    ).toBe("Pick a start time at least 1 hour from now.");
    expect(
      eventTimeRefusal(new Date(NOW.getTime() + 12 * HOUR), "retime", NOW)
        ?.message,
    ).toBe("Pick a start time at least 24 hours from now.");
  });

  it("refuses an unreadable date", () => {
    expect(eventTimeRefusal(new Date("nope"), "create", NOW)?.code).toBe(
      "EVENT_TIME_INVALID",
    );
  });
});

describe("eventEndOf", () => {
  it("adds whole minutes, so a 90-minute session ends 90 minutes later", () => {
    const start = new Date("2026-11-20T12:30:00.000Z");
    expect(eventEndOf(start, 90).toISOString()).toBe(
      "2026-11-20T14:00:00.000Z",
    );
    expect(eventEndOf(start, 0.5 * 60).toISOString()).toBe(
      "2026-11-20T13:00:00.000Z",
    );
  });
});
