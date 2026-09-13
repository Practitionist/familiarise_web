/**
 * @jest-environment node
 */

/**
 * #1061 / #1554 — end-to-end pin on the room key. A held call is ONE
 * `AppointmentOccurrence` row and `getOrCreateAppointmentMeeting` mints
 * `occurrence-${row.id}`, so the two sides of the same session can only ever
 * land in one Stream call.
 *
 * The Stream SDK and the database are stubbed; what is exercised for real is
 * the entitlement gate, the call profile and the mint in
 * `actions/stream/meetings/meeting.action.ts`.
 *
 * #1270 — the mint moved out of the browser, so the stub is now the SERVER
 * client (`lib/stream-client`) rather than a `StreamVideoClient` the test hands
 * in as an argument. `getOrCreateAppointmentMeeting` no longer takes one.
 */

import type { MeetingSlot } from "@/lib/meeting";

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
}));
// The server-side Stream client the mint now goes through. `mock`-prefixed
// recorders because a jest.mock factory may not close over anything else.
jest.mock("../../lib/stream-client", () => ({
  isStreamConfigured: () => true,
  withStreamCircuitBreaker: <T>(fn: () => T | Promise<T>) => fn(),
  getStreamVideoClient: () => ({
    video: {
      call: (_type: string, id: string) => ({
        getOrCreate: async (payload: unknown) => {
          mockStreamCallsCreated.push(id);
          mockCallPayloads.push(payload as CallData);
          return {};
        },
      }),
    },
  }),
}));
// #1270 — meeting.action now syncs call members to Stream before naming them,
// which pulls the chat client (and its ESM-only node-sdk) into this module
// graph. Mocked here for the same reason every other Stream suite mocks it.
jest.mock("../../actions/stream/chat/user.action", () => ({
  upsertUsersToStream: jest.fn().mockResolvedValue({ users: {} }),
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
jest.mock("../../lib/auth-server", () => ({
  getSession: jest.fn(),
}));
jest.mock("../../lib/auth-helpers", () => ({
  isPrivileged: (role?: string | null) => role === "ADMIN" || role === "STAFF",
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointmentOccurrence: { findUnique: jest.fn(), findMany: jest.fn() },
    appointmentParticipant: { findMany: jest.fn() },
    appointment: { findUnique: jest.fn() },
    meetingSession: {
      findUnique: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
  },
}));

import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { getMaintenanceState } from "@/lib/maintenance";
import { getOrCreateAppointmentMeeting } from "@/lib/meeting";
import { createDbMeetingSession } from "@/actions/stream/meetings/meeting.action";

const db = prisma as unknown as {
  appointmentOccurrence: { findUnique: jest.Mock; findMany: jest.Mock };
  appointmentParticipant: { findMany: jest.Mock };
  appointment: { findUnique: jest.Mock };
  meetingSession: {
    findUnique: jest.Mock;
    create: jest.Mock;
    updateMany: jest.Mock;
  };
};
const mockedGetSession = getSession as unknown as jest.Mock;
const mockedMaintenance = getMaintenanceState as unknown as jest.Mock;

/** Who is calling the server actions. Defaults to the booking's consultee. */
interface Caller {
  id: string;
  consultantProfileId?: string | null;
  role?: string;
  banned?: boolean;
}

function signIn(caller: Caller | null) {
  mockedGetSession.mockResolvedValue(
    caller
      ? {
          user: {
            id: caller.id,
            consultantProfileId: caller.consultantProfileId ?? null,
            role: caller.role ?? "USER",
            banned: caller.banned ?? false,
          },
        }
      : null,
  );
}

const at = (hhmm: string) => new Date(`2026-08-01T${hhmm}:00.000Z`);

interface SlotRow {
  id: string;
  appointmentId: string;
  startsAt: Date;
  endsAt: Date;
  isTentative: boolean;
  completionStatus: string;
  deletedAt: Date | null;
  /** The fixture's roster spec: the appointment's live seats are the union of
   *  these across its rows (#1554 — the real roster is AppointmentParticipant). */
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
let sessions: Array<{
  id: string;
  streamCallId: string;
  slotId: string;
  endedAt?: Date | null;
  endedReason?: string | null;
}> = [];
let mockStreamCallsCreated: string[] = [];
let mockCallPayloads: CallData[] = [];

function seed(
  slotRows: SlotRow[],
  appointment: Record<string, unknown> | null = consultationAppointment,
  caller: Caller | null = { id: "user-consultee" },
) {
  rows = slotRows;
  appointmentRow = appointment;
  sessions = [];
  mockStreamCallsCreated = [];
  mockCallPayloads = [];
  signIn(caller);

  const seatsOf = (appointmentId: string) =>
    Array.from(
      new Set(
        rows
          .filter((r) => r.appointmentId === appointmentId)
          .flatMap((r) => r.user.map((u) => u.id)),
      ),
    );
  // Both resolvers read a single row through the authorization gate, which
  // pulls the appointment's plan graph and — filtered to the caller — the
  // caller's own seat. An empty `participants` is how the real query says
  // "this caller does not participate" (#1554).
  db.appointmentOccurrence.findUnique.mockImplementation(
    async ({ where }: { where: { id: string } }) => {
      const row = rows.find((r) => r.id === where.id);
      if (!row) return null;
      const participates =
        !!caller && seatsOf(row.appointmentId).includes(caller.id);
      return {
        ...row,
        appointment: appointmentRow
          ? {
              ...appointmentRow,
              participants: participates ? [{ id: "seat-caller" }] : [],
            }
          : null,
      };
    },
  );
  // The 1:1 attendee naming reads the roster with display fields.
  db.appointmentParticipant.findMany.mockImplementation(
    async ({ where }: { where: { appointmentId: string } }) =>
      seatsOf(where.appointmentId).map((id) => ({ user: { id, name: id } })),
  );
  db.appointmentOccurrence.findMany.mockImplementation(
    // Cancelled/rescheduled rows are deliberately NOT filtered here: the query
    // only excludes the soft-delete tombstone and leaves every liveness rule
    // to the occurrence helpers, so this fake must hand those rows over too.
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
    async ({ where }: { where: { appointmentOccurrenceId: string } }) =>
      sessions.find((s) => s.slotId === where.appointmentOccurrenceId) ?? null,
  );
  db.meetingSession.updateMany.mockReset();
  db.meetingSession.updateMany.mockImplementation(
    async ({
      where,
      data,
    }: {
      where: { id: string; endedReason: string };
      data: { streamCallId: string };
    }) => {
      const row = sessions.find(
        (s) => s.id === where.id && s.endedReason === where.endedReason,
      );
      if (!row) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    },
  );
  db.meetingSession.create.mockImplementation(
    async ({
      data,
    }: {
      data: {
        streamCallId: string;
        occurrence: { connect: { id: string } };
      };
    }) => {
      const created = {
        id: `ms-${sessions.length + 1}`,
        streamCallId: data.streamCallId,
        slotId: data.occurrence.connect.id,
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
    // The node SDK types `starts_at` as a Date, unlike the browser SDK the
    // mint used to run through.
    starts_at?: Date;
    created_by_id?: string;
    custom?: Record<string, unknown>;
    members?: CallMember[];
    backstage?: unknown;
    settings_override?: unknown;
  };
}

function meetingSlot(row: SlotRow): MeetingSlot {
  return {
    id: row.id,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    isTentative: row.isTentative,
    appointmentId: row.appointmentId,
  };
}

const join = (row: SlotRow) => getOrCreateAppointmentMeeting(meetingSlot(row));

/** `starts_at` as an ISO string, so the assertions below stay readable. */
const startedAt = (payload: CallData) => payload.data?.starts_at?.toISOString();

describe("room identity for a session longer than 30 minutes", () => {
  const rowA = () => slotRow("A", "10:00", "11:00");

  it("puts the consultant and a later consultee in the same room", async () => {
    const a = rowA();
    seed([a]);

    // Appointments tab, five minutes in: hands over row A.
    const consultantRoom = await join(a);
    // Home tab, twenty-five minutes in: used to hand over row B.
    const consulteeRoom = await join(a);

    expect(consultantRoom).toBe("occurrence-A");
    expect(consulteeRoom).toBe("occurrence-A");
    expect(mockStreamCallsCreated).toEqual(["occurrence-A"]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].slotId).toBe("A");
  });

  it("stamps the occurrence into the call's metadata and start time", async () => {
    const a = rowA();
    seed([a]);

    await join(a);

    expect(mockCallPayloads).toHaveLength(1);
    const custom = mockCallPayloads[0].data?.custom;
    expect(custom?.slotId).toBe("A");
    expect(custom?.occurrenceId).toBe("A");
    expect(custom?.appointmentId).toBe("appt-1");
    expect(startedAt(mockCallPayloads[0])).toBe(a.startsAt.toISOString());
  });

  it("holds across repeated joins of a two-hour session", async () => {
    const two = slotRow("A", "10:00", "12:00");
    seed([two]);

    const roomIds = [];
    for (let i = 0; i < 4; i++) roomIds.push(await join(two));

    expect(roomIds).toEqual([
      "occurrence-A",
      "occurrence-A",
      "occurrence-A",
      "occurrence-A",
    ]);
    expect(mockStreamCallsCreated).toEqual(["occurrence-A"]);
  });

  it("reuses the stored call id rather than re-deriving it", async () => {
    const a = rowA();
    seed([a]);
    // A room minted before this fix, or by a seed, keeps its opaque id.
    sessions.push({
      id: "ms-legacy",
      streamCallId: "legacy-uuid",
      slotId: "A",
    });

    expect(await join(a)).toBe("legacy-uuid");
    expect(mockStreamCallsCreated).toEqual([]);
  });
});

/**
 * #1607 — a room the host closed before the booked start is dead on Stream, so
 * the next join rebuilds it under a fresh id; any other recorded end is not a
 * reason to mint.
 */
describe("a room closed before the start is rebuilt on the next join", () => {
  const rowA = () => slotRow("A", "10:00", "11:00");

  it("mints a suffixed call and rebinds the row for an ended_early room", async () => {
    seed([rowA()]);
    sessions.push({
      id: "ms-1",
      streamCallId: "occurrence-A",
      slotId: "A",
      endedAt: at("09:48"),
      endedReason: "ended_early",
    });

    const room = await join(rowA());

    expect(room).toMatch(/^occurrence-A-r[0-9a-z]+$/);
    expect(mockStreamCallsCreated).toEqual([room]);
    expect(db.meetingSession.updateMany).toHaveBeenCalledWith({
      where: { id: "ms-1", endedReason: "ended_early" },
      data: {
        streamCallId: room,
        endedAt: null,
        endedReason: null,
        isRecording: false,
      },
    });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].streamCallId).toBe(room);
  });

  it("hands back the same room after an inactivity timeout", async () => {
    seed([rowA()]);
    sessions.push({
      id: "ms-1",
      streamCallId: "occurrence-A",
      slotId: "A",
      endedAt: at("10:05"),
      endedReason: "session_timeout",
    });

    expect(await join(rowA())).toBe("occurrence-A");
    expect(mockStreamCallsCreated).toEqual([]);
    expect(db.meetingSession.updateMany).not.toHaveBeenCalled();
  });
});

/**
 * #1070 — a call created with nothing but an id is illegible in Stream's
 * dashboard and leaves each surface to infer who is hosting.
 */
describe("the call describes the session it belongs to", () => {
  const custom = () => mockCallPayloads[0].data?.custom ?? {};
  const members = () => mockCallPayloads[0].data?.members ?? [];

  it("reports the occurrence's bounds", async () => {
    const [a] = [slotRow("A", "10:00", "11:00")];
    seed([a]);

    await join(a);

    expect(startedAt(mockCallPayloads[0])).toBe(at("10:00").toISOString());
    expect(custom().sessionStartsAt).toBe(at("10:00").toISOString());
    expect(custom().sessionEndsAt).toBe(at("11:00").toISOString());
    expect(custom().sessionDurationMinutes).toBe(60);
  });

  it("carries the offering title so a recording is legible", async () => {
    seed([slotRow("A", "10:00", "11:00")]);

    await join(rows[0]);

    expect(custom().offeringTitle).toBe("Career strategy deep dive");
  });

  it("names both sides call_member, and records the host in custom", async () => {
    const [a] = [slotRow("A", "10:00", "11:00")];
    seed([a]);

    await join(a);

    // #1270 — the consultant used to be stamped `host` and the consultee
    // `user`. The live `default` call type has no `host` role at all, so that
    // consultant held nothing; and once ensure-call-type-grants strips
    // `join-call` from `user`, the consultee holds nothing either. Both sides
    // get the one role the join route assigns and the grants script keeps
    // `join-call` on. Who hosts is carried in `custom`, which is what the UI
    // has always read.
    expect(members()).toEqual([
      { user_id: "user-consultant", role: "call_member" },
      { user_id: "user-consultee", role: "call_member" },
    ]);
    expect(custom().consultantUserId).toBe("user-consultant");
    expect(custom().consulteeUserId).toBe("user-consultee");
  });

  it("makes the consultant the call's author, not whoever clicked Join", async () => {
    const [a] = [slotRow("A", "10:00", "11:00")];
    // The consultee is the one joining, as they are for half of all sessions.
    seed([a], consultationAppointment, { id: "user-consultee" });

    await join(a);

    expect(mockCallPayloads[0].data?.created_by_id).toBe("user-consultant");
  });

  it("resolves a webinar's hosts through plan ownership, not the joiner", async () => {
    // The person clicking Join is an attendee; neither host is connected to
    // the slot, so anything that assumed "the caller hosts" would be wrong.
    seed(
      [slotRow("A", "10:00", "11:00", { user: [{ id: "user-attendee" }] })],
      webinarAppointment,
      { id: "user-attendee" },
    );

    await join(rows[0]);

    expect(members()).toEqual([
      { user_id: "user-owner", role: "call_member" },
      { user_id: "user-collab", role: "call_member" },
    ]);
    // Attendees are not named: a large webinar would blow the request size
    // and turn a working join into a failure.
    expect(members().some((m) => m.user_id === "user-attendee")).toBe(false);
    expect(custom().offeringTitle).toBe("Scaling past Series A");
  });

  it("never asks Stream to gate entry", async () => {
    seed([slotRow("A", "10:00", "11:00")]);

    await join(rows[0]);

    // Approach C in #1070 is deferred: backstage and join_ahead_time_seconds
    // let Stream REFUSE a join, which we cannot see or fix without a deploy.
    // Both are call SETTINGS, so they are pinned on the settings surface —
    // asserting them inside `custom` would pass for any implementation,
    // because nothing could ever put them there.
    expect(mockCallPayloads[0].data?.backstage).toBeUndefined();

    // #1280 — `settings_override` is no longer empty, so the pin moved INTO it
    // rather than being dropped.
    //
    // It used to assert the whole object absent, which was the strongest
    // available form when nothing legitimately belonged there. The duration cap
    // now does: `limits.max_duration_seconds` ENDS a session that is already
    // running and cannot refuse anyone entry, so it does not touch the
    // invariant this case exists for. Whitelisting the exact nested shape keeps
    // that invariant sharper than the old blanket check did — a `backstage` or
    // `join_ahead_time_seconds` smuggled in one level down would have satisfied
    // "settings_override is undefined" only by not existing at all, whereas now
    // it fails on the key set.
    const settingsOverride = mockCallPayloads[0].data?.settings_override as
      | Record<string, unknown>
      | undefined;
    expect(Object.keys(settingsOverride ?? {})).toEqual(["limits"]);
    expect(
      Object.keys((settingsOverride?.limits as Record<string, unknown>) ?? {}),
    ).toEqual(["max_duration_seconds"]);

    // Adding a field at the top level still fails here. `created_by_id` joined
    // this set in #1270 — a server-side getOrCreate carries no user context, so
    // Stream refuses the whole request without an explicit author.
    expect(Object.keys(mockCallPayloads[0].data ?? {}).sort()).toEqual([
      "created_by_id",
      "custom",
      "members",
      "settings_override",
      "starts_at",
    ]);
  });

  it("sends a duration cap that cannot cut the booked session short", async () => {
    // The cap counts from FIRST JOIN, not from `starts_at` (#1160 correcting
    // #1144). A 30-minute booking whose consultant arrives 15 minutes early
    // must still have the full booked window left when the clock starts.
    seed([slotRow("A", "10:00", "11:00")]);

    await join(rows[0]);

    const cap = (
      (mockCallPayloads[0].data?.settings_override as Record<string, unknown>)
        ?.limits as Record<string, number>
    ).max_duration_seconds;

    expect(Number.isInteger(cap)).toBe(true);
    expect(cap).toBeGreaterThan(30 * 60);
  });

  it("still creates the call when only the profile fails", async () => {
    const [a] = [slotRow("A", "10:00", "11:00")];
    seed([a]);
    // The entitlement gate resolves; the profile's roster read then falls
    // over.
    db.appointmentParticipant.findMany.mockImplementationOnce(async () => {
      throw new Error("db down");
    });

    // Everything the profile feeds is optional, so a null profile must still
    // produce the anchored call this code produced before #1070.
    expect(await join(a)).toBe("occurrence-A");
    expect(mockCallPayloads[0].data?.members).toBeUndefined();
    expect(custom().sessionEndsAt).toBeUndefined();
    expect(custom().occurrenceId).toBe("A");
    expect(startedAt(mockCallPayloads[0])).toBe(at("10:00").toISOString());

    // #1305 review — and NO duration cap. The cap counts from first join, so a
    // value guessed from a default would terminate a four-hour webinar two
    // hours in. With no resolved run there is no safe number, and omitting the
    // field is exactly the behaviour before the backstop existed: the call type
    // carries no limit of its own.
    expect(mockCallPayloads[0].data?.settings_override).toBeUndefined();
  });

  it("creates nothing at all when the slot resolves to no appointment", async () => {
    const [a] = [slotRow("A", "10:00", "11:00")];
    seed([a], null);

    // No appointment means entitlement cannot be established at all. The
    // column is required in the schema, so this is a guard against corrupt
    // data, not a path any real booking takes.
    //
    // #1270 — the browser used to mint the call FIRST and only then call
    // `createDbMeetingSession`, where the entitlement check lived. So a refused
    // join still left a real, billable Stream room behind that our database
    // would never point at. The check now runs before the mint.
    await expect(join(a)).rejects.toThrow(
      "You are not a participant in this session.",
    );
    expect(mockStreamCallsCreated).toEqual([]);
    expect(mockCallPayloads).toEqual([]);
    expect(sessions).toEqual([]);
  });
});

/**
 * Both resolvers are exported from a `"use server"` module, so they are
 * callable directly by any signed-in client with any slot id. Validating the
 * shape of that id is not authorization: the profile hands back the offering
 * title and the user ids and names on both sides.
 */
describe("only people involved in the booking may resolve it", () => {
  const twoRows = () => [slotRow("A", "10:00", "11:00")];

  it("tells a stranger nothing about someone else's session", async () => {
    seed(twoRows(), consultationAppointment, { id: "user-stranger" });

    // The join is refused outright, and — since #1270 moved the mint behind the
    // same gate — nothing reaches Stream on the way to that refusal either. It
    // used to leave a real room behind, undescribed but billable and joinable.
    await expect(join(rows[0])).rejects.toThrow(
      "You are not a participant in this session.",
    );
    expect(mockStreamCallsCreated).toEqual([]);
    expect(mockCallPayloads).toEqual([]);
    expect(sessions).toEqual([]);
  });

  it("gives a participating consultee the anchor and the profile", async () => {
    seed(twoRows(), consultationAppointment, { id: "user-consultee" });

    expect(await join(rows[0])).toBe("occurrence-A");
    expect(mockCallPayloads[0].data?.members).toEqual([
      { user_id: "user-consultant", role: "call_member" },
      { user_id: "user-consultee", role: "call_member" },
    ]);
  });

  it("gives the owning consultant the same, via plan ownership", async () => {
    // Not connected to any slot row, so participation cannot be what lets
    // this caller through — `resolvePlanOwnerIds` is.
    seed(
      [slotRow("A", "10:00", "11:00", { user: [{ id: "user-consultee" }] })],
      consultationAppointment,
      { id: "user-consultant", consultantProfileId: "cp-1" },
    );

    expect(await join(rows[0])).toBe("occurrence-A");
    expect(mockCallPayloads[0].data?.custom?.offeringTitle).toBe(
      "Career strategy deep dive",
    );
  });

  it("does not let an unrelated consultant in on their profile id", async () => {
    seed(twoRows(), consultationAppointment, {
      id: "user-other-consultant",
      consultantProfileId: "cp-999",
    });

    await expect(join(rows[0])).rejects.toThrow(
      "You are not a participant in this session.",
    );
    expect(mockStreamCallsCreated).toEqual([]);
    expect(sessions).toEqual([]);
  });

  it("admits an ACCEPTED collaborator on a webinar", async () => {
    seed(
      [slotRow("A", "10:00", "11:00", { user: [{ id: "user-attendee" }] })],
      webinarAppointment,
      { id: "user-collab", consultantProfileId: "cp-collab" },
    );

    expect(await join(rows[0])).toBe("occurrence-A");
    expect(mockCallPayloads[0].data?.custom?.offeringTitle).toBe(
      "Scaling past Series A",
    );
  });

  it("refuses a signed-out or banned caller", async () => {
    seed(twoRows(), consultationAppointment, null);
    await expect(join(rows[0])).rejects.toThrow(
      "You are not a participant in this session.",
    );

    seed(twoRows(), consultationAppointment, {
      id: "user-consultee",
      banned: true,
    });
    await expect(join(rows[0])).rejects.toThrow(
      "You are not a participant in this session.",
    );
  });
});

describe("every occurrence is keyed to its own row", () => {
  it("keys a 30-minute booking to its row", async () => {
    const solo = slotRow("solo", "10:00", "10:30");
    seed([solo]);

    expect(await join(solo)).toBe("occurrence-solo");
  });

  it("keys a single full-duration row to itself", async () => {
    const webinar = slotRow("webinar", "10:00", "12:00");
    seed([webinar]);

    expect(await join(webinar)).toBe("occurrence-webinar");
  });

  it("gives a second sitting its own room", async () => {
    const morning = slotRow("A", "10:00", "11:00");
    const afternoon = slotRow("C", "14:00", "14:30");
    seed([morning, afternoon]);

    expect(await join(morning)).toBe("occurrence-A");
    expect(await join(afternoon)).toBe("occurrence-C");
  });
});

/**
 * #1077 — the maintenance gate lived at the top of `createDbMeetingSession`,
 * which runs AFTER `call.getOrCreate`. A blocked join therefore left a live
 * Stream call that no `MeetingSession` row points at, stamped with the bounds
 * and members computed at the blocked moment and never corrected, because only
 * the mint branch writes them.
 *
 * The assertion that matters is the negative one: the Stream stub must not
 * have been invoked at all. A test that only checked the rejection would have
 * passed before this fix.
 */
describe("a refused join creates nothing on Stream", () => {
  afterEach(() => {
    mockedMaintenance.mockResolvedValue({ phase: "OFF" });
  });

  it("does not mint a call when maintenance blocks it", async () => {
    seed([slotRow("A", "10:00", "11:00")]);
    mockedMaintenance.mockResolvedValue({ phase: "OFFLINE" });

    await expect(join(rows[0])).rejects.toThrow(
      "New calls cannot be created during maintenance.",
    );

    expect(mockStreamCallsCreated).toEqual([]);
    expect(mockCallPayloads).toEqual([]);
    expect(db.meetingSession.create).not.toHaveBeenCalled();
  });

  it("still lets both sides back into a room that already exists", async () => {
    // Maintenance refuses NEW calls only. Hoisting the gate must not put it in
    // front of the existence check, or it would cut off a session in progress.
    seed([slotRow("A", "10:00", "11:00")]);
    sessions.push({ id: "ms-0", streamCallId: "occurrence-A", slotId: "A" });
    mockedMaintenance.mockResolvedValue({ phase: "OFFLINE" });

    expect(await join(rows[0])).toBe("occurrence-A");
    expect(mockStreamCallsCreated).toEqual([]);
  });

  it("does not mint a call for a slot that is not one", async () => {
    // The other precondition hoisted with the gate. Unresolvable id, so the
    // anchor lookup falls back to this object.
    //
    // #1270 review — the refusal a stranger sees is the ENTITLEMENT one, not
    // the shape or booking-state one. Entitlement was moved ahead of
    // `getMeetingCreationRefusal` because that helper reads the persisted slot
    // and its parent booking status for any id it is handed, and returns the
    // result to the caller as data: running it first let anyone who guessed a
    // slot id learn another user's booking state. One answer, and it tells
    // them nothing.
    seed([]);

    await expect(
      getOrCreateAppointmentMeeting({
        id: "ghost",
        startsAt: "not a date",
        endsAt: null,
      }),
    ).rejects.toThrow("You are not a participant in this session.");

    expect(mockStreamCallsCreated).toEqual([]);
  });

  it("tells a stranger nothing about the booking they guessed at", async () => {
    // The leak, stated as a test: a real slot on a real booking whose state
    // WOULD produce a distinctive refusal. The caller is not on it, so they
    // must get the same answer as for a slot that does not exist at all.
    seed([
      slotRow("A", "10:00", "10:30", {
        isTentative: true,
        user: [{ id: "someone-else" }],
      }),
    ]);

    await expect(
      getOrCreateAppointmentMeeting({
        id: "A",
        startsAt: "10:00",
        endsAt: "10:30",
      }),
    ).rejects.toThrow("You are not a participant in this session.");

    expect(mockStreamCallsCreated).toEqual([]);
  });
});

/**
 * The writer, not just the readers.
 *
 * `readSlotForCaller` was added to gate the two RESOLVERS, and the exported
 * writer in the same `"use server"` module was left open. Any client can call
 * a server action with arguments of its choosing, so an unrelated caller could
 * write the `MeetingSession` row for someone else's slot with a
 * `streamCallId` of their choosing — and because that row is unique per slot,
 * never updated, and reused by every later join, both legitimate parties would
 * then be routed into a Stream call the attacker controls.
 */
describe("only a participant may create a session", () => {
  const stranger: Caller = { id: "user-stranger" };

  it("refuses to write a session for a booking the caller is not in", async () => {
    seed([slotRow("A", "10:00", "11:00")], consultationAppointment, stranger);

    await expect(
      createDbMeetingSession(meetingSlot(rows[0]), "slot-attacker-controlled"),
    ).rejects.toThrow("You are not a participant in this session.");

    // The assertion that matters: no row exists to be reused by anyone.
    expect(db.meetingSession.create).not.toHaveBeenCalled();
    expect(sessions).toEqual([]);
  });

  it("refuses a signed-out caller too", async () => {
    seed([slotRow("A", "10:00", "11:00")], consultationAppointment, null);

    await expect(
      createDbMeetingSession(meetingSlot(rows[0]), "occurrence-A"),
    ).rejects.toThrow("You are not a participant in this session.");
    expect(db.meetingSession.create).not.toHaveBeenCalled();
  });

  it("still lets a participant create their own session", async () => {
    seed([slotRow("A", "10:00", "11:00")]);

    await expect(
      createDbMeetingSession(meetingSlot(rows[0]), "occurrence-A"),
    ).resolves.toMatchObject({ streamCallId: "occurrence-A" });
  });
});
