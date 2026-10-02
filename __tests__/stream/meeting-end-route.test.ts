/**
 * @jest-environment node
 */

/**
 * #1270 — POST /api/meetings/[meetingId]/end.
 *
 * `end-call` is granted to `call_member` on the live `default` call type, and
 * the join route hands `call_member` to every participant. So `call.endCall()`
 * from a consultee's devtools ended the consultation for everyone; the only
 * barrier was `EndCallButton` not rendering for them, which is a React
 * conditional over call data.
 *
 * What matters here is the negative case. A route that ends the call for a
 * participant is the bug with extra steps, so the assertion is that Stream is
 * not touched at all unless the caller resolves as the hosting side.
 */

const mockGetSession = jest.fn();
const mockResolveMeetingAccess = jest.fn();
const mockMeetingFindUnique = jest.fn();
const mockEnd = jest.fn();
const mockVideoCall = jest.fn();

// jest.mock is hoisted above every `const`, so the logger is reached through
// the lazy form. `mockStreamLogger.error` is asserted directly: a row the guard
// just granted access for disappearing is worth a line in the log.
const mockStreamLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

jest.mock("../../lib/auth", () => ({
  auth: { api: { getSession: (...a: unknown[]) => mockGetSession(...a) } },
}));

jest.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

jest.mock("../../lib/meetings/access", () => ({
  resolveMeetingAccess: (...a: unknown[]) => mockResolveMeetingAccess(...a),
}));

// The route reads the row's call type before it addresses the vendor. Added with
// the two-call-type change (#1134 P1-5): addressing `STREAM_CALL_TYPE`
// unconditionally is a 404 for a webinar once those are minted on `livestream`,
// and a 404 here is a silent failure — the room stays open, the host sees an
// error, and nothing pages.
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    meeting: { findUnique: (...a: unknown[]) => mockMeetingFindUnique(...a) },
  },
}));

// Same shape as the join gate's: the error class has to be built inside the
// factory (jest.mock is hoisted above every const) and read back below, or the
// route's `instanceof` will not match what the test throws.
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
      // #1270 review — the arguments are the assertion. This used to discard
      // them, so the route could have ended `slot-abc` instead of the id the
      // Meeting actually points at and every test still passed.
      call: (...a: unknown[]) => {
        mockVideoCall(...a);
        return { end: (...b: unknown[]) => mockEnd(...b) };
      },
    },
  })),
}));

jest.mock("../../lib/stream-logger", () => ({
  streamLogger: {
    info: (...a: unknown[]) => mockStreamLogger.info(...a),
    warn: (...a: unknown[]) => mockStreamLogger.warn(...a),
    error: (...a: unknown[]) => mockStreamLogger.error(...a),
    debug: (...a: unknown[]) => mockStreamLogger.debug(...a),
  },
}));

jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));

import { POST } from "../../app/api/meetings/[meetingId]/end/route";
import { StreamUnavailableError } from "../../lib/stream-client";

const params = Promise.resolve({ meetingId: "slot-abc" });
const req = {} as never;

/** What resolveMeetingAccess hands back for a caller who may be in the room. */
const granted = (role: "host" | "participant") => ({
  hasAccess: true,
  role,
  message: `Access granted as ${role}`,
  reason: "granted",
  streamCallId: "slot-abc",
  meetingId: "ms-1",
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSession.mockResolvedValue({ user: { id: "user_1", banned: false } });
  mockResolveMeetingAccess.mockResolvedValue(granted("host"));
  mockMeetingFindUnique.mockResolvedValue({ callType: "default" });
  mockEnd.mockResolvedValue({});
});

describe("POST /api/meetings/[meetingId]/end", () => {
  it("ends the call for a host", async () => {
    const res = await POST(req, { params });

    expect(res.status).toBe(200);
    expect(mockEnd).toHaveBeenCalledTimes(1);
  });

  it("refuses a participant, and ends nothing", async () => {
    // The whole point of the route. Being allowed IN is not being allowed to
    // close the room on everyone else.
    mockResolveMeetingAccess.mockResolvedValue(granted("participant"));

    const res = await POST(req, { params });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: "not_host" });
    expect(mockEnd).not.toHaveBeenCalled();
  });

  it("refuses someone who is not on the appointment at all", async () => {
    mockResolveMeetingAccess.mockResolvedValue({
      hasAccess: false,
      role: null,
      message: "You are not authorized to join this meeting",
      reason: "unauthorized",
    });

    const res = await POST(req, { params });

    expect(res.status).toBe(403);
    expect(mockEnd).not.toHaveBeenCalled();
  });

  it("404s a meeting that does not exist", async () => {
    mockResolveMeetingAccess.mockResolvedValue({
      hasAccess: false,
      role: null,
      message: "Meeting not found",
      reason: "not_found",
    });

    const res = await POST(req, { params });

    expect(res.status).toBe(404);
    expect(mockEnd).not.toHaveBeenCalled();
  });

  it("refuses a suspended host before resolving anything", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "user_1", banned: true } });

    const res = await POST(req, { params });

    expect(res.status).toBe(403);
    expect(mockResolveMeetingAccess).not.toHaveBeenCalled();
    expect(mockEnd).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated caller", async () => {
    mockGetSession.mockResolvedValue(null);

    const res = await POST(req, { params });

    expect(res.status).toBe(401);
    expect(mockEnd).not.toHaveBeenCalled();
  });

  it("ends the call Stream knows about, not the id in the URL", async () => {
    // The route param is the id the browser had; `streamCallId` is what the
    // Meeting row actually points at, and legacy rows carry opaque ids
    // that are not `occurrence-<occurrenceId>` at all.
    mockResolveMeetingAccess.mockResolvedValue({
      ...granted("host"),
      streamCallId: "legacy-uuid",
    });

    const res = await POST(req, { params });

    expect(res.status).toBe(200);
    expect(mockEnd).toHaveBeenCalledTimes(1);
    // The whole point of the test: the id came from the session row, not the
    // route param. `params` resolves to `slot-abc`.
    expect(mockVideoCall).toHaveBeenCalledWith("default", "legacy-uuid");
  });

  it("addresses the call on the type the row recorded", async () => {
    // A webinar's room exists on `livestream:` and Stream answers a call it
    // does not hold with a 404, so `default:` here would leave the broadcast
    // running with no way for anyone to close it.
    mockResolveMeetingAccess.mockResolvedValue({
      ...granted("host"),
      streamCallId: "occurrence-ls-1",
    });
    mockMeetingFindUnique.mockResolvedValue({ callType: "livestream" });

    const res = await POST(req, { params });

    expect(res.status).toBe(200);
    expect(mockVideoCall).toHaveBeenCalledWith("livestream", "occurrence-ls-1");
  });

  it("reads the row by its own id, not the URL segment", async () => {
    // #C8 / #C9: after a #1607 rebuild the segment and the row disagree, and
    // `access.meetingId` is the row itself.
    mockResolveMeetingAccess.mockResolvedValue({
      ...granted("host"),
      meetingId: "ms-1",
    });

    await POST(req, { params });

    expect(mockMeetingFindUnique).toHaveBeenCalledWith({
      where: { id: "ms-1" },
      select: { callType: true },
    });
  });

  it("falls back to `default` for a row it cannot type", async () => {
    // A missing row means a Meeting the guard just granted access for is gone.
    // The conservative type is the right answer — it is the type every call
    // before the cutover is on — and the disappearance is logged rather than
    // swallowed.
    mockMeetingFindUnique.mockResolvedValue(null);

    const res = await POST(req, { params });

    expect(res.status).toBe(200);
    expect(mockVideoCall).toHaveBeenCalledWith("default", "slot-abc");
    expect(mockStreamLogger.error).toHaveBeenCalled();
  });

  it("coerces a call type this app does not own inward", async () => {
    // #1285's shape: a hand-edited column must not be able to point this at a
    // call type we never minted on.
    mockMeetingFindUnique.mockResolvedValue({ callType: "audio_room" });

    const res = await POST(req, { params });

    expect(res.status).toBe(200);
    expect(mockVideoCall).toHaveBeenCalledWith("default", "slot-abc");
  });

  it("does not read the type out of the call id", async () => {
    // `Meeting.streamCallId` is stored BARE and carries no type, so a cid read
    // would answer `default` for every row and quietly reproduce the bug this
    // column removes.
    mockResolveMeetingAccess.mockResolvedValue({
      ...granted("host"),
      streamCallId: "livestream:occurrence-ls-1",
    });
    mockMeetingFindUnique.mockResolvedValue({ callType: "default" });

    const res = await POST(req, { params });

    expect(res.status).toBe(200);
    expect(mockVideoCall).toHaveBeenCalledWith("default", "occurrence-ls-1");
  });

  it("reports a Stream outage as 503, not 500", async () => {
    mockEnd.mockRejectedValue(new StreamUnavailableError());

    const res = await POST(req, { params });

    expect(res.status).toBe(503);
  });

  it("still reports a genuine fault as 500", async () => {
    mockEnd.mockRejectedValue(new Error("boom"));

    const res = await POST(req, { params });

    expect(res.status).toBe(500);
  });
});
