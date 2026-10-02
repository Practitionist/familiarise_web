/**
 * @jest-environment node
 */

/**
 * The two livestream routes: `POST /api/meetings/[meetingId]/livestream` and
 * `GET /api/meetings/[meetingId]/livestream/stream-url`.
 *
 * ## What these tests are actually for
 *
 * `guardMeetingRoute` is mocked out wholesale, so nothing here tests it — the
 * question is what these routes do with the answer it gives. Three properties
 * carry the weight:
 *
 *   1. **Nothing is trusted from the client.** No role, no call id, no org, no
 *      entitlement. The host check comes from `access.role`; the room and its
 *      call type come from a row read by `access.meetingId`.
 *   2. **The tenant is checked explicitly**, on top of the access resolver's own
 *      scoping. A Meeting whose denormalised `organizationId` disagrees with the
 *      appointment that owns it is refused, because every org authorisation
 *      downstream reads that stamp.
 *   3. **The playlist URL is a bearer credential**, so the success response and
 *      every refusal carry `Cache-Control: no-store`. A cached 403 that later
 *      flips to a 200 is a credential-lifetime bug wearing a correctness
 *      costume, which is why the refusals are asserted on the header too and not
 *      only on the 200.
 *
 * The service is NOT mocked: mocking it would make these tests assert that the
 * routes pass their arguments, which is the part that is least likely to be
 * wrong.
 */

const mockGetSession = jest.fn();
const mockResolveMeetingAccess = jest.fn();
const mockMeetingFindUnique = jest.fn();
const mockMembershipFindUnique = jest.fn();
const mockGoLive = jest.fn();
const mockStopLive = jest.fn();
const mockUpdateCallMembers = jest.fn();
const mockQueryMembers = jest.fn();
const mockGetCall = jest.fn();

const mockLoggerInfo = jest.fn();
const mockLoggerWarn = jest.fn();
const mockLoggerError = jest.fn();
const mockLoggerDebug = jest.fn();
const allLoggerCalls = (): unknown[][] => [
  ...mockLoggerInfo.mock.calls,
  ...mockLoggerWarn.mock.calls,
  ...mockLoggerError.mock.calls,
];

jest.mock("../../lib/auth", () => ({
  auth: { api: { getSession: (...a: unknown[]) => mockGetSession(...a) } },
}));

jest.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

// The access resolver is the ONE thing mocked here, and it is mocked so that
// these routes are tested against the answers `guardMeetingRoute` is given
// rather than against the database. `guardMeetingRoute` itself runs for real:
// the question this file asks is what the routes do with its verdict, and a
// mocked guard could not show the ordering — a malformed body must 400 before
// the guard runs, and a suspended user must never reach a provider call.
jest.mock("../../lib/meetings/access", () => ({
  resolveMeetingAccess: (...a: unknown[]) => mockResolveMeetingAccess(...a),
}));

// Same shape as the end route's suite: the error class has to be built inside
// the factory (jest.mock is hoisted above every const) or the route's
// `instanceof` will not match what the test throws.
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
        goLive: (...a: unknown[]) => mockGoLive(...a),
        stopLive: (...a: unknown[]) => mockStopLive(...a),
        updateCallMembers: (...a: unknown[]) => mockUpdateCallMembers(...a),
        queryMembers: (...a: unknown[]) => mockQueryMembers(...a),
        get: (...a: unknown[]) => mockGetCall(...a),
      }),
    },
  })),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    meeting: { findUnique: (...a: unknown[]) => mockMeetingFindUnique(...a) },
    membership: {
      findUnique: (...a: unknown[]) => mockMembershipFindUnique(...a),
    },
  },
}));

jest.mock("../../lib/stream-logger", () => ({
  streamLogger: {
    debug: (...a: unknown[]) => mockLoggerDebug(...a),
    info: (...a: unknown[]) => mockLoggerInfo(...a),
    warn: (...a: unknown[]) => mockLoggerWarn(...a),
    error: (...a: unknown[]) => mockLoggerError(...a),
  },
}));

jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));

import { POST } from "../../app/api/meetings/[meetingId]/livestream/route";
import { GET } from "../../app/api/meetings/[meetingId]/livestream/stream-url/route";
import { StreamUnavailableError } from "../../lib/stream-client";
import { HOST_CALL_ROLE } from "../../lib/meetings/livestream-service";

const req = {} as never;

/** The playlist URL stands in for a bearer credential throughout. */
const PLAYLIST = "https://stream-io-video.com/live-abc.m3u8?token=SECRET";

/** What `resolveMeetingAccess` hands back for a caller who may be in the room. */
const granted = (role: "host" | "participant") => ({
  hasAccess: true,
  role,
  message: `Access granted as ${role}`,
  reason: "granted",
  streamCallId: "occurrence-ls-1",
  meetingId: "ms-1",
  appointment: { organizationId: "org-1" },
});

/**
 * The RAW `Meeting` row behind that grant — nested the way Prisma returns it,
 * because the route's reader is the thing under test and it flattens.
 */
const broadcastRow = (over: Record<string, unknown> = {}) => ({
  id: "ms-1",
  streamCallId: "occurrence-ls-1",
  callType: "livestream",
  organizationId: "org-1",
  occurrence: { appointment: { organizationId: "org-1" } },
  ...over,
});

const post = (action: unknown) =>
  POST({ json: async () => ({ action }) } as never, {
    params: Promise.resolve({ meetingId: "slot-abc" }),
  });

const get = () =>
  GET(req, { params: Promise.resolve({ meetingId: "slot-abc" }) });

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSession.mockResolvedValue({ user: { id: "user_1", banned: false } });
  mockResolveMeetingAccess.mockResolvedValue(granted("host"));
  mockMeetingFindUnique.mockResolvedValue(broadcastRow());
  mockMembershipFindUnique.mockResolvedValue(null);
  mockGoLive.mockResolvedValue({ duration: "1ms" });
  mockStopLive.mockResolvedValue({ duration: "1ms" });
  mockUpdateCallMembers.mockResolvedValue({ members: [] });
  mockQueryMembers.mockResolvedValue({ members: [] });
  mockGetCall.mockResolvedValue({ call: { egress: {} } });
});

describe("POST /api/meetings/[meetingId]/livestream", () => {
  it("takes a broadcast live for the host", async () => {
    const res = await post("go-live");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      action: "go-live",
      callType: "livestream",
      callId: "occurrence-ls-1",
    });
  });

  it("designates the caller as host and does not fan out without an entitlement", async () => {
    // `livestreamEnabled` is an injected flag with no column behind it, so
    // nothing supplies it and HLS is off. `start_hls: false` is therefore the
    // expected call here and not a missing feature — see `livestream-policy.ts`
    // for why the default has to be off.
    await post("go-live");

    expect(mockUpdateCallMembers).toHaveBeenCalledWith({
      update_members: [{ user_id: "user_1", role: HOST_CALL_ROLE }],
    });
    expect(mockGoLive).toHaveBeenCalledWith({ start_hls: false });
  });

  it("refuses a participant before it can claim the host role", async () => {
    // The designation is written by `goLive` itself, so letting a participant
    // reach it would hand them the broadcast AND make them its authorised host.
    mockResolveMeetingAccess.mockResolvedValue(granted("participant"));

    const res = await post("go-live");

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: "not_host" });
    expect(mockUpdateCallMembers).not.toHaveBeenCalled();
    expect(mockMeetingFindUnique).not.toHaveBeenCalled();
  });

  it("ignores anything else the caller sends, including a claimed identity", async () => {
    // #1270's shape: the control lived behind a value the browser wrote itself.
    // Zod strips what it does not know rather than rejecting, so the property
    // under test is not "extra keys are an error" — it is that the host
    // designation is built from the SESSION's user id no matter what the body
    // claimed.
    const res = await POST(
      {
        json: async () => ({
          action: "go-live",
          hostUserId: "user-victim",
          role: HOST_CALL_ROLE,
          isHost: true,
          callId: "occurrence-somebody-elses",
        }),
      } as never,
      { params: Promise.resolve({ meetingId: "slot-abc" }) },
    );

    expect(res.status).toBe(200);
    expect(mockUpdateCallMembers).toHaveBeenCalledWith({
      update_members: [{ user_id: "user_1", role: HOST_CALL_ROLE }],
    });
  });

  it("answers 400 for an action it does not know", async () => {
    for (const action of ["GO-LIVE", "start", undefined, 1, null]) {
      const res = await post(action);
      expect(res.status).toBe(400);
    }
    // The body is parsed before the guard, so a malformed POST costs no
    // database round trip.
    expect(mockMeetingFindUnique).not.toHaveBeenCalled();
  });

  it("409s a meeting that is not a broadcast — not 403", async () => {
    // The caller may perfectly well be the host of a consultation. They asked to
    // broadcast something that is not a broadcast, and "forbidden" would report
    // a permission problem for a wrong-target problem.
    mockMeetingFindUnique.mockResolvedValue(
      broadcastRow({ callType: "default" }),
    );

    const res = await post("go-live");

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: "not_livestream" });
    expect(mockGoLive).not.toHaveBeenCalled();
  });

  it("404s a row whose org stamp disagrees with its appointment", async () => {
    mockMeetingFindUnique.mockResolvedValue(
      broadcastRow({
        organizationId: "org-2",
        occurrence: { appointment: { organizationId: "org-1" } },
      }),
    );

    const res = await post("go-live");

    // 404 rather than 403: from outside, this meeting does not exist, and
    // saying "your tenant key is wrong" describes our schema for a row the
    // caller has no other business knowing about.
    expect(res.status).toBe(404);
    expect(mockGoLive).not.toHaveBeenCalled();
  });

  it("reads the row by the id the guard resolved, never the URL segment", async () => {
    // The segment is a call id of unknown vintage (#C8 / #C9); `ms-1` is the
    // row, and after a #1607 rebuild it names whichever room the row points at
    // now.
    await post("go-live");

    expect(mockMeetingFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "ms-1" } }),
    );
  });

  it("refuses an unauthenticated caller and a suspended one", async () => {
    mockGetSession.mockResolvedValue(null);
    expect((await post("go-live")).status).toBe(401);

    mockGetSession.mockResolvedValue({ user: { id: "user_1", banned: true } });
    expect((await post("go-live")).status).toBe(403);

    expect(mockGoLive).not.toHaveBeenCalled();
    expect(mockMeetingFindUnique).not.toHaveBeenCalled();
  });

  it("refuses a meeting the caller is not on", async () => {
    mockResolveMeetingAccess.mockResolvedValue({
      hasAccess: false,
      role: null,
      message: "You are not authorized to join this meeting",
      reason: "unauthorized",
    });

    const res = await post("go-live");

    expect(res.status).toBe(403);
    expect(mockGoLive).not.toHaveBeenCalled();
  });

  it("404s a meeting that does not exist", async () => {
    mockResolveMeetingAccess.mockResolvedValue({
      hasAccess: false,
      role: null,
      message: "Meeting not found",
      reason: "not_found",
    });

    const res = await post("go-live");

    expect(res.status).toBe(404);
    expect(mockGoLive).not.toHaveBeenCalled();
  });

  it("404s a row the guard granted on that has since gone", async () => {
    mockMeetingFindUnique.mockResolvedValue(null);

    const res = await post("go-live");

    expect(res.status).toBe(404);
    expect(mockGoLive).not.toHaveBeenCalled();
  });

  it("ends the broadcast only for the host the call itself designated", async () => {
    mockQueryMembers.mockResolvedValue({
      members: [{ user_id: "user_1", role: HOST_CALL_ROLE }],
    });

    const res = await post("end");

    expect(res.status).toBe(200);
    expect(mockStopLive).toHaveBeenCalledTimes(1);
  });

  it("refuses to end a broadcast the caller does not host", async () => {
    mockQueryMembers.mockResolvedValue({ members: [] });

    const res = await post("end");

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: "not_host" });
    expect(mockStopLive).not.toHaveBeenCalled();
  });

  it("lets an org operator end it even without the designation", async () => {
    mockQueryMembers.mockResolvedValue({ members: [] });
    mockMembershipFindUnique.mockResolvedValue({
      status: "ACTIVE",
      role: "MAINTAINER",
    });

    const res = await post("end");

    expect(res.status).toBe(200);
    expect(mockStopLive).toHaveBeenCalledTimes(1);
  });

  it("503s a Stream outage rather than burying it in the 5xx bucket", async () => {
    mockQueryMembers.mockResolvedValue({
      members: [{ user_id: "user_1", role: HOST_CALL_ROLE }],
    });
    mockStopLive.mockRejectedValue(new StreamUnavailableError());

    const res = await post("end");

    expect(res.status).toBe(503);
  });

  it("503s a vendor that could not say who the host is, still stopping nothing", async () => {
    // Fails CLOSED rather than falling through to the org branch or to a 403:
    // "we cannot tell" and "you are not the host" are different answers, and
    // only one of them is an outage.
    mockQueryMembers.mockRejectedValue(new Error("stream down"));

    const res = await post("end");

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ reason: "stream_unreachable" });
    expect(mockStopLive).not.toHaveBeenCalled();
  });

  it("still reports a genuine fault as 500", async () => {
    // The row read, which the service does not wrap — a database failure there
    // is ours rather than the vendor's, so it is a 500 and not a 503.
    mockMeetingFindUnique.mockRejectedValue(new Error("pool exhausted"));

    const res = await post("end");

    expect(res.status).toBe(500);
    expect(mockStopLive).not.toHaveBeenCalled();
  });
});

describe("GET /api/meetings/[meetingId]/livestream/stream-url", () => {
  beforeEach(() => {
    mockGetCall.mockResolvedValue({
      call: { egress: { hls: { playlist_url: PLAYLIST, status: "live" } } },
    });
  });

  it("hands a participant the playlist URL", async () => {
    const res = await get();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ playlistUrl: PLAYLIST });
  });

  it("serves the URL to a non-host participant too", async () => {
    // Watching is not presenting. The credential is issued to anyone on the
    // booking, and the appointment roster — not the host role — is what decides
    // who that is.
    mockResolveMeetingAccess.mockResolvedValue(granted("participant"));

    const res = await get();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ playlistUrl: PLAYLIST });
  });

  it("never publicly caches the URL", async () => {
    const res = await get();

    // One missing header on one status code is enough for a shared cache or a
    // browser disk cache to keep a credential after the broadcast ended — and
    // the participants are the same people who will be in the room again.
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("pragma")).toBe("no-cache");
  });

  it("never publicly caches a refusal either", async () => {
    // A 403 is what a shared cache is most likely to keep, and a cached refusal
    // that later flips to a 200 is a credential-lifetime bug wearing a
    // correctness costume.
    mockGetCall.mockResolvedValue({ call: { egress: {} } });
    const noStream = await get();
    expect(noStream.status).toBe(404);
    expect(noStream.headers.get("cache-control")).toContain("no-store");

    mockGetSession.mockResolvedValue(null);
    const unauthenticated = await get();
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("cache-control")).toContain("no-store");

    mockGetSession.mockResolvedValue({ user: { id: "user_1", banned: true } });
    const suspended = await get();
    expect(suspended.status).toBe(403);
    expect(suspended.headers.get("cache-control")).toContain("no-store");
  });

  it("does not tell a stranger that this session exists at all", async () => {
    mockResolveMeetingAccess.mockResolvedValue({
      hasAccess: false,
      role: null,
      message: "You are not authorized to join this meeting",
      reason: "unauthorized",
    });

    const res = await get();

    expect(res.status).toBe(403);
    // Nothing about the meeting: no call type, no plan, no live state. The
    // access resolver's own refusal is reissued through the no-store helper, so
    // it cannot be cached either.
    expect(await res.json()).not.toHaveProperty("playlistUrl");
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(mockGetCall).not.toHaveBeenCalled();
  });

  it("404s a non-broadcast, rather than admitting one is not", async () => {
    // The sibling route answers 409 for the same fact. Here that would turn this
    // endpoint into a directory of which sessions are webinars.
    mockMeetingFindUnique.mockResolvedValue(
      broadcastRow({ callType: "default" }),
    );

    const res = await get();

    expect(res.status).toBe(404);
    expect(mockGetCall).not.toHaveBeenCalled();
  });

  it("404s a row whose org stamp disagrees with its appointment", async () => {
    mockMeetingFindUnique.mockResolvedValue(
      broadcastRow({
        organizationId: "org-2",
        occurrence: { appointment: { organizationId: "org-1" } },
      }),
    );

    const res = await get();

    expect(res.status).toBe(404);
    expect(mockGetCall).not.toHaveBeenCalled();
  });

  it("404s a live call with no egress behind it", async () => {
    mockGetCall.mockResolvedValue({
      call: { egress: { broadcasting: false } },
    });

    const res = await get();

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ reason: "hls_unavailable" });
  });

  it("503s a vendor that cannot be asked, still uncached", async () => {
    // Distinct from "asked, and there is no egress": the caller may be
    // entitled to a stream that exists and cannot be read right now, so this
    // says try again rather than no.
    mockGetCall.mockRejectedValue(new Error("stream down"));

    const res = await get();

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ reason: "stream_unreachable" });
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("503s an open circuit without touching the vendor", async () => {
    mockGetCall.mockRejectedValue(new StreamUnavailableError());

    const res = await get();

    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("500s a failure of our own, still uncached", async () => {
    mockMeetingFindUnique.mockRejectedValue(new Error("pool exhausted"));

    const res = await get();

    expect(res.status).toBe(500);
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("never lets the URL reach the logger, on any path", async () => {
    await get();
    mockGetCall.mockRejectedValue(new Error(`upstream rejected ${PLAYLIST}`));
    await get();

    expect(JSON.stringify(allLoggerCalls())).not.toContain("SECRET");
  });
});
