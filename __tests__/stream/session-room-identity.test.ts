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
    ...extra,
  };
}

/** Rows the fake DB serves, plus the MeetingSession table the test writes to. */
let rows: SlotRow[] = [];
let sessions: Array<{ id: string; streamCallId: string; slotId: string }> = [];
let streamCallsCreated: string[] = [];

function seed(slotRows: SlotRow[]) {
  rows = slotRows;
  sessions = [];
  streamCallsCreated = [];

  db.slotOfAppointment.findUnique.mockImplementation(
    async ({ where }: { where: { id: string } }) =>
      rows.find((r) => r.id === where.id) ?? null,
  );
  db.slotOfAppointment.findMany.mockImplementation(
    async ({
      where,
    }: {
      where: { appointmentId: string; completionStatus: { notIn: string[] } };
    }) =>
      rows
        .filter(
          (r) =>
            r.appointmentId === where.appointmentId &&
            r.deletedAt === null &&
            !where.completionStatus.notIn.includes(r.completionStatus),
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

const client = {
  call: (_type: string, id: string) => ({
    getOrCreate: async () => {
      streamCallsCreated.push(id);
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
