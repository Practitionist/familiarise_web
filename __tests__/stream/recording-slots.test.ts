/**
 * @jest-environment node
 */

jest.mock("server-only", () => ({}));
jest.mock("../../lib/stream/recording-retention", () => ({
  recordingRetentionLabels: jest.fn(async () => new Map()),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointment: { findMany: jest.fn() },
    consultantProfile: { findUnique: jest.fn(async () => null) },
    consulteeProfile: { findUnique: jest.fn(async () => ({ id: "cp-l" })) },
    appointmentOccurrence: { findMany: jest.fn(async () => []) },
  },
}));

import type { RecordingStatus } from "@prisma/client";

import prisma from "@/lib/prisma";
import { renderedGroups } from "@/lib/data/recording-library";
import type { RecordingRetentionLabel } from "@/lib/stream/recording-retention";
import { recordingRetentionLabels } from "@/lib/stream/recording-retention";
import {
  buildRecordingView,
  catchUpOrdinals,
  loadRecordingViews,
  pickCatchUpSources,
  recordingViewerOf,
  type BookingRow,
  type CatchUpRow,
  type RecordingBookingView,
  type SessionRow,
} from "@/lib/stream/recording-slots";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-12T12:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const LEARNER = {
  consultantProfileId: null,
  consulteeProfileId: "cp-l",
};

function classBooking(id: string, planId = "plan-1"): BookingRow {
  return {
    id,
    appointmentType: "CLASS",
    consultation: null,
    subscription: null,
    trial: null,
    webinar: null,
    class: {
      id: `class-${id}`,
      schedulingPeriodStartsAt: ago(30),
      classPlan: {
        id: planId,
        title: "Beginner Class",
        lateJoinersGetPastRecordings: false,
        consultantProfileId: "host",
        collaborators: [],
        classContents: [{ order: 2, title: "Conditions" }],
      },
    },
  };
}

function session(
  ordinal: number,
  endedDaysAgo: number,
  recordings: { id: string; minute?: number; status?: RecordingStatus }[] = [],
  voided = false,
): SessionRow {
  const endsAt = ago(endedDaysAgo);
  const startsAt = new Date(endsAt.getTime() - 3600_000);
  return {
    id: `occ-${ordinal}-${endedDaysAgo}`,
    ordinal,
    startsAt,
    endsAt,
    completionStatus: endedDaysAgo > 0 ? "COMPLETED" : "SCHEDULED",
    voidedAt: voided ? endsAt : null,
    meeting: {
      endedAt: null,
      recordingConsents: [],
      recordings: recordings.map((r) => ({
        id: r.id,
        title: r.id,
        status: r.status ?? "AVAILABLE",
        durationInMinutes: 30,
        recordedAt: new Date(startsAt.getTime() + (r.minute ?? 0) * 60_000),
        removedAt: r.status === "EXPIRED" ? ago(1) : null,
        removalReason: r.status === "EXPIRED" ? "EXPERT_DELETED" : null,
        listingStatus: "DRAFT",
        purchases: [],
      })),
    },
  };
}

function otherRun(
  appointmentId: string,
  base: SessionRow,
  planId = "plan-1",
): CatchUpRow {
  return {
    ...base,
    appointmentId,
    appointment: {
      webinar: null,
      class: { classPlanId: planId, schedulingPeriodStartsAt: ago(60) },
      occurrences: [],
    },
  };
}

function view(
  sessions: SessionRow[],
  opts: {
    floor?: Date | null;
    rows?: CatchUpRow[];
    labels?: Map<string, RecordingRetentionLabel>;
  } = {},
): RecordingBookingView {
  const viewer = recordingViewerOf(classBooking("b2"), LEARNER, true)!;
  const floor = opts.floor ?? null;
  const ordinals = catchUpOrdinals(viewer, sessions, floor, NOW);
  const sources = viewer.groupPlan
    ? pickCatchUpSources(viewer.groupPlan, "b2", ordinals, opts.rows ?? [])
    : new Map();
  const labels = opts.labels ?? new Map();
  return buildRecordingView(viewer, { sessions, floor, sources, labels }, NOW);
}

describe("the slot rule", () => {
  it("matches hosts by consultant profile and group learners by an entitled seat", () => {
    const host = { ...LEARNER, consultantProfileId: "host" };
    expect(recordingViewerOf(classBooking("b2"), host, false)?.role).toBe(
      "host",
    );
    expect(recordingViewerOf(classBooking("b2"), LEARNER, false)).toBeNull();
  });

  it("shows the own batch's recordings as ordered parts", () => {
    const { slots } = view([
      session(1, 5, [
        { id: "late", minute: 30 },
        { id: "early", minute: 0 },
      ]),
    ]);
    expect(slots[0]).toMatchObject({
      state: "recorded",
      source: { kind: "own" },
    });
    expect(slots[0]!.parts.map((p) => [p.recordingId, p.partNo])).toEqual([
      ["early", 1],
      ["late", 2],
    ]);
  });

  it("groups a voided session and its make-up as parts of one slot", () => {
    const { slots } = view([
      session(1, 6, [{ id: "voided-part" }], true),
      session(1, 2, [{ id: "makeup-part" }]),
    ]);
    expect(slots).toHaveLength(1);
    expect(slots[0]!.parts.map((p) => [p.recordingId, p.makeUp])).toEqual([
      ["voided-part", false],
      ["makeup-part", true],
    ]);
  });

  it("catches up from the most recent other batch of the same plan only", () => {
    const rows = [
      otherRun("b9", session(2, 1, [{ id: "other-plan" }]), "plan-2"),
      otherRun("b2", session(2, 2, [{ id: "own-run" }])),
      otherRun("b1", session(2, 20, [{ id: "b1-rec" }])),
      otherRun("b0", session(2, 40, [{ id: "older" }])),
    ];
    const { slots } = view(
      [session(1, 5, [{ id: "own-1" }]), session(2, 3), session(3, -2)],
      { rows },
    );
    expect(slots.map((s) => s.state)).toEqual([
      "recorded",
      "catch_up",
      "upcoming",
    ]);
    expect(slots[1]).toMatchObject({
      title: "Conditions",
      missingReason: "not_recorded",
      source: { kind: "catch_up" },
    });
    expect(slots[1]!.parts.map((p) => p.recordingId)).toEqual(["b1-rec"]);
  });

  it("hides sessions before a late joiner's seat and offers them no catch-up", () => {
    const viewer = recordingViewerOf(classBooking("b2"), LEARNER, true)!;
    const sessions = [session(1, 5), session(2, 1)];
    expect(catchUpOrdinals(viewer, sessions, ago(4), NOW)).toEqual([2]);
    expect(view(sessions, { floor: ago(4) }).slots.map((s) => s.state)).toEqual(
      ["before_you_joined", "not_recorded"],
    );
  });

  it("keeps a removed part beside the remaining ones, numbered with them", () => {
    const { slots } = view(
      [
        session(1, 5, [
          { id: "kept", minute: 0 },
          { id: "gone", minute: 30, status: "EXPIRED" },
        ]),
      ],
      { labels: new Map([["gone", { kind: "WHILE_ACTIVE" }]]) },
    );
    expect(slots[0]!.parts.map((p) => [p.partNo, p.partCount])).toEqual([
      [1, 2],
    ]);
    expect(slots[0]!.removedParts).toMatchObject([
      { partNo: 2, partCount: 2, removedBy: "expert" },
    ]);
  });

  it("reads an expert-removed recording as Removed until its retention date, then expired", () => {
    const gone = [session(1, 60, [{ id: "gone", status: "EXPIRED" }])];
    const at = (label: RecordingRetentionLabel) =>
      view(gone, { labels: new Map([["gone", label]]) }).slots[0]!;
    expect(
      at({ kind: "DATE", until: new Date(NOW.getTime() + DAY) }),
    ).toMatchObject({ state: "removed", missingReason: "removed" });
    expect(at({ kind: "WHILE_ACTIVE" }).state).toBe("removed");
    expect(at({ kind: "DATE", until: ago(1) }).missingReason).toBe("expired");
  });
});

describe("the batched loader and library pages", () => {
  it("reads a page of bookings in a fixed number of queries", async () => {
    const bookings = ["b1", "b2", "b3"].map((id) => ({
      ...classBooking(id),
      participants: [
        {
          status: "CONFIRMED",
          createdAt: ago(id === "b1" ? 4 : 30),
          payment: null,
        },
      ],
      payment: [],
      occurrences: [session(1, 5), session(2, 3, [{ id: `${id}-rec` }])],
    }));
    (prisma.appointment.findMany as jest.Mock)
      .mockResolvedValueOnce([{ appointmentType: "CLASS" }])
      .mockResolvedValueOnce(bookings);
    const loaded = await loadRecordingViews(["b1", "b2", "b3"], "learner", NOW);
    expect(loaded.size).toBe(3);
    expect(prisma.appointment.findMany).toHaveBeenCalledTimes(2);
    const { select } = (prisma.appointment.findMany as jest.Mock).mock
      .calls[1][0];
    expect(select).not.toHaveProperty("consultation");
    // b1's seat came after its session 1, which it then does not see.
    expect(loaded.get("b1")!.view.slots[0]!.state).toBe("before_you_joined");
    expect(loaded.get("b2")!.view.slots[0]!.state).toBe("not_recorded");
    expect(prisma.appointmentOccurrence.findMany).toHaveBeenCalledTimes(1);
    expect(recordingRetentionLabels).toHaveBeenCalledTimes(1);
  });

  it("counts and pages only the bookings that render a row", () => {
    const empty = view([session(1, -1)]);
    const recorded = view([session(1, 5, [{ id: "rec" }])]);
    const views = new Map([
      ["a", recorded],
      ["b", empty],
      ["c", recorded],
    ]);
    expect(
      renderedGroups(["a", "b", "c", "x"], views, "").map(
        (g) => g.appointmentId,
      ),
    ).toEqual(["a", "c"]);
    expect(renderedGroups(["a", "c"], views, "nothing")).toEqual([]);
  });
});
