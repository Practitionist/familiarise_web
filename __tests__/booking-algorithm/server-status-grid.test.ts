/**
 * @jest-environment node
 */

/**
 * #997 Phases 2-3 — server-computed calendar status grid.
 *
 * Covers the PURE aggregation helpers extracted for the consultant
 * Allocate-Slots calendar's server-side move:
 *
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

import {
  buildOverlapMetaIndex,
  overlapMetaCandidatesFor,
  extractOverlapTitleAndParticipant,
  type OverlapAppointmentMeta,
} from "@/lib/booking/overlap-meta";

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

  it('labels a trial "Trial session" with the learner\'s name', () => {
    const result = extractOverlapTitleAndParticipant({
      id: "appt-trial",
      appointmentType: "TRIAL",
      occurrences: [],
      trial: { consulteeProfile: { user: { name: "Charlotte Reid" } } },
    });
    expect(result).toEqual({ title: "Trial session", with: "Charlotte Reid" });
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
