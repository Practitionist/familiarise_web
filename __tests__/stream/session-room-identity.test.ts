/**
 * @jest-environment node
 */

/**
 * #1061 — end-to-end pin on the room key. `getOrCreateAppointmentMeeting` used
 * to mint `slot-${clickedRow.id}`, so a one-hour booking (two `SlotOfAppointment`
 * rows) had capacity for two Stream calls and the two sides of the same session
 * could each sit alone in one of them.
 *
 * The Stream SDK and the database are stubbed; what is exercised for real is
 * the anchor resolution in `actions/stream/meetings/meeting.action.ts` and the
 * id it produces in `lib/meeting.ts`.
 */

import type { StreamVideoClient } from "@stream-io/video-react-sdk";
import type { MeetingAppointment, MeetingSlot } from "@/lib/meeting";

jest.mock("@stream-io/video-react-sdk", () => ({
  __esModule: true,
  StreamVideoClient: class {},
}));
jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
}));
jest.mock("../../lib/stream-logger", () => ({
  streamLogger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));
jest.mock("../../lib/maintenance", () => ({
  getMaintenanceState: jest.fn().mockResolvedValue({ phase: "OFF" }),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    slotOfAppointment: { findUnique: jest.fn(), findMany: jest.fn() },
    appointment: { findUnique: jest.fn() },
    meetingSession: { findUnique: jest.fn(), create: jest.fn() },
  },
}));

import prisma from "@/lib/prisma";
import { getOrCreateAppointmentMeeting } from "@/lib/meeting";

const db = prisma as unknown as {
  slotOfAppointment: { findUnique: jest.Mock; findMany: jest.Mock };
  appointment: { findUnique: jest.Mock };
  meetingSession: { findUnique: jest.Mock; create: jest.Mock };
};

const at = (hhmm: string) => new Date(`2026-08-01T${hhmm}:00.000Z`);

interface SlotRow {
  id: string;
  appointmentId: string;
  startsAt: Date;
  endsAt: Date;
  isTentative: boolean;
  completionStatus: string;
  deletedAt: Date | null;
  /** Users connected to this row — both sides for a 1:1, attendees for a group. */
  user: Array<{ id: string }>;
}

function slotRow(
  id: string,
  start: string,
  end: string,
  extra: Partial<SlotRow> = {},
): SlotRow {
  return {
    id,
    appointmentId: "appt-1",
    startsAt: at(start),
    endsAt: at(end),
    isTentative: false,
    completionStatus: "SCHEDULED",
    deletedAt: null,
    user: [{ id: "user-consultant" }, { id: "user-consultee" }],
    ...extra,
  };
}

const profile = (id: string, userId: string) => ({ id, userId });

/** The plan graph `resolveSessionCallProfile` reads ownership out of. */
const consultationAppointment = {
  appointmentType: "CONSULTATION",
  consultation: {
    consultationPlan: {
      title: "Career strategy deep dive",
      consultantProfile: profile("cp-1", "user-consultant"),
    },
  },
};

/** Owner plus an ACCEPTED collaborator, neither of whom is the joiner. */
const webinarAppointment = {
  appointmentType: "WEBINAR",
  webinar: {
    webinarPlan: {
      title: "Scaling past Series A",
      consultantProfile: profile("cp-owner", "user-owner"),
      collaborators: [
        { consultantProfile: profile("cp-collab", "user-collab") },
      ],
    },
  },
};

/** Rows the fake DB serves, plus the MeetingSession table the test writes to. */
let appointmentRow: Record<string, unknown> | null = consultationAppointment;
let rows: SlotRow[] = [];
let sessions: Array<{ id: string; streamCallId: string; slotId: string }> = [];
let streamCallsCreated: string[] = [];
let callPayloads: CallData[] = [];

function seed(
  slotRows: SlotRow[],
  appointment: Record<string, unknown> | null = consultationAppointment,
) {
  rows = slotRows;
  appointmentRow = appointment;
  sessions = [];
  streamCallsCreated = [];
  callPayloads = [];

  // Both the anchor walk and the call profile read a single row; the profile
  // additionally pulls the appointment's plan graph off it.
  db.slotOfAppointment.findUnique.mockImplementation(
    async ({ where }: { where: { id: string } }) => {
      const row = rows.find((r) => r.id === where.id);
      return row ? { ...row, appointment: appointmentRow } : null;
    },
  );
  db.slotOfAppointment.findMany.mockImplementation(
    // Cancelled/rescheduled rows are deliberately NOT filtered here: the query
    // only excludes the soft-delete tombstone and leaves every session rule to
    // groupSlotsIntoRuns, so this fake must hand those rows over too.
    async ({ where }: { where: { appointmentId: string; deletedAt: null } }) =>
      rows
        .filter(
          (r) =>
            r.appointmentId === where.appointmentId && r.deletedAt === null,
        )
        .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime()),
  );
  db.appointment.findUnique.mockResolvedValue({ organizationId: null });
  db.meetingSession.findUnique.mockImplementation(
    async ({ where }: { where: { slotOfAppointmentId: string } }) =>
      sessions.find((s) => s.slotId === where.slotOfAppointmentId) ?? null,
  );
  db.meetingSession.create.mockImplementation(
    async ({
      data,
    }: {
      data: {
        streamCallId: string;
        slotOfAppointment: { connect: { id: string } };
      };
    }) => {
      const created = {
        id: `ms-${sessions.length + 1}`,
        streamCallId: data.streamCallId,
        slotId: data.slotOfAppointment.connect.id,
      };
      sessions.push(created);
      return created;
    },
  );
}

interface CallMember {
  user_id: string;
  role: string;
}

interface CallData {
  data?: {
    starts_at?: string;
    custom?: Record<string, unknown>;
    members?: CallMember[];
    backstage?: unknown;
    settings_override?: unknown;
  };
}

const client = {
  call: (_type: string, id: string) => ({
    getOrCreate: async (payload: CallData) => {
      streamCallsCreated.push(id);
      callPayloads.push(payload);
      return {};
    },
  }),
} as unknown as StreamVideoClient;

function meetingSlot(row: SlotRow): MeetingSlot {
  return {
    id: row.id,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    isTentative: row.isTentative,
    appointmentId: row.appointmentId,
  };
}

const appointment: MeetingAppointment = {
  id: "appt-1",
  appointmentType: "CONSULTATION",
  slotsOfAppointment: [],
};

const join = (row: SlotRow) =>
  getOrCreateAppointmentMeeting(client, appointment, meetingSlot(row));

describe("room identity for a session longer than 30 minutes", () => {
  const rowA = () => slotRow("A", "10:00", "10:30");
  const rowB = () => slotRow("B", "10:30", "11:00");

  it("puts the consultant and a later consultee in the same room", async () => {
    const [a, b] = [rowA(), rowB()];
    seed([a, b]);

    // Appointments tab, five minutes in: hands over row A.
    const consultantRoom = await join(a);
    // Home tab, twenty-five minutes in: used to hand over row B.
    const consulteeRoom = await join(b);

    expect(consultantRoom).toBe("slot-A");
    expect(consulteeRoom).toBe("slot-A");
    expect(streamCallsCreated).toEqual(["slot-A"]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].slotId).toBe("A");
  });

  it("stamps the anchor into the call's metadata and start time", async () => {
    const [a, b] = [rowA(), rowB()];
    seed([a, b]);

    // Joined from row B, so an unanchored stamp would read "B" / 10:30.
    await join(b);

    expect(callPayloads).toHaveLength(1);
    const custom = callPayloads[0].data?.custom;
    expect(custom?.slotId).toBe("A");
    expect(custom?.anchorSlotId).toBe("A");
    expect(custom?.appointmentId).toBe("appt-1");
    expect(callPayloads[0].data?.starts_at).toBe(a.startsAt.toISOString());
  });

  it("anchors to row A even when row B is the first to be joined", async () => {
    const [a, b] = [rowA(), rowB()];
    seed([a, b]);

    expect(await join(b)).toBe("slot-A");
    expect(sessions[0].slotId).toBe("A");
  });

  it("holds for every row of a two-hour session", async () => {
    const all = [
      slotRow("A", "10:00", "10:30"),
      slotRow("B", "10:30", "11:00"),
      slotRow("C", "11:00", "11:30"),
      slotRow("D", "11:30", "12:00"),
    ];
    seed(all);

    const roomIds = [];
    for (const row of all) roomIds.push(await join(row));

    expect(roomIds).toEqual(["slot-A", "slot-A", "slot-A", "slot-A"]);
    expect(streamCallsCreated).toEqual(["slot-A"]);
  });

  it("reuses the stored call id rather than re-deriving it", async () => {
    const [a, b] = [rowA(), rowB()];
    seed([a, b]);
    // A room minted before this fix, or by a seed, keeps its opaque id.
    sessions.push({
      id: "ms-legacy",
      streamCallId: "legacy-uuid",
      slotId: "A",
    });

    expect(await join(b)).toBe("legacy-uuid");
    expect(streamCallsCreated).toEqual([]);
  });
});

/**
 * #1070 — a call created with nothing but an id is illegible in Stream's
 * dashboard and leaves each surface to infer who is hosting.
 */
describe("the call describes the session it belongs to", () => {
  const custom = () => callPayloads[0].data?.custom ?? {};
  const members = () => callPayloads[0].data?.members ?? [];

  it("reports the run's bounds, not the clicked row's", async () => {
    const [a, b] = [
      slotRow("A", "10:00", "10:30"),
      slotRow("B", "10:30", "11:00"),
    ];
    seed([a, b]);

    // Joined at the half hour: an unanchored call would claim a 10:30 start
    // and a 30-minute meeting.
    await join(b);

    expect(callPayloads[0].data?.starts_at).toBe(at("10:00").toISOString());
    expect(custom().sessionStartsAt).toBe(at("10:00").toISOString());
    expect(custom().sessionEndsAt).toBe(at("11:00").toISOString());
    expect(custom().sessionDurationMinutes).toBe(60);
  });

  it("carries the offering title so a recording is legible", async () => {
    seed([slotRow("A", "10:00", "10:30")]);

    await join(rows[0]);

    expect(custom().offeringTitle).toBe("Career strategy deep dive");
  });

  it("makes the consultant host and the consultee a plain member", async () => {
    const [a, b] = [
      slotRow("A", "10:00", "10:30"),
      slotRow("B", "10:30", "11:00"),
    ];
    seed([a, b]);

    await join(b);

    expect(members()).toEqual([
      { user_id: "user-consultant", role: "host" },
      { user_id: "user-consultee", role: "user" },
    ]);
    expect(custom().consultantUserId).toBe("user-consultant");
    expect(custom().consulteeUserId).toBe("user-consultee");
  });

  it("resolves a webinar's hosts through plan ownership, not the joiner", async () => {
    // The person clicking Join is an attendee; neither host is connected to
    // the slot, so anything that assumed "the caller hosts" would be wrong.
    seed(
      [
        slotRow("A", "10:00", "10:30", { user: [{ id: "user-attendee" }] }),
        slotRow("B", "10:30", "11:00", { user: [{ id: "user-attendee" }] }),
      ],
      webinarAppointment,
    );

    await join(rows[1]);

    expect(members()).toEqual([
      { user_id: "user-owner", role: "host" },
      { user_id: "user-collab", role: "host" },
    ]);
    // Attendees are not named: a large webinar would blow the request size
    // and turn a working join into a failure.
    expect(members().some((m) => m.user_id === "user-attendee")).toBe(false);
    expect(custom().offeringTitle).toBe("Scaling past Series A");
  });

  it("never asks Stream to gate entry", async () => {
    seed([slotRow("A", "10:00", "10:30")]);

    await join(rows[0]);

    // Approach C in #1070 is deferred: backstage and join_ahead_time_seconds
    // let Stream REFUSE a join, which we cannot see or fix without a deploy.
    expect(callPayloads[0].data?.backstage).toBeUndefined();
    expect(callPayloads[0].data?.settings_override).toBeUndefined();
    expect(custom().join_ahead_time_seconds).toBeUndefined();
  });

  it("still creates the call when the profile cannot be resolved", async () => {
    const [a, b] = [
      slotRow("A", "10:00", "10:30"),
      slotRow("B", "10:30", "11:00"),
    ];
    seed([a, b], null);

    // Everything the profile feeds is optional, so a null profile must produce
    // exactly the call this code produced before #1070.
    expect(await join(b)).toBe("slot-A");
    expect(callPayloads[0].data?.members).toBeUndefined();
    expect(custom().sessionEndsAt).toBeUndefined();
    expect(custom().anchorSlotId).toBe("A");
    expect(callPayloads[0].data?.starts_at).toBe(at("10:00").toISOString());
  });
});

describe("sessions that were never affected", () => {
  it("leaves a 30-minute booking keyed to its own row", async () => {
    const solo = slotRow("solo", "10:00", "10:30");
    seed([solo]);

    expect(await join(solo)).toBe("slot-solo");
  });

  it("leaves a single full-duration row keyed to itself", async () => {
    const webinar = slotRow("webinar", "10:00", "12:00");
    seed([webinar]);

    expect(await join(webinar)).toBe("slot-webinar");
  });

  it("gives a second, non-contiguous sitting its own room", async () => {
    const morning = slotRow("A", "10:00", "10:30");
    const afternoon = slotRow("C", "14:00", "14:30");
    seed([morning, afternoon]);

    expect(await join(morning)).toBe("slot-A");
    expect(await join(afternoon)).toBe("slot-C");
  });

  it("does not walk back through a cancelled row", async () => {
    seed([
      slotRow("A", "10:00", "10:30", { completionStatus: "CANCELLED" }),
      slotRow("B", "10:30", "11:00"),
    ]);

    expect(await join(rows[1])).toBe("slot-B");
  });
});

describe("anchor resolution failure", () => {
  it("falls back to the row it was given instead of blocking the join", async () => {
    const [a, b] = [
      slotRow("A", "10:00", "10:30"),
      slotRow("B", "10:30", "11:00"),
    ];
    seed([a, b]);
    db.slotOfAppointment.findMany.mockRejectedValue(new Error("db down"));

    expect(await join(b)).toBe("slot-B");
  });
});
