/**
 * @jest-environment node
 */

/**
 * #1829 — the two P1s in the meeting provisioning path, and the ONE payload that
 * closes both.
 *
 * ## Defect A: a failed first mint left the room to be built by whoever arrived
 *
 * #C1 writes the `Meeting` row BEFORE the Stream call, which is what makes an
 * untracked provider room impossible: every reconciler finds work by SCANNING
 * `prisma.meeting`, so a call with no row is invisible to all of them, forever.
 * The price of that ordering is that the row can outlive its call — and the room
 * is materialised by the next person through `POST /api/meetings/[meetingId]/join`,
 * which used to recover with `getOrCreate({ data: { created_by_id: userId } })`.
 *
 * For half of all sessions `userId` is the CONSULTEE. So the room that appeared
 * was authored by the wrong person, carried no `consultantUserId` / `hostUserIds`
 * (which is exactly what `useSessionInfo()` reads to decide who may end the call),
 * had no `starts_at`, no roster, and no `max_duration_seconds` backstop — an
 * unbounded, unlisted, host-less billable room.
 *
 * The first test below is the shape of that failure end to end: the mint throws
 * AFTER the claim, provisioning then short-circuits on the row as designed, and a
 * consultee walks in first. The room it produces is asserted to be **byte-identical**
 * to the one normal provisioning produces from the same rows — which is the only
 * assertion that actually pins the fix, since anything less would still pass with
 * two payload builders that happened to agree today.
 *
 * ## Defect B1: join never reconciled the window, so a failed planner sync left a
 * stale hard stop
 *
 * `lib/meetings/sync-call-window.ts` re-stamps the call when the calendar moves,
 * once per planner save, and its own docstring claims "the next join repairs it".
 * It does not: provisioning short-circuits on an existing row, and the join route
 * ran a minimal `getOrCreate`, which applies nothing to a call that already
 * exists. So a 60-minute booking extended to four hours whose Stream update failed
 * kept a ~105-minute SFU cap indefinitely, and the SFU — not the application —
 * ended a paid consultation 135 minutes early, for everyone in it.
 *
 * The join-time repair therefore reads the window from the committed occurrence
 * row (the calendar itself) and pushes it with a MERGING `update`. "Merging" is
 * the load-bearing word: Stream REPLACES `custom` on update, so an update that
 * sends our keys alone would delete the host metadata and any operator-written
 * field. Tests 3 and 4 are that assertion.
 */

const mockGetAuthSession = jest.fn();
const mockGetSession = jest.fn();
const mockResolveMeetingAccess = jest.fn();
const mockUpsertUsersToStream = jest.fn();
const mockGetMaintenanceState = jest.fn();

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
}));

jest.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

jest.mock("../../lib/auth", () => ({
  auth: { api: { getSession: (...a: unknown[]) => mockGetAuthSession(...a) } },
}));

// `resolveSlotForCaller` reads the session through lib/auth-server, the join
// guard through lib/auth. Both must describe the SAME person, or the recovery
// would resolve a different identity than the mint would have.
jest.mock("../../lib/auth-server", () => ({
  getSession: (...a: unknown[]) => mockGetSession(...a),
}));

jest.mock("../../lib/auth-helpers", () => ({
  isPrivileged: (role?: string | null) => role === "ADMIN" || role === "STAFF",
}));

jest.mock("../../lib/maintenance", () => ({
  getMaintenanceState: (...a: unknown[]) => mockGetMaintenanceState(...a),
}));

jest.mock("../../actions/stream/chat/user.action", () => ({
  upsertUsersToStream: (...a: unknown[]) => mockUpsertUsersToStream(...a),
}));

jest.mock("../../lib/stream-logger", () => ({
  streamLogger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));

jest.mock("../../lib/meetings/access", () => ({
  resolveMeetingAccess: (...a: unknown[]) => mockResolveMeetingAccess(...a),
}));

/**
 * The Stream side, as a real registry of rooms rather than a set of loose spies.
 *
 * A spy can only prove that a method was called with something; a room can be
 * ASKED what it ended up holding. Every assertion below about "the room has no
 * host / no cap / lost a member" reads state off this registry, so the same
 * assertions would fail against a real Stream rather than passing against a
 * recorder that remembered the wrong shape.
 */
interface FakeRoom {
  id: string;
  createdById: string;
  startsAt: Date | null;
  custom: Record<string, unknown>;
  maxDurationSeconds: number | undefined;
  members: Map<string, string>;
  /** The exact `data` the create carried — compared payload-to-payload. */
  createData: Record<string, unknown> | null;
  /** Every `update` the room has received, in order. */
  updates: FakeUpdateRequest[];
}

let rooms = new Map<string, FakeRoom>();
/** Ordered log of provider work, so ordering can be asserted and not inferred. */
let log: string[] = [];
/** Set to make the NEXT getOrCreate fail the way Stream refusing a create does. */
let failNextCreate: Error | null = null;
/** Set to make the next `update` fail — the sync-call-window failure mode. */
let failNextUpdate: Error | null = null;

/** The subset of `UpdateCallRequest` this suite cares about. */
interface FakeUpdateRequest {
  custom?: Record<string, unknown>;
  settings_override?: { limits?: { max_duration_seconds?: number } };
  starts_at?: Date;
}

function shape(room: FakeRoom) {
  return {
    id: room.id,
    cid: `default:${room.id}`,
    created_by: { id: room.createdById },
    starts_at: room.startsAt ?? undefined,
    custom: room.custom,
    settings: { limits: { max_duration_seconds: room.maxDurationSeconds } },
    members: [...room.members.entries()].map(([user_id, role]) => ({
      user_id,
      role,
    })),
  };
}

jest.mock("../../lib/stream-client", () => ({
  isStreamConfigured: () => true,
  withStreamCircuitBreaker: <T>(fn: () => T | Promise<T>) => fn(),
  STREAM_QUOTA_RETRY_AFTER_SECONDS: 60,
  isStreamQuotaError: () => false,
  StreamUnavailableError: class StreamUnavailableError extends Error {
    constructor() {
      super("Stream is unavailable");
      this.name = "StreamUnavailableError";
    }
  },
  getStreamVideoClient: () => ({
    video: {
      call: (_type: string, id: string) => ({
        getOrCreate: async (request?: { data?: Record<string, unknown> }) => {
          log.push(`getOrCreate:${id}`);
          if (failNextCreate) {
            const failure = failNextCreate;
            failNextCreate = null;
            // Stream refused: NOTHING exists afterwards. The `Meeting` row is
            // already committed, which is the whole point of #C1.
            throw failure;
          }
          const existing = rooms.get(id);
          if (existing) {
            // Stream ignores `data` when the call is already there — the reason
            // a missing-attribute room cannot be healed by `getOrCreate`.
            return { created: false, call: shape(existing) };
          }
          const data = request?.data ?? {};
          const created: FakeRoom = {
            id,
            createdById: String(data.created_by_id ?? ""),
            startsAt: (data.starts_at as Date) ?? null,
            custom: { ...(data.custom as Record<string, unknown>) },
            maxDurationSeconds: (
              data.settings_override as
                | { limits?: { max_duration_seconds?: number } }
                | undefined
            )?.limits?.max_duration_seconds,
            members: new Map(
              (
                (data.members as { user_id: string; role?: string }[]) ?? []
              ).map((member) => [member.user_id, member.role ?? "user"]),
            ),
            createData: data,
            updates: [],
          };
          rooms.set(id, created);
          return { created: true, call: shape(created) };
        },
        get: async () => {
          log.push(`get:${id}`);
          const room = rooms.get(id);
          if (!room) throw new Error(`call ${id} does not exist`);
          return { call: shape(room) };
        },
        update: async (request?: FakeUpdateRequest) => {
          log.push(`update:${id}`);
          if (failNextUpdate) {
            const failure = failNextUpdate;
            failNextUpdate = null;
            throw failure;
          }
          const room = rooms.get(id);
          if (!room) throw new Error(`call ${id} does not exist`);
          room.updates.push(request ?? {});
          // Stream REPLACES custom rather than merging — that is the whole reason
          // the caller has to merge, and reproducing it here is what makes the
          // merge assertions meaningful.
          if (request?.custom) room.custom = { ...request.custom };
          const cap = request?.settings_override?.limits?.max_duration_seconds;
          if (cap !== undefined) room.maxDurationSeconds = cap;
          return { call: shape(room) };
        },
        updateCallMembers: async (request?: {
          update_members?: { user_id: string; role?: string }[];
          remove_members?: string[];
        }) => {
          log.push(`updateCallMembers:${id}`);
          const room = rooms.get(id);
          if (!room) throw new Error(`call ${id} does not exist`);
          for (const member of request?.update_members ?? []) {
            room.members.set(member.user_id, member.role ?? "user");
          }
          for (const userId of request?.remove_members ?? []) {
            room.members.delete(userId);
          }
          return { members: shape(room).members };
        },
      }),
    },
  }),
}));

// ---------------------------------------------------------------------------
// The database, as a fake with the two lookups this path performs.
// ---------------------------------------------------------------------------

interface SlotRow {
  id: string;
  appointmentId: string;
  startsAt: Date;
  endsAt: Date;
  isTentative: boolean;
  completionStatus: string;
  deletedAt: Date | null;
  user: { id: string }[];
}

interface MeetingRow {
  id: string;
  streamCallId: string;
  appointmentOccurrenceId: string;
}

let rows: SlotRow[] = [];
let meetings: MeetingRow[] = [];

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointmentOccurrence: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const row = rows.find((r) => r.id === where.id);
        if (!row) return null;
        // The plan graph both resolvers authorize against and read identity
        // from, with `participants` filtered to the caller — an empty array is
        // how the real query says "this caller does not participate" (#1554).
        const caller = callerOfFakeDb();
        const entitled = !!caller && row.user.some((u) => u.id === caller);
        return {
          ...row,
          appointment: entitled
            ? { ...currentAppointment(), participants: [{ id: "seat-caller" }] }
            : null,
        };
      },
    },
    appointmentParticipant: {
      findMany: async ({
        where,
      }: {
        where: { appointmentId: string; userId?: string };
      }) =>
        rows
          .filter((r) => r.appointmentId === where.appointmentId)
          .flatMap((r) => r.user)
          .filter((u) => !where.userId || u.id === where.userId)
          .map((u) => ({ user: { id: u.id, name: NAME_OF[u.id] ?? u.id } })),
    },
    appointment: {
      findUnique: async () => ({ organizationId: null }),
    },
    meeting: {
      // Answers both shapes the code looks a Meeting up by: the occurrence (the
      // mint's own lookup) and the row id (the recovery's claim read).
      findUnique: async ({
        where,
      }: {
        where: { id?: string; appointmentOccurrenceId?: string };
      }) => {
        const found =
          (where.id
            ? meetings.find((m) => m.id === where.id)
            : meetings.find(
                (m) =>
                  m.appointmentOccurrenceId === where.appointmentOccurrenceId,
              )) ?? null;
        if (!found) return null;
        const row = rows.find((r) => r.id === found.appointmentOccurrenceId);
        return {
          ...found,
          ...(row
            ? {
                endedAt: null,
                endedReason: null,
                occurrence: {
                  ...row,
                  appointment: currentAppointment(),
                },
              }
            : {}),
        };
      },
      create: async ({
        data,
      }: {
        data: {
          streamCallId: string;
          occurrence: { connect: { id: string } };
        };
      }) => {
        const created: MeetingRow = {
          id: `ms-${meetings.length + 1}`,
          streamCallId: data.streamCallId,
          appointmentOccurrenceId: data.occurrence.connect.id,
        };
        meetings.push(created);
        return created;
      },
    },
  },
}));

import { resolveMaxCallDurationSeconds } from "@/lib/meetings/duration-cap";
import {
  occurrenceIdFromRoomId,
  roomIdForOccurrence,
} from "@/lib/meetings/room-id";
import { syncCallWindowForOccurrence } from "@/lib/meetings/sync-call-window";
import { provisionAppointmentMeeting } from "@/actions/stream/meetings/meeting.action";
import { POST } from "../../app/api/meetings/[meetingId]/join/route";

const HOST = "user-consultant";
const GUEST = "user-consultee";
const STRANGER = "user-stranger";
const SLOT = "slot-A";
const CALL_ID = roomIdForOccurrence(SLOT);

const NAME_OF: Record<string, string> = {
  [HOST]: "Dr Ada",
  [GUEST]: "Grace",
  [STRANGER]: "Sam Stranger",
};

/** Who is calling, for the fake DB's entitlement answer. */
let currentCaller: string | null = null;
/** Set to make `resolveMeetingAccess` refuse, whatever the rows say. */
let accessGranted = true;

function currentAppointment() {
  return {
    appointmentType: "CONSULTATION",
    organizationId: null,
    participants: [],
    consultation: {
      status: "APPROVED",
      consultationPlan: {
        title: "Career strategy deep dive",
        consultantProfile: {
          id: "cp-1",
          userId: HOST,
          user: { name: NAME_OF[HOST] },
        },
      },
    },
    subscription: null,
    webinar: null,
    class: null,
    trial: null,
  };
}

/**
 * The hoisted `jest.mock` factories cannot close over anything declared below
 * them, so the signed-in caller is read through this one global. Typed at the
 * point of use rather than with a cast on every read.
 */
const CALLER_GLOBAL = "__roomRecoveryTestCaller";
type CallerGlobal = typeof globalThis & { [CALLER_GLOBAL]?: string | null };
function callerOfFakeDb(): string | null {
  return (globalThis as CallerGlobal)[CALLER_GLOBAL] ?? null;
}
function setFakeDbCaller(userId: string | null): void {
  (globalThis as CallerGlobal)[CALLER_GLOBAL] = userId;
}
setFakeDbCaller(null);

const at = (hhmm: string) => new Date(`2026-08-01T${hhmm}:00.000Z`);

/** A confirmed one-hour consultation with a live seat for both sides. */
function seed(hours = 1) {
  const startsAt = at("10:00");
  const endsAt = new Date(startsAt.getTime() + hours * 60 * 60 * 1000);
  rows = [
    {
      id: SLOT,
      appointmentId: "appt-1",
      startsAt,
      endsAt,
      isTentative: false,
      completionStatus: "SCHEDULED",
      deletedAt: null,
      user: [{ id: HOST }, { id: GUEST }],
    },
  ];
}

function reset(hours = 1) {
  rooms = new Map();
  meetings = [];
  log = [];
  failNextCreate = null;
  failNextUpdate = null;
  accessGranted = true;
  currentCaller = GUEST;
  setFakeDbCaller(GUEST);
  seed(hours);
  jest.clearAllMocks();

  signIn(currentCaller!);
  mockGetMaintenanceState.mockResolvedValue({ phase: "OFF" });
  mockUpsertUsersToStream.mockImplementation(async (ids: string[]) => {
    log.push("syncUsers");
    return { users: Object.fromEntries(ids.map((id) => [id, {}])) };
  });
  // The real resolver, so a refusal here is a real refusal rather than a fixture
  // asserting one.
  mockResolveMeetingAccess.mockImplementation(async (callId: string) => {
    // #C9 — the real resolver falls back to the durable occurrence id, which is
    // why a URL minted before a #1607 rebuild still resolves.
    const row =
      meetings.find((m) => m.streamCallId === callId) ??
      meetings.find(
        (m) => m.appointmentOccurrenceId === occurrenceIdFromRoomId(callId),
      );
    if (!row) {
      return {
        hasAccess: false,
        role: null,
        message: "Meeting not found",
        reason: "not_found",
      };
    }
    if (!accessGranted) {
      return {
        hasAccess: false,
        role: null,
        message: "You are not authorized to join this meeting",
        reason: "unauthorized",
      };
    }
    return {
      hasAccess: true,
      role: "participant",
      message: "Access granted as participant",
      reason: "granted",
      streamCallId: row.streamCallId,
      meetingId: row.id,
    };
  });
}

const slot = () => ({
  id: SLOT,
  appointmentId: "appt-1",
  startsAt: at("10:00"),
  endsAt: new Date(at("10:00").getTime() + 60 * 60 * 1000),
  isTentative: false,
});

/**
 * Both session readers describe the SAME person, because the route reads one and
 * the payload resolver reads the other — a fixture where they disagree would let
 * a recovery resolve a different identity than the mint would have.
 */
function signIn(userId: string, role = "CONSULTEE") {
  currentCaller = userId;
  setFakeDbCaller(userId);
  mockGetAuthSession.mockResolvedValue({
    user: { id: userId, banned: false },
  });
  mockGetSession.mockResolvedValue({
    user: {
      id: userId,
      consultantProfileId: null,
      role,
      banned: false,
    },
  });
}

/** Post to the join route the way the meeting screen does: with the CALL id. */
function joinAs(userId: string, role = "CONSULTEE") {
  signIn(userId, role);
  return POST({} as never, {
    params: Promise.resolve({ meetingId: CALL_ID }),
  });
}

/**
 * Provision once, successfully, and hand back the room it produced. The control
 * arm of the payload comparison — the thing recovery has to reproduce.
 */
async function provisionHealthyRoom(hours = 1) {
  reset(hours);
  const result = await provisionAppointmentMeeting(slot());
  expect(result).toEqual({ ok: true, streamCallId: CALL_ID });
  // Wiped so every assertion below reads only what the JOIN did.
  log.length = 0;
  jest.clearAllMocks();
  return rooms.get(CALL_ID)!;
}

describe("#1829 A — a failed first mint recovers the FULL authoritative payload", () => {
  it("gives a consultee-first recovery byte-identical data to normal provisioning", async () => {
    // Control: nothing is wrong, and the room provisioning builds is recorded.
    const control = await provisionHealthyRoom();
    const normalPayload = control.createData!;

    // Now the same booking, same rows, same slot id — but the provider mint
    // fails AFTER the row committed. That is the normal consequence of #C1.
    reset();
    failNextCreate = new Error("Stream refused to create the call");
    await expect(provisionAppointmentMeeting(slot())).rejects.toThrow(
      /Failed to create meeting session/,
    );
    // The claim survives, and no room exists — the state every retry inherits.
    expect(meetings).toHaveLength(1);
    expect(meetings[0].streamCallId).toBe(CALL_ID);
    expect(rooms.has(CALL_ID)).toBe(false);

    // The retry short-circuits on the row, as #C1 intends, and mints nothing.
    const retry = await provisionAppointmentMeeting(slot());
    expect(retry).toEqual({ ok: true, streamCallId: CALL_ID });
    expect(rooms.has(CALL_ID)).toBe(false);

    // The consultee arrives first and materialises the room.
    const res = await joinAs(GUEST);
    expect(res.status).toBe(200);

    const recovered = rooms.get(CALL_ID)!;
    // THE assertion. Not "has a host" — the identical payload, so the two entry
    // points cannot describe one room differently.
    expect(recovered.createData).toEqual(normalPayload);
    expect(recovered.custom).toEqual(control.custom);
    expect(recovered.maxDurationSeconds).toBe(control.maxDurationSeconds);
    expect([...recovered.members.entries()].sort()).toEqual(
      [...control.members.entries()].sort(),
    );

    // Spelled out, because the failure it prevents is invisible otherwise: the
    // author is the HOST, not the consultee who happened to walk in first.
    expect(recovered.createdById).toBe(HOST);
    expect(recovered.custom.consultantUserId).toBe(HOST);
    expect(recovered.custom.hostUserIds).toEqual([HOST]);
    expect(recovered.custom.consulteeUserId).toBe(GUEST);
    expect(recovered.custom.slotId).toBe(SLOT);
    expect(recovered.custom.sessionStartsAt).toBe(at("10:00").toISOString());
    expect(recovered.custom.sessionDurationMinutes).toBe(60);
    // #1280 — the SFU bound, absent from the minimal payload entirely.
    expect(recovered.maxDurationSeconds).toBe(
      resolveMaxCallDurationSeconds({ endsAt: at("11:00") }, at("10:00")),
    );
  });

  it("syncs every id the payload names BEFORE the create that names them", async () => {
    await provisionHealthyRoom();
    reset();
    failNextCreate = new Error("Stream refused to create the call");
    await expect(provisionAppointmentMeeting(slot())).rejects.toThrow();
    log.length = 0;

    await joinAs(GUEST);

    // Stream rejects the whole create when it names a user it does not hold, so
    // the roster and the author have to exist first.
    expect(mockUpsertUsersToStream).toHaveBeenCalled();
    expect(log.indexOf("syncUsers")).toBeLessThan(
      log.indexOf(`getOrCreate:${CALL_ID}`),
    );
    expect(mockUpsertUsersToStream.mock.calls[0][0].sort()).toEqual(
      [HOST, GUEST].sort(),
    );
  });

  it("names the host as author even when the HOST is the one recovering", async () => {
    reset();
    failNextCreate = new Error("Stream refused to create the call");
    await expect(provisionAppointmentMeeting(slot())).rejects.toThrow();

    await joinAs(HOST);

    expect(rooms.get(CALL_ID)!.createdById).toBe(HOST);
  });

  it("preserves the claimed room id rather than minting a different one", async () => {
    const control = await provisionHealthyRoom();
    // #1607: the host closed the room before the start, so the row was rebound
    // onto a fresh, suffixed id and the call under it does not exist yet. The URL
    // still carries the pre-rebuild id, and recovery has to land on the ROW's
    // room — deriving a new id here would leave the row pointing at nothing.
    const rebuiltId = `${CALL_ID}-rrk3n0nv`;
    meetings[0].streamCallId = rebuiltId;
    rooms.delete(CALL_ID);
    log.length = 0;

    const res = await joinAs(GUEST);

    expect(res.status).toBe(200);
    expect((await res.json()).callId).toBe(rebuiltId);
    expect(rooms.has(rebuiltId)).toBe(true);
    expect(rooms.has(CALL_ID)).toBe(false);
    // …and it is the same payload the pre-rebuild mint would have sent.
    const rebuilt = rooms.get(rebuiltId)!;
    expect({ ...rebuilt.createData, starts_at: undefined }).toEqual({
      ...control.createData,
      starts_at: undefined,
    });
  });
});

describe("#1829 A — an unauthorized caller can neither create nor repair", () => {
  it("refuses before touching Stream, with no room created and none repaired", async () => {
    await provisionHealthyRoom();
    const before = rooms.get(CALL_ID)!;
    const updateCount = before.updates.length;

    // A room that is missing everything is the most tempting thing to repair.
    before.custom = {};
    before.maxDurationSeconds = undefined;
    accessGranted = false;

    const res = await joinAs(STRANGER);

    expect(res.status).toBe(403);
    // Not one provider call: the guard answers before anything is created AND
    // before anything is repaired.
    expect(log).toEqual([]);
    expect(mockUpsertUsersToStream).not.toHaveBeenCalled();
    // The room was neither written to nor removed.
    expect(rooms.get(CALL_ID)!.updates).toHaveLength(updateCount);
    expect(rooms.get(CALL_ID)!.custom).toEqual({});
  });

  it("refuses to CREATE a room for a caller with no claim on it", async () => {
    reset();
    // No Meeting row, and a signed-in stranger who holds no seat and owns no
    // plan. Entitlement is evaluated before anything is minted, so the refusal
    // costs no provider call.
    signIn(STRANGER);
    log.length = 0;

    await expect(provisionAppointmentMeeting(slot())).resolves.toEqual({
      ok: false,
      refusal: "You are not a participant in this session.",
    });
    expect(rooms.size).toBe(0);
    expect(log).toEqual([]);
  });

  it("lets a caller repair nothing when the entitlement gate itself refuses", async () => {
    // Signed in, holding no seat and owning no plan: the DB-level gate that both
    // entry points authorize against, with the row itself still present.
    await provisionHealthyRoom();
    const row = rows[0];
    rows = [{ ...row, user: [{ id: HOST }] }];
    setFakeDbCaller(STRANGER);
    accessGranted = true;

    // The gate refuses, so the route's own payload resolution is null and the
    // room is neither created nor reconciled — but membership is still granted,
    // because `resolveMeetingAccess` is the route's authority and it said yes.
    // What must never happen is a HOST-less create or a wiped room.
    const res = await joinAs(STRANGER);

    expect(res.status).toBe(200);
    expect(rooms.get(CALL_ID)!.custom.consultantUserId).toBe(HOST);
  });
});

describe("#1829 A — an existing room is reconciled, never clobbered", () => {
  it("keeps host metadata, unrelated fields and members intact", async () => {
    await provisionHealthyRoom();
    const room = rooms.get(CALL_ID)!;
    // A room as an older build (or an operator) left it: right host, one extra
    // field we know nothing about, plus a member nobody in this booking is.
    room.custom = {
      ...room.custom,
      vendorOperationalFlag: "keep-me",
    };
    room.members.set("user-cohost", "call_member");
    room.updates.length = 0;

    const res = await joinAs(GUEST);

    expect(res.status).toBe(200);
    const after = rooms.get(CALL_ID)!;
    // Stream replaces `custom`, so this only holds if the repair MERGED.
    expect(after.custom.vendorOperationalFlag).toBe("keep-me");
    expect(after.custom.consultantUserId).toBe(HOST);
    expect(after.custom.hostUserIds).toEqual([HOST]);
    expect([...after.members.keys()].sort()).toEqual([
      "user-cohost",
      HOST,
      GUEST,
    ]);
    // The room already agreed with us, so nothing was written to it at all.
    expect(after.updates).toEqual([]);
  });

  it("fills in only what is missing, and writes nothing when nothing is", async () => {
    await provisionHealthyRoom();
    const room = rooms.get(CALL_ID)!;
    delete room.custom.consultantUserId;
    delete room.custom.hostUserIds;
    room.updates.length = 0;

    await joinAs(GUEST);

    expect(rooms.get(CALL_ID)!.custom.consultantUserId).toBe(HOST);
    expect(rooms.get(CALL_ID)!.updates).toHaveLength(1);
    // The keys it did not own are still there.
    expect(rooms.get(CALL_ID)!.custom.slotId).toBe(SLOT);
    expect(rooms.get(CALL_ID)!.custom.appointmentType).toBe("CONSULTATION");
  });
});

describe("#1829 B1 — join heals a duration cap whose planner sync failed", () => {
  it("re-stamps the window on the next join, preserving host data and members", async () => {
    const room = await provisionHealthyRoom();
    const staleCap = room.maxDurationSeconds!;
    // 60 booked minutes + the 15-minute consultant window + the 30-minute rejoin
    // grace is 105 minutes, and `resolveMaxCallDurationSeconds` then raises it to
    // its TWO-HOUR floor — a cap shorter than the room can run is the failure
    // mode that floor exists to prevent.
    expect(staleCap).toBe(2 * 60 * 60);

    // The booking is extended to four hours, and the planner's Stream update
    // FAILS. That leaves exactly the state `syncCallWindowForOccurrence`'s
    // `stream_error` leaves behind: the row says four hours, the SFU says 105
    // minutes, and the old cap would end the call 135 minutes early.
    rows[0].endsAt = new Date(at("10:00").getTime() + 4 * 60 * 60 * 1000);
    failNextUpdate = new Error("Stream is unreachable");
    const synced = await syncCallWindowForOccurrence({
      id: SLOT,
      startsAt: rows[0].startsAt,
      endsAt: rows[0].endsAt,
    });
    expect(synced.updated).toBe(false);
    expect(rooms.get(CALL_ID)!.maxDurationSeconds).toBe(staleCap);
    expect(rooms.get(CALL_ID)!.custom.sessionEndsAt).toBe(
      at("11:00").toISOString(),
    );

    // The heal: the next person to walk in.
    const res = await joinAs(GUEST);

    expect(res.status).toBe(200);
    const healed = rooms.get(CALL_ID)!;
    expect(healed.maxDurationSeconds).toBe(
      resolveMaxCallDurationSeconds(
        { endsAt: new Date(at("10:00").getTime() + 4 * 60 * 60 * 1000) },
        at("10:00"),
      ),
    );
    expect(healed.custom.sessionEndsAt).toBe(
      new Date(at("10:00").getTime() + 4 * 60 * 60 * 1000).toISOString(),
    );
    expect(healed.custom.sessionDurationMinutes).toBe(240);
    // And the merge held: the host fields the UI reads are still readable, and
    // nobody was dropped from the room.
    expect(healed.custom.consultantUserId).toBe(HOST);
    expect(healed.custom.hostUserIds).toEqual([HOST]);
    expect([...healed.members.keys()].sort()).toEqual([HOST, GUEST].sort());
  });

  it("heals for the host too, not only for a consultee", async () => {
    await provisionHealthyRoom();
    rows[0].endsAt = new Date(at("10:00").getTime() + 4 * 60 * 60 * 1000);

    await joinAs(HOST, "CONSULTANT");

    expect(rooms.get(CALL_ID)!.maxDurationSeconds).toBeGreaterThan(2 * 60 * 60);
  });

  it("reports a failed join-time repair as a failure, not as an admission", async () => {
    await provisionHealthyRoom();
    rows[0].endsAt = new Date(at("10:00").getTime() + 4 * 60 * 60 * 1000);
    failNextUpdate = new Error("Stream rejected the update");

    const res = await joinAs(GUEST);

    // The whole point of B1's honesty requirement: a stale cap is the one thing
    // that ends a paid session with no application involved, so a repair that did
    // not land must not be reported as a successful join — and must not have
    // made anybody a member of the room.
    expect(res.status).not.toBe(200);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({
      error: expect.stringMatching(/could not join/i),
    });
    expect(log).not.toContain(`updateCallMembers:${CALL_ID}`);
    expect(rooms.get(CALL_ID)!.maxDurationSeconds).toBe(2 * 60 * 60);
  });

  it("still grants membership when the repair was unnecessary", async () => {
    await provisionHealthyRoom();
    log.length = 0;

    const res = await joinAs(GUEST);

    expect(res.status).toBe(200);
    expect(log).toContain(`updateCallMembers:${CALL_ID}`);
    expect(rooms.get(CALL_ID)!.members.get(GUEST)).toBe("call_member");
  });
});
