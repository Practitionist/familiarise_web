import type { LibraryRecording } from "@/lib/library/library-query";
import {
  retentionText,
  rowBadge,
  timelineSubline,
} from "@/lib/stream/recording-copy";
import type {
  RecordingBookingView,
  RecordingSlot,
  SlotState,
} from "@/lib/stream/recording-slots";
import {
  rowRetention,
  timelineOf,
  timelineRows,
  truncateUpcoming,
} from "@/lib/stream/recording-timeline";

const day = (iso: string) => iso.slice(0, 10);
const NOW = new Date("2026-10-13T00:00:00Z");

function slot(
  ordinal: number,
  state: SlotState,
  extra: Partial<RecordingSlot> = {},
): RecordingSlot {
  const recorded = state === "recorded" || state === "catch_up";
  return {
    ordinal,
    title: `Session ${ordinal}`,
    startsAt: `2026-10-0${ordinal}T10:00:00.000Z`,
    state,
    missingReason: null,
    removedAt: null,
    removedBy: null,
    removers: [],
    source: null,
    declinedBy: null,
    parts: recorded
      ? [
          {
            recordingId: `r${ordinal}`,
            title: `Session ${ordinal}`,
            partNo: 1,
            partCount: 1,
            recordedAt: `2026-10-0${ordinal}T10:05:00.000Z`,
            durationInMinutes: 30,
            makeUp: false,
            keptUntil: { kind: "DATE", until: "2027-10-09T00:00:00.000Z" },
            listing: null,
          },
        ]
      : [],
    removedParts: [],
    ...extra,
  };
}

function view(kind: string, slots: RecordingSlot[]): RecordingBookingView {
  return {
    appointmentId: "a1",
    kind,
    title: "Plan",
    batchLabel: null,
    viewerRole: "learner",
    audience: kind === "CLASS" ? "batch" : "one_to_one",
    sharedAcrossRuns: null,
    expertName: "Ananya Anderson",
    learnerName: null,
    organizationName: "LearnPro",
    slots,
  };
}

const badge = (row: LibraryRecording) => rowBadge(row, day);

describe("recordings timeline", () => {
  it("gives every state its row badge", () => {
    const rows = timelineRows(
      view("CLASS", [
        slot(1, "recorded"),
        slot(2, "catch_up", {
          source: {
            kind: "catch_up",
            batchLabel: "x",
            recordedAt: "2026-09-14T10:00:00.000Z",
          },
        }),
        slot(3, "removed", {
          removedAt: "2026-10-11T00:00:00.000Z",
          removedBy: "support",
          removers: ["support"],
        }),
        slot(8, "removed", {
          removedAt: "2026-10-11T00:00:00.000Z",
          removedBy: "org",
          removers: ["org"],
        }),
        slot(10, "removed", {
          removedAt: "2026-10-11T00:00:00.000Z",
          removedBy: "org",
          removers: ["org", "expert"],
        }),
        slot(9, "cancelled"),
        slot(4, "processing"),
        slot(5, "expired"),
        slot(6, "before_you_joined"),
        slot(7, "upcoming"),
      ]),
    );
    expect(rows.map(badge)).toEqual([
      null,
      "Catch-up · recorded 2026-09-14 with another batch",
      "Removed by Familiarise support on 2026-10-11",
      "Being prepared",
      "Expired",
      "Before you joined",
      "Upcoming",
      "Removed by LearnPro on 2026-10-11",
      "Cancelled",
      "Removed by LearnPro and Ananya Anderson",
    ]);
    const [decline] = timelineRows(
      view("CONSULTATION", [
        slot(1, "declined", { declinedBy: "Ethan Brown" }),
      ]),
    );
    expect(badge(decline!)).toBe(
      "Not recorded · Ethan Brown declined recording",
    );
  });

  it("lists every past session, the next upcoming one, and counts the rest", () => {
    const rows = timelineRows(
      view("SUBSCRIPTION", [
        slot(3, "upcoming"),
        slot(1, "recorded"),
        slot(2, "not_recorded"),
        slot(4, "upcoming"),
        slot(5, "upcoming"),
      ]),
    );
    const cut = truncateUpcoming(rows);
    expect(cut.rows.map((r) => r.slotOrdinal)).toEqual([1, 2, 3]);
    expect(cut.moreUpcoming).toBe(2);
  });

  it("states retention once per booking type", () => {
    const header = (kind: string, slots: RecordingSlot[]) => {
      const v = view(kind, slots);
      return timelineOf(v, timelineRows(v)).retention;
    };
    expect(header("CONSULTATION", [slot(1, "recorded")])).toEqual({
      kind: "DATE",
      until: "2027-10-09T00:00:00.000Z",
    });
    expect(
      header("SUBSCRIPTION", [slot(1, "recorded"), slot(2, "upcoming")]),
    ).toEqual({ kind: "SUBSCRIPTION_ACTIVE" });
    expect(
      retentionText(
        header("CLASS", [slot(1, "recorded"), slot(2, "upcoming")])!,
        day,
      ),
    ).toBe("Kept until 1 year after the last session");
  });

  it("repeats a row's retention only when it differs or ends soon", () => {
    const [row] = timelineRows(view("WEBINAR", [slot(1, "recorded")]));
    const same = { kind: "DATE" as const, until: "2027-10-09T00:00:00.000Z" };
    expect(rowRetention(row!, same, NOW)).toBeNull();
    expect(rowRetention(row!, { kind: "CLASS_RUNNING" }, NOW)).toMatchObject({
      warning: false,
    });
    const soon = {
      ...row!,
      keptUntil: { kind: "DATE" as const, until: "2026-10-20T00:00:00.000Z" },
    };
    expect(rowRetention(soon, same, NOW)).toMatchObject({ warning: true });
  });

  it("phrases the header subline by booking type", () => {
    const facts = (kind: string, slots: RecordingSlot[]) => {
      const v = view(kind, slots);
      return timelineSubline(kind, timelineOf(v, timelineRows(v)), day, day);
    };
    const two = [slot(1, "recorded"), slot(4, "upcoming")];
    expect(facts("CLASS", two)).toBe(
      "Your batch 2026-10-01 – 2026-10-04 · 2 sessions",
    );
    expect(facts("SUBSCRIPTION", two)).toBe("Started 2026-10-01 · 2 sessions");
    expect(facts("TRIAL", [slot(1, "recorded")])).toBe("2026-10-01");
  });
});
