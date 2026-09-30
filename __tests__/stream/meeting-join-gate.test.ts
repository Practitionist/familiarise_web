/**
 * @jest-environment node
 */

/**
 * #1134 P0-1/P0-2 — the join gate, and the regression that closing P0-2 opened.
 *
 * P0-2 removed the client-side `getOrCreate()` that used to run on a cache miss,
 * because it raced the access check: any signed-in visitor to `/meetings/<x>`
 * minted a billable Stream call and became its `created_by` before being shown
 * "Access Denied". Removing it was right. What it also removed was the only
 * thing repairing a `Meeting` row whose Stream call does not exist — and
 * rows like that are not hypothetical:
 *
 *   - the seeds write them with `faker.string.uuid()` ids and no Stream object
 *     at all (75–800 rows depending on size, no production guard)
 *   - `createDbMeeting` is a `"use server"` action whose id validator is
 *     `z.string().min(1)`, so any entitled caller can persist any string
 *   - maintenance drain ends the Stream call and keeps the row
 *
 * `lib/meeting.ts` skips its own `getOrCreate` whenever a row already exists, so
 * nothing else heals them. `resolveMeetingAccess` reads the row and says yes,
 * `updateCallMembers` throws on the missing call, and the user is told they have
 * access and then handed a 500.
 *
 * The fix is to create AFTER authorization instead of before it, which is the
 * ordering P0-2 was ever about. These tests pin that ordering, because a future
 * "tidy-up" that drops the `getOrCreate` reintroduces a silent 500 and a
 * "tidy-up" that moves it above `resolveMeetingAccess` reintroduces P0-2.
 */

const mockGetSession = jest.fn();
const mockResolveMeetingAccess = jest.fn();
const mockGetOrCreate = jest.fn();
const mockUpdateCallMembers = jest.fn();
const mockUpsertUsersToStream = jest.fn();

/** Ordered log of what the route did, so we can assert sequence, not just calls. */
let sequence: string[] = [];

jest.mock("../../lib/auth", () => ({
  auth: { api: { getSession: (...a: unknown[]) => mockGetSession(...a) } },
}));

jest.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

jest.mock("../../actions/stream/chat/user.action", () => ({
  upsertUsersToStream: (...a: unknown[]) => mockUpsertUsersToStream(...a),
}));

jest.mock("../../lib/meetings/access", () => ({
  resolveMeetingAccess: (...a: unknown[]) => {
    sequence.push("resolveMeetingAccess");
    return mockResolveMeetingAccess(...a);
  },
}));

// jest.mock is hoisted above every const in this file, so the class has to be
// built INSIDE the factory and read back off the mocked module below.
jest.mock("../../lib/stream-client", () => ({
  isStreamConfigured: jest.fn(() => true),
  StreamUnavailableError: class StreamUnavailableError extends Error {
    constructor() {
      super("Stream is unavailable");
      this.name = "StreamUnavailableError";
    }
  },
  withStreamCircuitBreaker: (fn: () => unknown) => fn(),
  // #1829 — the join door now classifies a Stream 429 and answers 503 +
  // Retry-After instead of reporting it to Sentry as a fault. Modelled as the
  // real shape: a thrown error with a 429 `status` on it, because the point of
  // the change is that the ROUTE can tell a quota from a fault, and a mock that
  // returned a boolean would assert nothing.
  isStreamQuotaError: (e: unknown) =>
    (e as { status?: number } | null)?.status === 429,
  STREAM_QUOTA_RETRY_AFTER_SECONDS: 60,
  getStreamVideoClient: jest.fn(() => ({
    video: {
      call: () => ({
        getOrCreate: (...a: unknown[]) => {
          sequence.push("getOrCreate");
          return mockGetOrCreate(...a);
        },
        updateCallMembers: (...a: unknown[]) => {
          sequence.push("updateCallMembers");
          return mockUpdateCallMembers(...a);
        },
      }),
    },
  })),
}));

jest.mock("../../lib/stream-logger", () => ({
  streamLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));

// Only the second half of this file uses it: the route never touches prisma,
// but the REAL resolveMeetingAccess — exercised below through requireActual —
// is nothing but database reads.
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    meeting: { findUnique: jest.fn() },
    user: { findUnique: jest.fn() },
    appointmentOccurrence: { findMany: jest.fn(), findFirst: jest.fn() },
    appointmentParticipant: { findFirst: jest.fn() },
    collaborator: { findFirst: jest.fn() },
  },
}));

import { POST } from "../../app/api/meetings/[meetingId]/join/route";
// The mocked class — `instanceof` in the route must match what we throw here.
import { StreamUnavailableError } from "../../lib/stream-client";

const params = Promise.resolve({ meetingId: "slot-abc" });
const req = {} as never;

beforeEach(() => {
  jest.clearAllMocks();
  sequence = [];
  mockGetSession.mockResolvedValue({
    user: { id: "user_1", banned: false },
  });
  mockResolveMeetingAccess.mockResolvedValue({
    hasAccess: true,
    role: "participant",
    message: "Access granted as participant",
    reason: "granted",
    streamCallId: "slot-abc",
  });
  mockGetOrCreate.mockResolvedValue({});
  mockUpdateCallMembers.mockResolvedValue({});
  mockUpsertUsersToStream.mockResolvedValue({ users: {} });
});

describe("POST /api/meetings/[meetingId]/join", () => {
  it("authorizes BEFORE it creates anything on Stream", async () => {
    await POST(req, { params });

    // This ordering is the whole of P0-2. Creation must never precede the check.
    expect(sequence).toEqual([
      "resolveMeetingAccess",
      "getOrCreate",
      "updateCallMembers",
    ]);
  });

  // #1270 — the regression this suite missed for 17 days. It asserted the
  // ORDER of the Stream calls but never their arguments, so a bare
  // `getOrCreate()` looked identical to a correct one. Server-side auth carries
  // no user context, so Stream rejects an authorless create on every request —
  // a total video outage that every existing assertion here still passed.
  it("names an author on getOrCreate, which server-side auth requires", async () => {
    await POST(req, { params });

    expect(mockGetOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ created_by_id: expect.any(String) }),
      }),
    );
  });

  it("syncs the caller to Stream before naming them as a member", async () => {
    await POST(req, { params });

    // Stream refuses an operation naming a user it does not hold, and a token
    // alone never creates one.
    expect(mockUpsertUsersToStream).toHaveBeenCalled();
    expect(mockUpsertUsersToStream.mock.invocationCallOrder[0]).toBeLessThan(
      mockUpdateCallMembers.mock.invocationCallOrder[0],
    );
  });

  it("creates the call before granting membership on it", async () => {
    await POST(req, { params });

    expect(sequence.indexOf("getOrCreate")).toBeLessThan(
      sequence.indexOf("updateCallMembers"),
    );
  });

  it("creates nothing at all when access is refused", async () => {
    mockResolveMeetingAccess.mockResolvedValue({
      hasAccess: false,
      role: null,
      message: "You are not authorized to join this meeting",
      reason: "unauthorized",
    });

    const res = await POST(req, { params });

    expect(res.status).toBe(403);
    expect(mockGetOrCreate).not.toHaveBeenCalled();
    expect(mockUpdateCallMembers).not.toHaveBeenCalled();
  });

  it("404s a meeting that does not exist, without creating it", async () => {
    mockResolveMeetingAccess.mockResolvedValue({
      hasAccess: false,
      role: null,
      message: "Meeting not found",
      reason: "not_found",
    });

    const res = await POST(req, { params });

    expect(res.status).toBe(404);
    expect(mockGetOrCreate).not.toHaveBeenCalled();
  });

  it("picks the status from `reason`, not from the message text", async () => {
    // Both routes used to compare `message` to the literal "Meeting not found",
    // so rewording a user-facing string silently turned a 404 into a 403 in two
    // places at once. A reworded message with the same reason must still 404.
    mockResolveMeetingAccess.mockResolvedValue({
      hasAccess: false,
      role: null,
      message: "We couldn't find that meeting.",
      reason: "not_found",
    });

    const res = await POST(req, { params });

    expect(res.status).toBe(404);
  });

  it("grants call_member — never `host`, which is not a role on this app", async () => {
    await POST(req, { params });

    expect(mockUpdateCallMembers).toHaveBeenCalledWith({
      update_members: [{ user_id: "user_1", role: "call_member" }],
    });
  });

  it("refuses a suspended account before touching Stream", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "user_1", banned: true } });

    const res = await POST(req, { params });

    expect(res.status).toBe(403);
    expect(sequence).toEqual([]);
  });

  it("reports a Stream outage as 503, not 500", async () => {
    // A provider outage is not our fault and not the caller's. 500 puts it in
    // the "we broke something" bucket and, worse, the client used to render any
    // non-ok response as "You are not authorized to join this meeting" — telling
    // a legitimate participant they had been refused when Stream was simply down.
    mockGetOrCreate.mockRejectedValue(new StreamUnavailableError());

    const res = await POST(req, { params });

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/temporarily unavailable/i);
    // No `reason` — that field marks an authorization verdict, and this is not one.
    expect(body.reason).toBeUndefined();
  });

  it("still reports a genuine fault as 500", async () => {
    mockGetOrCreate.mockRejectedValue(new Error("boom"));

    const res = await POST(req, { params });

    expect(res.status).toBe(500);
  });

  it("refuses an unauthenticated caller", async () => {
    mockGetSession.mockResolvedValue(null);

    const res = await POST(req, { params });

    expect(res.status).toBe(401);
    expect(sequence).toEqual([]);
  });
});

/**
 * #1270 — the SERVER-side status gate, exercised for real.
 *
 * `resolveMeetingAccess` refused three booking states — CANCELLED, REJECTED,
 * EXPIRED — while every dashboard's Join affordance is an allowlist of
 * {APPROVED, SCHEDULED, IN_PROGRESS}. Everything in neither set was hidden by
 * the UI and admitted by the server: PENDING, a DRAFT webinar, and above all
 * `APPROVED_PENDING_PAYMENT` and its trial twin `AWAITING_PAYMENT`. Typing
 * /meetings/<id> walked into a booking nobody had paid for. #1272 closed that in
 * the UI only.
 *
 * The route above mocks this module, so the real one is required directly here.
 */
const { resolveMeetingAccess } = jest.requireActual<
  typeof import("../../lib/meetings/access")
>("../../lib/meetings/access");

import prismaClient from "../../lib/prisma";

const db = prismaClient as unknown as {
  meeting: { findUnique: jest.Mock };
  user: { findUnique: jest.Mock };
  appointmentOccurrence: { findMany: jest.Mock; findFirst: jest.Mock };
  appointmentParticipant: { findFirst: jest.Mock };
  collaborator: { findFirst: jest.Mock };
};

const MINUTE = 60 * 1000;

/** A booking whose session is running right now, so only status can refuse it. */
function seedAccess(
  appointment: Record<string, unknown>,
  opts: { slotEndsInMs?: number; joinerIsParticipant?: boolean } = {},
) {
  const startsAt = new Date(Date.now() - 5 * MINUTE);
  const endsAt = new Date(Date.now() + (opts.slotEndsInMs ?? 25 * MINUTE));

  // #1554 — the gate evaluates the meeting's OWN occurrence, which the
  // resolver's include already carries; no separate occurrence read.
  db.meeting.findUnique.mockResolvedValue({
    id: "ms-1",
    streamCallId: "slot-abc",
    endedAt: null,
    endedReason: null,
    occurrence: {
      id: "slot-1",
      startsAt,
      endsAt,
      isTentative: false,
      completionStatus: "SCHEDULED",
      deletedAt: null,
      appointmentId: "appt-1",
      appointment: { id: "appt-1", deletedAt: null, ...appointment },
    },
  });
  // #1554 — the roster probe: a live seat for the joiner unless the case
  // says otherwise.
  db.appointmentParticipant.findFirst.mockResolvedValue(
    opts.joinerIsParticipant === false ? null : { id: "seat-1" },
  );
  db.appointmentOccurrence.findMany.mockResolvedValue([]);
  db.appointmentOccurrence.findFirst.mockResolvedValue(null);
  db.collaborator.findFirst.mockResolvedValue(null);
  db.user.findUnique.mockResolvedValue({ consultantProfileId: null });
}

const consultation = (status: string) => ({
  consultation: {
    status,
    consultationPlan: { consultantProfileId: "cp-1", recordingEnabled: false },
  },
  subscription: null,
  webinar: null,
  class: null,
  trial: null,
});

const trial = (status: string) => ({
  consultation: null,
  subscription: null,
  webinar: null,
  class: null,
  trial: { consultantProfileId: "cp-1", status },
});

const webinar = (status: string) => ({
  consultation: null,
  subscription: null,
  webinar: {
    status,
    webinarPlan: {
      id: "wp-1",
      consultantProfileId: "cp-1",
      recordingEnabled: false,
    },
  },
  class: null,
  trial: null,
});

describe("resolveMeetingAccess refuses a booking that is not joinable", () => {
  it("refuses a consultation whose payment has not landed", async () => {
    seedAccess(consultation("APPROVED_PENDING_PAYMENT"));

    const access = await resolveMeetingAccess("slot-abc", "user_1");

    expect(access.hasAccess).toBe(false);
    expect(access.message).toBe("This session is not confirmed yet.");
  });

  it("refuses a trial awaiting payment — the same hole, other enum", async () => {
    // AWAITING_PAYMENT used to collapse to null on the way into the check,
    // because only CANCELLED and REJECTED were mapped at all.
    seedAccess(trial("AWAITING_PAYMENT"));

    const access = await resolveMeetingAccess("slot-abc", "user_1");

    expect(access.hasAccess).toBe(false);
  });

  it("refuses a request the consultant has not accepted yet", async () => {
    seedAccess(consultation("PENDING"));

    expect((await resolveMeetingAccess("slot-abc", "user_1")).hasAccess).toBe(
      false,
    );
  });

  it("refuses an unpublished webinar", async () => {
    seedAccess(webinar("DRAFT"));

    expect((await resolveMeetingAccess("slot-abc", "user_1")).hasAccess).toBe(
      false,
    );
  });

  it("still says a cancelled booking is over rather than unconfirmed", async () => {
    seedAccess(consultation("CANCELLED"));

    const access = await resolveMeetingAccess("slot-abc", "user_1");

    expect(access.hasAccess).toBe(false);
    expect(access.message).toBe("This booking is no longer active.");
  });
});

describe("resolveMeetingAccess still admits a live session", () => {
  it("admits a paid consultation that is under way", async () => {
    seedAccess(consultation("APPROVED"));

    const access = await resolveMeetingAccess("slot-abc", "user_1");

    expect(access.hasAccess).toBe(true);
    expect(access.role).toBe("participant");
  });

  it("admits a scheduled trial", async () => {
    seedAccess(trial("SCHEDULED"));

    expect((await resolveMeetingAccess("slot-abc", "user_1")).hasAccess).toBe(
      true,
    );
  });

  it("admits a webinar that is in progress", async () => {
    seedAccess(webinar("IN_PROGRESS"));

    expect((await resolveMeetingAccess("slot-abc", "user_1")).hasAccess).toBe(
      true,
    );
  });

  it("admits a webinar attendee through the roster probe (#1554)", async () => {
    // Group events hang the meeting off the consultant's allocation row; the
    // attendee's seat is their AppointmentParticipant row, and one existence
    // probe on it answers for a 1:1 and a 200-attendee webinar alike.
    seedAccess(webinar("SCHEDULED"), { joinerIsParticipant: true });

    expect((await resolveMeetingAccess("slot-abc", "user_1")).hasAccess).toBe(
      true,
    );
    expect(db.appointmentParticipant.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          appointmentId: "appt-1",
          userId: "user_1",
          status: { in: ["HELD", "CONFIRMED", "ATTENDED"] },
        }),
      }),
    );
  });

  // #1580 C-P1-4 — host controls reach the co-presenter only; crew joins as
  // a participant and cannot end the call for everyone.
  it("admits an accepted co-presenter as a host", async () => {
    seedAccess(webinar("SCHEDULED"), { joinerIsParticipant: false });
    db.user.findUnique.mockResolvedValue({ consultantProfileId: "cp-collab" });
    db.collaborator.findFirst.mockResolvedValue({
      id: "collab-1",
      role: "CO_HOST",
    });

    const access = await resolveMeetingAccess("slot-abc", "user_1");

    expect(access.hasAccess).toBe(true);
    expect(access.role).toBe("host");
  });

  it("admits an accepted crew collaborator as a participant, not a host", async () => {
    seedAccess(webinar("SCHEDULED"), { joinerIsParticipant: false });
    db.user.findUnique.mockResolvedValue({ consultantProfileId: "cp-collab" });
    db.collaborator.findFirst.mockResolvedValue({
      id: "collab-1",
      role: "MODERATOR",
    });

    const access = await resolveMeetingAccess("slot-abc", "user_1");

    expect(access.hasAccess).toBe(true);
    expect(access.role).toBe("participant");
  });

  it("lets a disconnected participant back into a session that just completed", async () => {
    // The completion sweeps run on a timer, and the trial one has no buffer at
    // all — so a booking can read COMPLETED while its room is still occupied.
    // That is why completed-like statuses are handed to the time gate (which
    // allows a 30-minute reconnect grace) instead of being refused outright.
    seedAccess(consultation("COMPLETED"), { slotEndsInMs: -2 * MINUTE });

    expect((await resolveMeetingAccess("slot-abc", "user_1")).hasAccess).toBe(
      true,
    );
  });

  it("closes the room once the grace after a completed session is spent", async () => {
    seedAccess(consultation("COMPLETED"), { slotEndsInMs: -45 * MINUTE });

    const access = await resolveMeetingAccess("slot-abc", "user_1");

    expect(access.hasAccess).toBe(false);
    expect(access.message).toBe("This session has ended.");
  });

  it("gates on the meeting's OWN call, not the wrapper's next one (#1554)", async () => {
    // A subscription wrapper holds many calls. This room belongs to a call
    // that ended 45 minutes ago; the wrapper's next call is live right now.
    // Evaluating "the current or next occurrence" would admit the visitor
    // into the wrong room — the gate must read the meeting's occurrence.
    seedAccess(
      {
        ...consultation("APPROVED"),
        consultation: null,
        subscription: {
          status: "SCHEDULED",
          subscriptionPlan: {
            consultantProfileId: "cp-1",
            recordingEnabled: false,
          },
        },
      },
      { slotEndsInMs: -45 * MINUTE },
    );
    db.appointmentOccurrence.findMany.mockResolvedValue([
      {
        id: "slot-live",
        startsAt: new Date(Date.now() - 5 * MINUTE),
        endsAt: new Date(Date.now() + 25 * MINUTE),
        isTentative: false,
        completionStatus: "SCHEDULED",
        appointmentId: "appt-1",
        meeting: null,
      },
    ]);

    const access = await resolveMeetingAccess("slot-abc", "user_1");

    expect(access.hasAccess).toBe(false);
    expect(access.message).toBe("This session has ended.");
    // And nothing enumerated the wrapper's other calls to decide it.
    expect(db.appointmentOccurrence.findMany).not.toHaveBeenCalled();
  });
});

/**
 * #C8 / #C9 — one authority for the call id, and a URL that outlives its room.
 *
 * The route used to address the call with the RAW URL segment while the end route
 * used `toCallId(access.streamCallId)` from the row. Two authorities for one id
 * means a `default:`-prefixed URL 404s on join and works on end, and — the worse
 * half — a #1607 rebuild REBINDS `streamCallId` to `occurrence-<id>-r<suffix>`,
 * so every URL minted before it stops matching on the bare id. The person's tab
 * is still open in the room, `CallEnded`'s "Try to Rejoin" re-posts to the URL
 * they arrived on, and it resolves to nothing.
 *
 * The occurrence id is the durable key (`appointmentOccurrenceId` is `@unique` on
 * `Meeting`), so `loadMeeting` falls back to it. Note what is NOT being widened:
 * which ids resolve changes, WHO may resolve them does not — every refusal below
 * still applies, and the last test here is the one that would catch a regression
 * in which the fallback became a quieter way into a closed room.
 */
describe("the room id is resolved from the row, and survives a #1607 rebuild", () => {
  /** A row whose call has been rebuilt onto a suffixed id (#1607). */
  function seedRebuiltRoom() {
    seedAccess(consultation("APPROVED"));
    db.meeting.findUnique.mockImplementation(
      async ({
        where,
      }: {
        where: { streamCallId?: string; appointmentOccurrenceId?: string };
      }) => {
        // The bare id no longer names anything — the rebuild moved it.
        if (where.streamCallId) return null;
        if (where.appointmentOccurrenceId === "slot-1") {
          return {
            id: "ms-1",
            streamCallId: "occurrence-slot-1-rmunantmv",
            endedAt: null,
            endedReason: null,
            occurrence: {
              id: "slot-1",
              startsAt: new Date(Date.now() - 5 * MINUTE),
              endsAt: new Date(Date.now() + 25 * MINUTE),
              isTentative: false,
              completionStatus: "SCHEDULED",
              deletedAt: null,
              appointmentId: "appt-1",
              appointment: {
                id: "appt-1",
                deletedAt: null,
                ...consultation("APPROVED"),
              },
            },
          };
        }
        return null;
      },
    );
  }

  it("resolves an old `occurrence-<id>` URL to the row's CURRENT room", async () => {
    seedRebuiltRoom();

    const access = await resolveMeetingAccess("occurrence-slot-1", "user_1");

    expect(access.hasAccess).toBe(true);
    // The id handed to Stream is the rebuilt one, not the URL's — which is what
    // the join route now passes to `video.call()`.
    expect((access as { streamCallId: string }).streamCallId).toBe(
      "occurrence-slot-1-rmunantmv",
    );
  });

  it("still refuses a rebuilt room that is over", async () => {
    // The fallback widens WHICH ids resolve, never WHO may. A closed room stays
    // closed for the person holding an old link to it.
    seedRebuiltRoom();
    db.meeting.findUnique.mockImplementation(
      async ({
        where,
      }: {
        where: { streamCallId?: string; appointmentOccurrenceId?: string };
      }) => {
        if (where.streamCallId) return null;
        if (where.appointmentOccurrenceId !== "slot-1") return null;
        return {
          id: "ms-1",
          streamCallId: "occurrence-slot-1-rmunantmv",
          endedAt: new Date(Date.now() - 45 * MINUTE),
          endedReason: "call_ended",
          occurrence: {
            id: "slot-1",
            startsAt: new Date(Date.now() - 50 * MINUTE),
            endsAt: new Date(Date.now() - 45 * MINUTE),
            isTentative: false,
            completionStatus: "SCHEDULED",
            deletedAt: null,
            appointmentId: "appt-1",
            appointment: {
              id: "appt-1",
              deletedAt: null,
              ...consultation("APPROVED"),
            },
          },
        };
      },
    );

    const access = await resolveMeetingAccess("occurrence-slot-1", "user_1");

    expect(access.hasAccess).toBe(false);
    expect(access.message).toBe("This session has ended.");
  });

  it("answers not_found for an id that names no occurrence at all", async () => {
    seedAccess(consultation("APPROVED"));
    db.meeting.findUnique.mockResolvedValue(null);

    const access = await resolveMeetingAccess("some-other-id", "user_1");

    expect(access.hasAccess).toBe(false);
    // Only the two refusals carry an id; a miss does not leak that a session
    // exists under some other name.
    expect((access as { streamCallId?: string }).streamCallId).toBeUndefined();
  });

  it("normalises a `default:`-prefixed URL, the way the end route always has", async () => {
    // #C8 — the same bookmark that works on `/end` used to 404 on `/join`,
    // because this route split the id out of the URL segment and the other one
    // did not. `toCallId` is idempotent, so a bare id is unaffected.
    seedAccess(consultation("APPROVED"));
    const calls: unknown[] = [];
    db.meeting.findUnique.mockImplementation(
      async (args: { where: { streamCallId?: string } }) => {
        calls.push(args.where.streamCallId);
        return null;
      },
    );

    await resolveMeetingAccess("default:slot-abc", "user_1");

    expect(calls[0]).toBe("slot-abc");
  });
});

describe("POST /api/meetings/[meetingId]/join addresses the RESOLVED room (C8)", () => {
  it("joins the id the row names, and hands the client the same one", async () => {
    // A #1607 rebuild: the URL is the pre-rebuild id, the row has moved on. The
    // client builds its Call handle from the RESPONSE, so returning the URL's id
    // would have it resolve a room membership was never granted on.
    mockResolveMeetingAccess.mockResolvedValue({
      hasAccess: true,
      role: "participant",
      message: "Access granted as participant",
      reason: "granted",
      streamCallId: "occurrence-slot-abc-rmunantmv",
    });

    const res = await POST(req, {
      params: Promise.resolve({ meetingId: "occurrence-slot-abc" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      callType: "default",
      callId: "occurrence-slot-abc-rmunantmv",
    });
  });

  it("joins a `default:`-prefixed URL as a bare id", async () => {
    mockResolveMeetingAccess.mockResolvedValue({
      hasAccess: true,
      role: "participant",
      message: "Access granted as participant",
      reason: "granted",
      streamCallId: "slot-abc",
    });

    const res = await POST(req, {
      params: Promise.resolve({ meetingId: "default:slot-abc" }),
    });

    expect(res.status).toBe(200);
    // Never a cid: `client.call(type, id)` with a colon in the id mints a
    // different call than the one membership was granted on.
    expect((await res.json()).callId).toBe("slot-abc");
  });
});
