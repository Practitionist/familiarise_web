/**
 * @jest-environment node
 */

jest.mock("server-only", () => ({}));
jest.mock("../../lib/stream/recording-retention", () => ({
  recordingRetentionLabels: jest.fn(async () => new Map()),
}));
jest.mock("../../lib/stream/late-join-recordings", () => ({
  lateJoinRecordingAccess: jest.fn(async () => ({ floors: new Map() })),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointment: { findFirst: jest.fn(), findMany: jest.fn() },
    appointmentOccurrence: { findMany: jest.fn() },
    appointmentParticipant: { count: jest.fn() },
    payment: { findMany: jest.fn(async () => []) },
    recording: { count: jest.fn() },
    recordingPurchase: { count: jest.fn(async () => 0) },
  },
}));

import prisma from "@/lib/prisma";
import { lateJoinRecordingAccess } from "@/lib/stream/late-join-recordings";
import { recordingRetentionLabels } from "@/lib/stream/recording-retention";
import {
  readRecordingSlots,
  resolveRecordingViewer,
} from "@/lib/stream/recording-slots";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-12T12:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

function classBooking(id: string, share = true) {
  const plan = {
    id: "plan-1",
    title: "Beginner Class",
    consultantProfile: { userId: "host" },
    collaborators: [],
  };
  return {
    id,
    appointmentType: "CLASS",
    consultation: null,
    subscription: null,
    trial: null,
    webinar: share
      ? null
      : {
          id: "w",
          webinarPlan: { ...plan, shareRecordingsWithAllAttendees: false },
        },
    class: share
      ? {
          id: `class-${id}`,
          schedulingPeriodStartsAt: ago(30),
          classPlan: {
            ...plan,
            lateJoinersGetPastRecordings: false,
            classContents: [{ order: 2, title: "Conditions" }],
          },
        }
      : null,
  };
}

function session(
  ordinal: number,
  endedDaysAgo: number,
  recordings: {
    id: string;
    minute?: number;
    status?: string;
    reason?: string;
  }[] = [],
  extra: Record<string, unknown> = {},
) {
  const endsAt = ago(endedDaysAgo);
  const startsAt = new Date(endsAt.getTime() - 3600_000);
  return {
    id: `occ-${ordinal}-${endedDaysAgo}`,
    ordinal,
    startsAt,
    endsAt,
    completionStatus: endedDaysAgo > 0 ? "COMPLETED" : "SCHEDULED",
    voidedAt: null,
    meeting: {
      endedAt: null,
      recordingConsents: [],
      recordings: recordings.map((r) => ({
        id: r.id,
        title: r.id,
        status: r.status ?? "AVAILABLE",
        durationInMinutes: 30,
        recordedAt: new Date(startsAt.getTime() + (r.minute ?? 0) * 60_000),
        removedAt: r.reason ? ago(1) : null,
        removalReason: r.reason ?? null,
        listingStatus: "DRAFT",
        purchases: [],
      })),
    },
    ...extra,
  };
}

async function learnerView(ownSessions: unknown[], catchUp: unknown[] = []) {
  const viewer = await resolveRecordingViewer("b2", "learner");
  (prisma.appointmentOccurrence.findMany as jest.Mock)
    .mockResolvedValueOnce(ownSessions)
    .mockResolvedValueOnce(catchUp);
  return readRecordingSlots(viewer!, "learner", NOW);
}

beforeEach(() => {
  jest.clearAllMocks();
  (prisma.appointmentOccurrence.findMany as jest.Mock).mockReset();
  (lateJoinRecordingAccess as jest.Mock).mockResolvedValue({
    floors: new Map(),
  });
  (prisma.appointment.findFirst as jest.Mock).mockResolvedValue(
    classBooking("b2"),
  );
  (prisma.appointmentParticipant.count as jest.Mock).mockResolvedValue(1);
});

describe("one slot rule for a learner's own batch", () => {
  it("shows own recordings as ordered parts and offers no catch-up", async () => {
    const view = await learnerView([
      session(1, 5, [
        { id: "late", minute: 30 },
        { id: "early", minute: 0 },
      ]),
    ]);
    expect(view.slots[0]).toMatchObject({
      state: "recorded",
      source: { kind: "own" },
    });
    expect(view.slots[0]!.parts.map((p) => [p.recordingId, p.partNo])).toEqual([
      ["early", 1],
      ["late", 2],
    ]);
    expect(prisma.appointmentOccurrence.findMany).toHaveBeenCalledTimes(1);
  });

  it("fills a session that ended with nothing playable from the most recent other batch", async () => {
    const other = {
      ...session(2, 20, [{ id: "b1-rec" }]),
      appointmentId: "b1",
      appointment: {
        class: { schedulingPeriodStartsAt: ago(60) },
        occurrences: [],
      },
    };
    const view = await learnerView(
      [session(1, 5, [{ id: "own-1" }]), session(2, 3), session(3, -2)],
      [other],
    );
    const [one, two, three] = view.slots;
    expect(one!.state).toBe("recorded");
    expect(two).toMatchObject({
      title: "Conditions",
      state: "catch_up",
      missingReason: "not_recorded",
      source: { kind: "catch_up" },
    });
    expect(two!.parts.map((p) => p.recordingId)).toEqual(["b1-rec"]);
    expect(three!.state).toBe("upcoming");
    const where = (prisma.appointmentOccurrence.findMany as jest.Mock).mock
      .calls[1][0].where;
    expect(where.ordinal).toEqual({ in: [2] });
    expect(where.appointment).toMatchObject({ id: { not: "b2" } });
  });

  it("never offers catch-up for sessions before a late joiner's seat", async () => {
    (lateJoinRecordingAccess as jest.Mock).mockResolvedValue({
      floors: new Map([["class-b2", ago(4)]]),
    });
    const view = await learnerView([session(1, 5), session(2, 1)]);
    expect(view.slots.map((s) => s.state)).toEqual([
      "before_you_joined",
      "not_recorded",
    ]);
    const where = (prisma.appointmentOccurrence.findMany as jest.Mock).mock
      .calls[1][0].where;
    expect(where.ordinal).toEqual({ in: [2] });
  });

  it("gives a webinar run without shared recordings no catch-up", async () => {
    (prisma.appointment.findFirst as jest.Mock).mockResolvedValue(
      classBooking("b2", false),
    );
    const viewer = await resolveRecordingViewer("b2", "learner");
    (prisma.appointmentOccurrence.findMany as jest.Mock).mockResolvedValueOnce([
      session(1, 5),
    ]);
    const view = await readRecordingSlots(viewer!, "learner", NOW);
    expect(view.slots[0]!.state).toBe("not_recorded");
    expect(prisma.appointmentOccurrence.findMany).toHaveBeenCalledTimes(1);
  });

  it("groups a voided session and its make-up under one slot and marks the make-up", async () => {
    const view = await learnerView([
      session(1, 6, [{ id: "voided-part" }], { voidedAt: ago(6) }),
      session(1, 2, [{ id: "makeup-part" }]),
    ]);
    expect(view.slots).toHaveLength(1);
    expect(view.slots[0]!.parts.map((p) => [p.recordingId, p.makeUp])).toEqual([
      ["voided-part", false],
      ["makeup-part", true],
    ]);
  });

  it("tells attendees when the expert removed a session's recording", async () => {
    (prisma.appointment.findFirst as jest.Mock).mockResolvedValue({
      ...classBooking("b2"),
      class: null,
      consultation: {
        requestedBy: { userId: "learner" },
        consultationPlan: {
          title: "1:1",
          consultantProfile: { userId: "host" },
        },
      },
    });
    const viewer = await resolveRecordingViewer("b2", "learner");
    (prisma.appointmentOccurrence.findMany as jest.Mock).mockResolvedValueOnce([
      session(1, 3, [
        { id: "gone", status: "EXPIRED", reason: "EXPERT_DELETED" },
      ]),
    ]);
    const view = await readRecordingSlots(viewer!, "learner", NOW);
    expect(view.slots[0]).toMatchObject({ state: "removed", parts: [] });
  });
});

describe("expert-removed recordings", () => {
  async function removedSlot(label: unknown) {
    (recordingRetentionLabels as jest.Mock).mockResolvedValueOnce(
      new Map([["gone", label]]),
    );
    const view = await learnerView([
      session(1, 60, [
        { id: "gone", status: "EXPIRED", reason: "EXPERT_DELETED" },
      ]),
    ]);
    return view.slots[0]!;
  }

  it("reads Removed until the retention date, then expired, never Not recorded", async () => {
    expect(
      await removedSlot({ kind: "DATE", until: new Date(NOW.getTime() + DAY) }),
    ).toMatchObject({ state: "removed", missingReason: "removed" });
    expect(await removedSlot({ kind: "WHILE_ACTIVE" })).toMatchObject({
      state: "removed",
    });
    expect(await removedSlot({ kind: "DATE", until: ago(1) })).toMatchObject({
      missingReason: "expired",
    });
  });
});
