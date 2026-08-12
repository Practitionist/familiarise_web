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
 * thing repairing a `MeetingSession` row whose Stream call does not exist — and
 * rows like that are not hypothetical:
 *
 *   - the seeds write them with `faker.string.uuid()` ids and no Stream object
 *     at all (75–800 rows depending on size, no production guard)
 *   - `createDbMeetingSession` is a `"use server"` action whose id validator is
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

/** Ordered log of what the route did, so we can assert sequence, not just calls. */
let sequence: string[] = [];

jest.mock("../../lib/auth", () => ({
  auth: { api: { getSession: (...a: unknown[]) => mockGetSession(...a) } },
}));

jest.mock("next/headers", () => ({
  headers: async () => new Headers(),
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
