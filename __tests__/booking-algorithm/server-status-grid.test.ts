/**
 * @jest-environment node
 */

/**
 * #997 Phases 2-3 — server-computed calendar status grid.
 *
 * Covers the PURE aggregation helpers extracted for the consultant
 * Allocate-Slots calendar's server-side move:
 *
 *  - computeWeeklyConfirmedCallCounts (lib/booking/weekly-call-counts.ts):
 *    Phase 3's per-week confirmed-call aggregate, parity-checked against
 *    ScheduleCalculationService.weekKey — the SAME key the interactive weekly-
 *    limit guard and the server validator (SubscriptionValidationService) use.
 *  - buildOverlapMetaIndex / overlapMetaCandidatesFor / extractOverlapTitleAndParticipant
 *    (availability-with-allocation route): Phase 2's per-interval tooltip
 *    metadata, bucketed the same way isSlotAllocated/getSlotBookingStatus
 *    bucket appointment overlap.
 *
 * Route modules import prisma/auth-server at top level for their GET
 * handlers; both are mocked here purely so importing the pure helpers
 * doesn't require a live DB/session (mirrors authorization.test.ts).
 */

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {},
}));

jest.mock("../../lib/auth-server", () => ({
  getSession: jest.fn(),
}));

import { ScheduleCalculationService } from "@/utils/scheduling-engine/ScheduleCalculationService";
import { computeWeeklyConfirmedCallCounts } from "@/lib/booking/weekly-call-counts";
import {
  buildOverlapMetaIndex,
  overlapMetaCandidatesFor,
  extractOverlapTitleAndParticipant,
  type OverlapAppointmentMeta,
} from "@/lib/booking/overlap-meta";

// ─── computeWeeklyConfirmedCallCounts (Phase 3) ─────────────────────────────

describe("computeWeeklyConfirmedCallCounts", () => {
  const SUB_ID = "sub-1";

  /** #1554 — one 1-hour call is ONE occurrence row on the subscription's wrapper. */
  function call(startsAtIso: string, extra: Record<string, unknown> = {}) {
    return {
      startsAt: new Date(startsAtIso),
      isTentative: false,
      completionStatus: "SCHEDULED",
      deletedAt: null,
      ...extra,
    };
  }
  function wrapper(
    occurrences: ReturnType<typeof call>[],
    opts?: { tz?: string; subId?: string },
  ) {
    return {
      appointmentType: "SUBSCRIPTION",
      subscription: { id: opts?.subId ?? SUB_ID, schedulingTimezone: opts?.tz },
      occurrences,
    };
  }

  it("counts one confirmed call per occurrence, bucketed by week key", () => {
    const appts = [
      wrapper([
        call("2025-01-06T10:00:00.000Z"), // Monday
        call("2025-01-08T10:00:00.000Z"), // Wednesday, same week
        call("2025-01-13T10:00:00.000Z"), // next week
      ]),
    ];
    const counts = computeWeeklyConfirmedCallCounts(appts, SUB_ID);
    const week1 = ScheduleCalculationService.weekKey(
      new Date("2025-01-06T10:00:00.000Z"),
    );
    const week2 = ScheduleCalculationService.weekKey(
      new Date("2025-01-13T10:00:00.000Z"),
    );
    expect(counts[week1]).toBe(2);
    expect(counts[week2]).toBe(1);
  });

  it("parity: buckets by the SAME key as ScheduleCalculationService.weekKey per appointment's own schedulingTimezone", () => {
    const tz = "America/Los_Angeles";
    const startIso = "2025-01-06T10:00:00.000Z";
    const counts = computeWeeklyConfirmedCallCounts(
      [wrapper([call(startIso)], { tz })],
      SUB_ID,
    );
    const expectedKey = ScheduleCalculationService.weekKey(
      new Date(startIso),
      tz,
    );
    expect(counts[expectedKey]).toBe(1);
    expect(Object.keys(counts)).toEqual([expectedKey]);
  });

  it("skips a tentative or dead row WITHOUT hiding its siblings (#1554)", () => {
    // The old shape skipped the whole appointment when any row was tentative;
    // on a one-wrapper subscription that emptied every week's count and let a
    // third call into a capped week. Only the row itself drops out.
    const counts = computeWeeklyConfirmedCallCounts(
      [
        wrapper([
          call("2025-01-06T10:00:00.000Z"),
          call("2025-01-08T10:00:00.000Z", { isTentative: true }),
          call("2025-01-09T10:00:00.000Z", { completionStatus: "RESCHEDULED" }),
          call("2025-01-10T10:00:00.000Z", { deletedAt: new Date() }),
        ]),
      ],
      SUB_ID,
    );
    const weekKey = ScheduleCalculationService.weekKey(
      new Date("2025-01-06T10:00:00.000Z"),
    );
    expect(counts).toEqual({ [weekKey]: 1 });
  });

  it("excludes other subscriptions and other appointment types", () => {
    const otherSub = wrapper([call("2025-01-06T10:00:00.000Z")], {
      subId: "sub-other",
    });
    const consultation = {
      appointmentType: "CONSULTATION",
      subscription: undefined,
      occurrences: [call("2025-01-06T10:00:00.000Z")],
    };
    expect(
      computeWeeklyConfirmedCallCounts([otherSub, consultation], SUB_ID),
    ).toEqual({});
  });

  it("returns {} for an empty appointment list", () => {
    expect(computeWeeklyConfirmedCallCounts([], SUB_ID)).toEqual({});
  });
});

// ─── Overlap metadata index (Phase 2) ───────────────────────────────────────

describe("extractOverlapTitleAndParticipant", () => {
  it("extracts consultation title + requester name", () => {
    const result = extractOverlapTitleAndParticipant({
      id: "a1",
      appointmentType: "CONSULTATION",
      occurrences: [],
      consultation: {
        consultationPlan: { title: "Career Coaching" },
        requestedBy: { user: { name: "Jane Doe" } },
      },
    });
    expect(result).toEqual({ title: "Career Coaching", with: "Jane Doe" });
  });

  it("extracts subscription title + requester name", () => {
    const result = extractOverlapTitleAndParticipant({
      id: "a2",
      appointmentType: "SUBSCRIPTION",
      occurrences: [],
      subscription: {
        subscriptionPlan: { title: "Monthly Mentorship" },
        requestedBy: { user: { name: "John Smith" } },
      },
    });
    expect(result).toEqual({ title: "Monthly Mentorship", with: "John Smith" });
  });

  it("falls back to a generic label when plan title is missing", () => {
    const result = extractOverlapTitleAndParticipant({
      id: "a3",
      appointmentType: "WEBINAR",
      occurrences: [],
      webinar: { webinarPlan: { title: null } },
    });
    expect(result).toEqual({ title: "Webinar" });
  });

  it("never returns a participant name for webinar/class (no requestedBy on those types)", () => {
    const webinar = extractOverlapTitleAndParticipant({
      id: "a4",
      appointmentType: "WEBINAR",
      occurrences: [],
      webinar: { webinarPlan: { title: "Group Session" } },
    });
    expect(webinar.with).toBeUndefined();
  });
});

describe("buildOverlapMetaIndex + overlapMetaCandidatesFor", () => {
  const baseAppt = (id: string, startIso: string, endIso: string) => ({
    id,
    appointmentType: "CONSULTATION" as const,
    occurrences: [
      {
        id: `${id}-slot`,
        startsAt: new Date(startIso),
        endsAt: new Date(endIso),
      },
    ],
    consultation: {
      consultationPlan: { title: "Basic Consultation" },
      requestedBy: { user: { name: "Alice" } },
    },
  });

  it("finds an appointment overlapping an exact 30-min bucket", () => {
    const index = buildOverlapMetaIndex([
      baseAppt(
        "appt-1",
        "2025-01-06T10:00:00.000Z",
        "2025-01-06T10:30:00.000Z",
      ),
    ]);
    const found = overlapMetaCandidatesFor(
      index,
      new Date("2025-01-06T10:00:00.000Z").getTime(),
      new Date("2025-01-06T10:30:00.000Z").getTime(),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      id: "appt-1",
      title: "Basic Consultation",
      with: "Alice",
    });
  });

  it("spans multiple 30-min buckets for a longer appointment slot", () => {
    const index = buildOverlapMetaIndex([
      baseAppt(
        "appt-2",
        "2025-01-06T10:00:00.000Z",
        "2025-01-06T11:00:00.000Z",
      ), // 2 buckets
    ]);
    const secondBucket = overlapMetaCandidatesFor(
      index,
      new Date("2025-01-06T10:30:00.000Z").getTime(),
      new Date("2025-01-06T11:00:00.000Z").getTime(),
    );
    expect(secondBucket.map((m) => m.id)).toEqual(["appt-2"]);
  });

  it("returns no candidates for a non-overlapping window", () => {
    const index = buildOverlapMetaIndex([
      baseAppt(
        "appt-3",
        "2025-01-06T10:00:00.000Z",
        "2025-01-06T10:30:00.000Z",
      ),
    ]);
    const found = overlapMetaCandidatesFor(
      index,
      new Date("2025-01-06T14:00:00.000Z").getTime(),
      new Date("2025-01-06T14:30:00.000Z").getTime(),
    );
    expect(found).toHaveLength(0);
  });

  it("dedupes by appointment id when a slot spans buckets already scanned", () => {
    const index = buildOverlapMetaIndex([
      baseAppt(
        "appt-4",
        "2025-01-06T10:00:00.000Z",
        "2025-01-06T11:00:00.000Z",
      ),
    ]);
    // Query window spans BOTH of appt-4's buckets — must appear once, not twice.
    const found = overlapMetaCandidatesFor(
      index,
      new Date("2025-01-06T10:00:00.000Z").getTime(),
      new Date("2025-01-06T11:00:00.000Z").getTime(),
    );
    expect(found).toHaveLength(1);
  });

  it("keeps two different appointments in the same bucket separate", () => {
    const index = buildOverlapMetaIndex([
      baseAppt(
        "appt-5",
        "2025-01-06T10:00:00.000Z",
        "2025-01-06T10:30:00.000Z",
      ),
      {
        ...baseAppt(
          "appt-6",
          "2025-01-06T10:00:00.000Z",
          "2025-01-06T10:30:00.000Z",
        ),
        consultation: {
          consultationPlan: { title: "Overlap Two" },
          requestedBy: { user: { name: "Bob" } },
        },
      },
    ]);
    const found = overlapMetaCandidatesFor(
      index,
      new Date("2025-01-06T10:00:00.000Z").getTime(),
      new Date("2025-01-06T10:30:00.000Z").getTime(),
    );
    const ids = found.map((m: OverlapAppointmentMeta) => m.id).sort();
    expect(ids).toEqual(["appt-5", "appt-6"]);
  });
});
