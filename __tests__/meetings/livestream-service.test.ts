/**
 * @jest-environment node
 */

/**
 * `lib/meetings/livestream-service.ts` — go-live, end-live, and the one
 * endpoint in the app that hands out a bearer credential.
 *
 * The assertions here are mostly NEGATIVE, and that is the shape of the risk.
 * `goLive` on a room that is not a broadcast is not an exception: Stream answers
 * go-live on any call it holds, so the SDK reports success and the presenter
 * watches a stage that never reaches the audience. `endLive` refusing is the
 * whole of #1270's fix, restated one level up. And `resolveHlsUrl` has a single
 * catastrophic failure mode — a playlist URL in a log line or a cache — which
 * produces no error at all, so the only way to pin it is to assert on what the
 * logger did NOT receive.
 */

const mockVideoCall = jest.fn();
const mockGoLive = jest.fn();
const mockStopLive = jest.fn();
const mockUpdateCallMembers = jest.fn();
const mockQueryMembers = jest.fn();
const mockGet = jest.fn();

/** Every provider method name, in call order. The ordering IS the assertion. */
const callOrder: string[] = [];

const mockMeetingFindUnique = jest.fn();
const mockMembershipFindUnique = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    meeting: { findUnique: (...a: unknown[]) => mockMeetingFindUnique(...a) },
    membership: {
      findUnique: (...a: unknown[]) => mockMembershipFindUnique(...a),
    },
  },
}));

jest.mock("../../lib/stream-client", () => ({
  getStreamVideoClient: () => ({
    video: {
      call: (...a: unknown[]) => {
        mockVideoCall(...a);
        return {
          goLive: (...b: unknown[]) => {
            callOrder.push("goLive");
            return mockGoLive(...b);
          },
          stopLive: (...b: unknown[]) => {
            callOrder.push("stopLive");
            return mockStopLive(...b);
          },
          updateCallMembers: (...b: unknown[]) => {
            callOrder.push("updateCallMembers");
            return mockUpdateCallMembers(...b);
          },
          queryMembers: (...b: unknown[]) => {
            callOrder.push("queryMembers");
            return mockQueryMembers(...b);
          },
          get: (...b: unknown[]) => {
            callOrder.push("get");
            return mockGet(...b);
          },
        };
      },
    },
  }),
  withStreamCircuitBreaker: <T>(fn: () => T | Promise<T>) => fn(),
}));

// jest.mock is hoisted above every `const`, so the factory may only reach these
// through the lazy `(...a) => mockFn(...a)` form. Collected into one array as
// well, because the assertions that matter are about what the logger did NOT
// receive across all four levels.
const mockLoggerDebug = jest.fn();
const mockLoggerInfo = jest.fn();
const mockLoggerWarn = jest.fn();
const mockLoggerError = jest.fn();
const allLoggerCalls = (): unknown[][] => [
  ...mockLoggerDebug.mock.calls,
  ...mockLoggerInfo.mock.calls,
  ...mockLoggerWarn.mock.calls,
  ...mockLoggerError.mock.calls,
];

jest.mock("../../lib/stream-logger", () => ({
  streamLogger: {
    debug: (...a: unknown[]) => mockLoggerDebug(...a),
    info: (...a: unknown[]) => mockLoggerInfo(...a),
    warn: (...a: unknown[]) => mockLoggerWarn(...a),
    error: (...a: unknown[]) => mockLoggerError(...a),
  },
}));

import {
  HOST_CALL_ROLE,
  assertSameOrganization,
  endLive,
  goLive,
  readLivestreamMeetingRow,
  resolveHlsUrl,
  type LivestreamMeetingRef,
  type LivestreamMeetingRow,
} from "../../lib/meetings/livestream-service";
import {
  LIVESTREAM_CALL_TYPE,
  STREAM_CALL_TYPE,
} from "../../lib/stream/call-cid";

/** The two arguments the last `client.video.call(...)` was made with. */
const addressed = (): [string, string] => {
  const last = mockVideoCall.mock.calls.at(-1);
  if (!last) throw new Error("no Stream call was made");
  return [last[0] as string, last[1] as string];
};

const broadcast = (over: Partial<LivestreamMeetingRef> = {}) =>
  ({
    id: "mt-1",
    streamCallId: "occurrence-ls-1",
    callType: LIVESTREAM_CALL_TYPE,
    organizationId: null,
    ...over,
  }) satisfies LivestreamMeetingRef;

const mesh = (over: Partial<LivestreamMeetingRef> = {}) =>
  ({
    ...broadcast({ callType: STREAM_CALL_TYPE }),
    ...over,
  }) satisfies LivestreamMeetingRef;

beforeEach(() => {
  jest.clearAllMocks();
  callOrder.length = 0;
  mockGoLive.mockResolvedValue({ duration: "1ms" });
  mockStopLive.mockResolvedValue({ duration: "1ms" });
  mockUpdateCallMembers.mockResolvedValue({ members: [] });
  mockQueryMembers.mockResolvedValue({ members: [] });
  mockGet.mockResolvedValue({ call: { egress: {} } });
  mockMembershipFindUnique.mockResolvedValue(null);
});

describe("every verb addresses the call type on the row", () => {
  it("goes live on `livestream:`, not `default:`", async () => {
    // The whole failure this module exists to prevent: Stream answers a call it
    // does not hold with a 404, so a webinar addressed on `default` goes live
    // nowhere and the presenter sees an error over a working broadcast.
    const result = await goLive({
      meeting: broadcast(),
      hostUserId: "user-host",
    });

    expect(result).toMatchObject({ ok: true, callType: LIVESTREAM_CALL_TYPE });
    expect(addressed()).toEqual([LIVESTREAM_CALL_TYPE, "occurrence-ls-1"]);
  });

  it("reads a mis-cased persisted type rather than downgrading the broadcast", async () => {
    // `Meeting.callType` is a `String` column. Coercing `"Livestream"` down to
    // `default` would silently turn a webinar into a full-mesh room, and a
    // call's type can never be changed afterwards.
    await goLive({
      meeting: broadcast({ callType: "  Livestream " }),
      hostUserId: "user-host",
    });

    expect(addressed()).toEqual([LIVESTREAM_CALL_TYPE, "occurrence-ls-1"]);
  });

  it("strips a cid prefix from the stored call id without changing the room", async () => {
    // `Meeting.streamCallId` is stored BARE, but a copied URL or a
    // `livestream:`-prefixed value both arrive. Passing a cid straight into
    // `client.call(type, id)` mints a call whose id literally contains a colon.
    await goLive({
      meeting: broadcast({ streamCallId: "livestream:occurrence-ls-9" }),
      hostUserId: "user-host",
    });

    expect(addressed()).toEqual([LIVESTREAM_CALL_TYPE, "occurrence-ls-9"]);
  });

  it("refuses a meeting that is not a broadcast, without touching Stream", async () => {
    // Not an exception and not a 404: Stream will happily answer go-live on any
    // call it holds, so a wrong call here SUCCEEDS and silently does nothing.
    const result = await goLive({
      meeting: mesh(),
      hostUserId: "user-host",
    });

    expect(result).toMatchObject({ ok: false, reason: "not_livestream" });
    expect(mockVideoCall).not.toHaveBeenCalled();
    expect(mockGoLive).not.toHaveBeenCalled();
  });

  it("refuses a row whose type it cannot read as one of ours", async () => {
    // #1285's shape: a hand-edited column must never produce a CID on somebody
    // else's call type, and must not be mistaken for a broadcast either.
    for (const callType of ["audio_room", "development", "", null]) {
      const result = await goLive({
        meeting: broadcast({ callType }),
        hostUserId: "user-host",
      });
      expect(result).toMatchObject({ ok: false, reason: "not_livestream" });
    }
    expect(mockVideoCall).not.toHaveBeenCalled();
  });

  it("refuses a row with no minted call yet", async () => {
    // #C1's normal state for a session whose first mint failed: the row exists,
    // the room does not. The next person to walk in creates it.
    const result = await goLive({
      meeting: broadcast({ streamCallId: null }),
      hostUserId: "user-host",
    });

    expect(result).toMatchObject({ ok: false, reason: "no_call" });
    expect(mockVideoCall).not.toHaveBeenCalled();
  });
});

describe("goLive designates the host server-side, and before it goes live", () => {
  it("writes the host role onto the caller's own membership", async () => {
    await goLive({ meeting: broadcast(), hostUserId: "user-host" });

    expect(mockUpdateCallMembers).toHaveBeenCalledWith({
      update_members: [{ user_id: "user-host", role: HOST_CALL_ROLE }],
    });
  });

  it("designates BEFORE leaving backstage, so a live broadcast has an owner", async () => {
    // The order is the security property: `endLive` authorises on this
    // designation, so going live first would leave a broadcast running that
    // nobody is permitted to stop.
    await goLive({ meeting: broadcast(), hostUserId: "user-host" });

    expect(callOrder).toEqual(["updateCallMembers", "goLive"]);
  });

  it("names `host`, not the `default` type's `call_member`", async () => {
    // `call_member` is right for a 1:1 room and wrong here: on a broadcast the
    // presenter is the one who can take it live and stop it. Pinned so a future
    // edit cannot reach for `CALL_MEMBER_ROLE` from `room-payload.ts`, which
    // means the same word on a DIFFERENT call type with DIFFERENT grants.
    await goLive({ meeting: broadcast(), hostUserId: "user-host" });

    const [{ update_members }] = mockUpdateCallMembers.mock.calls[0] as [
      { update_members: { role: string }[] },
    ];
    expect(update_members[0].role).toBe("host");
  });

  it("takes nothing from the caller beyond the host's user id", async () => {
    // A caller-supplied role claim is what #1270 was. The designation is derived
    // here, after the route has resolved the caller is on the hosting side.
    await goLive({
      meeting: broadcast(),
      hostUserId: "user-host",
      plan: { livestreamEnabled: true },
    });

    expect(Object.keys(mockUpdateCallMembers.mock.calls[0][0])).toEqual([
      "update_members",
    ]);
  });

  it("reports the vendor failing, rather than a broadcast that is not on", async () => {
    mockGoLive.mockRejectedValue(new Error("stream 4"));

    const result = await goLive({
      meeting: broadcast(),
      hostUserId: "user-host",
    });

    expect(result).toMatchObject({ ok: false, reason: "stream_unreachable" });
  });
});

describe("HLS is the plan's decision, and absent means no", () => {
  it("does not fan out when no entitlement was injected", async () => {
    // There is no `livestreamEnabled` column on any of the four plan models, so
    // the flag is injected — and the default is OFF, because this is the one
    // predicate in the module that spends money when it is wrong.
    await goLive({ meeting: broadcast(), hostUserId: "user-host" });

    expect(mockGoLive).toHaveBeenCalledWith({ start_hls: false });
  });

  it("does not fan out for a plan that did not buy it", async () => {
    // A webinar is a real room with real participants. It still goes live.
    const result = await goLive({
      meeting: broadcast(),
      hostUserId: "user-host",
      plan: { livestreamEnabled: false },
    });

    expect(result).toMatchObject({ ok: true, hls: false });
    expect(mockGoLive).toHaveBeenCalledWith({ start_hls: false });
  });

  it("fans out only on an explicit yes", async () => {
    const result = await goLive({
      meeting: broadcast(),
      hostUserId: "user-host",
      plan: { livestreamEnabled: true },
    });

    expect(mockGoLive).toHaveBeenCalledWith({ start_hls: true });
    expect(result).toMatchObject({ ok: true, hls: true });
  });

  it("reports what it ASKED for, not what Stream started", async () => {
    // Stream can refuse the egress and still answer go-live successfully, and a
    // "streaming now" over a call with no playlist behind it is worse than an
    // honest false.
    mockGoLive.mockResolvedValue({ duration: "1ms", call: { egress: {} } });

    const result = await goLive({
      meeting: broadcast(),
      hostUserId: "user-host",
      plan: { livestreamEnabled: true },
    });

    expect(result).toMatchObject({ ok: true, hls: true });
  });
});

describe("endLive authorises on the designation, not on anything it is told", () => {
  it("stops the broadcast for the designated host", async () => {
    mockQueryMembers.mockResolvedValue({
      members: [{ user_id: "user-host", role: HOST_CALL_ROLE }],
    });

    const result = await endLive({
      meeting: broadcast(),
      actorUserId: "user-host",
    });

    expect(result).toMatchObject({ ok: true });
    expect(mockStopLive).toHaveBeenCalledTimes(1);
  });

  it("filters the member query VENDOR-side by role and user", async () => {
    // Walking members client-side would refuse a host on page two of a
    // 200-attendee webinar — `queryMembers` pages at 20 by default — and tell
    // them they are not the host of their own broadcast.
    mockQueryMembers.mockResolvedValue({ members: [] });

    await endLive({ meeting: broadcast(), actorUserId: "user-host" });

    expect(mockQueryMembers).toHaveBeenCalledWith({
      limit: 1,
      filter_conditions: {
        user_id: { $eq: "user-host" },
        role: HOST_CALL_ROLE,
      },
    });
  });

  it("refuses a participant and stops nothing", async () => {
    // Being allowed IN is not being allowed to close the room on everyone else.
    const result = await endLive({
      meeting: broadcast(),
      actorUserId: "user-attendee",
    });

    expect(result).toMatchObject({ ok: false, reason: "not_host" });
    expect(mockStopLive).not.toHaveBeenCalled();
  });

  it("never asks the database at all for a personal (unscoped) meeting", async () => {
    // There is no org to be an admin of, and a designated host must not pay for
    // a membership lookup on every teardown.
    mockQueryMembers.mockResolvedValue({
      members: [{ user_id: "user-host", role: HOST_CALL_ROLE }],
    });

    await endLive({ meeting: broadcast(), actorUserId: "user-host" });

    expect(mockMembershipFindUnique).not.toHaveBeenCalled();
  });

  it("accepts an org operator on the meeting's stamped org", async () => {
    mockQueryMembers.mockResolvedValue({ members: [] });
    mockMembershipFindUnique.mockResolvedValue({
      status: "ACTIVE",
      role: "OWNER",
    });

    await endLive({
      meeting: broadcast({ organizationId: "org-1" }),
      actorUserId: "user-admin",
    });

    expect(mockMembershipFindUnique).toHaveBeenCalledWith({
      where: {
        userId_organizationId: {
          userId: "user-admin",
          organizationId: "org-1",
        },
      },
      select: { status: true, role: true },
    });
    expect(mockStopLive).toHaveBeenCalledTimes(1);
  });

  it("refuses a SUSPENDED org operator", async () => {
    // The account ban check in the route guard covers the platform side of the
    // same rule; this is the tenant side.
    mockQueryMembers.mockResolvedValue({ members: [] });
    mockMembershipFindUnique.mockResolvedValue({
      status: "SUSPENDED",
      role: "OWNER",
    });

    const result = await endLive({
      meeting: broadcast({ organizationId: "org-1" }),
      actorUserId: "user-admin",
    });

    expect(result).toMatchObject({ ok: false, reason: "not_host" });
    expect(mockStopLive).not.toHaveBeenCalled();
  });

  it("refuses an org role with no grant over sessions", async () => {
    // LEARNER and SUPPORT hold no act-for-org grant. Reusing
    // `appointments.actForOrg.cancel` rather than inventing a livestream key is
    // a judgement call — it is what stops an org operator's authority over live
    // sessions drifting from their authority over the sessions underneath.
    for (const role of ["LEARNER", "SUPPORT", "BILLING_ADMIN"]) {
      jest.clearAllMocks();
      callOrder.length = 0;
      mockQueryMembers.mockResolvedValue({ members: [] });
      mockMembershipFindUnique.mockResolvedValue({ status: "ACTIVE", role });

      const result = await endLive({
        meeting: broadcast({ organizationId: "org-1" }),
        actorUserId: "user-admin",
      });

      expect(result).toMatchObject({ ok: false, reason: "not_host" });
      expect(mockStopLive).not.toHaveBeenCalled();
    }
  });

  it("fails closed when Stream cannot tell us who the host is", async () => {
    // Failing open here would be a new grant issued on the strength of an
    // outage: the whole point of the designation is that only the vendor knows
    // it.
    mockQueryMembers.mockRejectedValue(new Error("stream down"));

    const result = await endLive({
      meeting: broadcast({ organizationId: "org-1" }),
      actorUserId: "user-admin",
    });

    expect(result).toMatchObject({ ok: false, reason: "stream_unreachable" });
    expect(mockStopLive).not.toHaveBeenCalled();
    // And it does not fall through to the org branch on the failure.
    expect(mockMembershipFindUnique).not.toHaveBeenCalled();
  });

  it("takes the broadcast out of production rather than ending the call", async () => {
    // A call's `ended_at` never clears at the vendor, so `end()` is
    // irreversible and `stopLive` is its exact inverse — it returns the room to
    // backstage and, with no `continue_*` flags, stops the egress a participant
    // may already hold.
    mockQueryMembers.mockResolvedValue({
      members: [{ user_id: "user-host", role: HOST_CALL_ROLE }],
    });

    await endLive({ meeting: broadcast(), actorUserId: "user-host" });

    expect(mockStopLive).toHaveBeenCalledWith();
  });

  it("refuses a non-broadcast without reading a single member", async () => {
    const result = await endLive({ meeting: mesh(), actorUserId: "user-host" });

    expect(result).toMatchObject({ ok: false, reason: "not_livestream" });
    expect(mockVideoCall).not.toHaveBeenCalled();
    expect(mockQueryMembers).not.toHaveBeenCalled();
  });

  it("fails closed when the org membership cannot be read", async () => {
    // The other direction of "we cannot say": a database blip must not be
    // answered by falling through to "not the host" with a 403, which reads to
    // the operator as a decision rather than an outage.
    mockQueryMembers.mockResolvedValue({ members: [] });
    mockMembershipFindUnique.mockRejectedValue(new Error("pool exhausted"));

    const result = await endLive({
      meeting: broadcast({ organizationId: "org-1" }),
      actorUserId: "user-admin",
    });

    expect(result).toMatchObject({ ok: false, reason: "stream_unreachable" });
    expect(mockStopLive).not.toHaveBeenCalled();
  });

  it("reports the vendor failing to stop, rather than a silent no-op", async () => {
    mockQueryMembers.mockResolvedValue({
      members: [{ user_id: "user-host", role: HOST_CALL_ROLE }],
    });
    mockStopLive.mockRejectedValue(new Error("stream 4"));

    const result = await endLive({
      meeting: broadcast(),
      actorUserId: "user-host",
    });

    expect(result).toMatchObject({ ok: false, reason: "stream_unreachable" });
  });
});

describe("the HLS URL is a credential, and the code treats it like one", () => {
  const PLAYLIST =
    "https://stream-io-video.com/api/v1/video/call/live-abc.m3u8?token=SECRET";

  it("returns the playlist URL from the call's egress", async () => {
    mockGet.mockResolvedValue({
      call: {
        egress: { hls: { playlist_url: PLAYLIST, status: "live" } },
      },
    });

    const result = await resolveHlsUrl({ meeting: broadcast() });

    expect(result).toMatchObject({
      ok: true,
      playlistUrl: PLAYLIST,
      hlsStatus: "live",
    });
  });

  it("answers 'no stream' rather than an empty success when egress is absent", async () => {
    // Stream answers a call with no HLS successfully and simply omits the
    // object. `null` here is a real answer; it must not read as a URL that
    // happens to be missing.
    mockGet.mockResolvedValue({ call: { egress: { broadcasting: false } } });

    const result = await resolveHlsUrl({ meeting: broadcast() });

    expect(result).toMatchObject({ ok: false, reason: "hls_unavailable" });
  });

  it("never lets the URL reach the logger, on the success path", async () => {
    mockGet.mockResolvedValue({
      call: { egress: { hls: { playlist_url: PLAYLIST, status: "live" } } },
    });

    await resolveHlsUrl({ meeting: broadcast() });

    expect(JSON.stringify(allLoggerCalls())).not.toContain("SECRET");
  });

  it("withholds the vendor's error message, which can echo the request back", async () => {
    // A log sink is readable by anyone with log access, outlives the broadcast,
    // and is never rotated. The error's own payload is the one thing here capable
    // of carrying a credential into it, so it is logged by TYPE only.
    mockGet.mockRejectedValue(new Error(`upstream rejected ${PLAYLIST}`));

    const result = await resolveHlsUrl({ meeting: broadcast() });

    expect(result).toMatchObject({ ok: false, reason: "stream_unreachable" });
    expect(JSON.stringify(allLoggerCalls())).not.toContain("SECRET");
  });

  it("refuses a non-broadcast meeting without asking Stream", async () => {
    const result = await resolveHlsUrl({ meeting: mesh() });

    expect(result).toMatchObject({ ok: false, reason: "not_livestream" });
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("does not gate the READ on the plan's HLS flag", async () => {
    // `hlsAvailableFor` decides whether we SPEND HLS by starting the egress.
    // Whether an attendee may PLAY an egress that already exists is a different
    // question, answered by whether they are on the booking — which is a
    // question this function is not asked. Gating here could only ever say "no
    // stream" to someone entitled to the stream.
    mockGet.mockResolvedValue({
      call: { egress: { hls: { playlist_url: PLAYLIST, status: "live" } } },
    });

    const result = await resolveHlsUrl({ meeting: broadcast() });

    expect(result).toMatchObject({ ok: true });
  });
});

describe("the row read and the explicit org scope", () => {
  it("selects only what the verbs and the scope check read", async () => {
    // The RAW row, nested the way Prisma returns it — the reader is the thing
    // under test, and it flattens `occurrence.appointment.organizationId`
    // alongside the stamp so the two can be compared in one round trip.
    mockMeetingFindUnique.mockResolvedValue({
      id: "mt-1",
      streamCallId: "occurrence-ls-1",
      callType: LIVESTREAM_CALL_TYPE,
      organizationId: "org-1",
      occurrence: { appointment: { organizationId: "org-1" } },
    });

    const row = await readLivestreamMeetingRow("mt-1");

    expect(mockMeetingFindUnique).toHaveBeenCalledWith({
      where: { id: "mt-1" },
      select: {
        id: true,
        streamCallId: true,
        callType: true,
        organizationId: true,
        occurrence: {
          select: { appointment: { select: { organizationId: true } } },
        },
      },
    });
    expect(row).toEqual({
      id: "mt-1",
      streamCallId: "occurrence-ls-1",
      callType: LIVESTREAM_CALL_TYPE,
      organizationId: "org-1",
      appointmentOrganizationId: "org-1",
    });
  });

  it("returns null for a row that does not exist", async () => {
    mockMeetingFindUnique.mockResolvedValue(null);

    expect(await readLivestreamMeetingRow("mt-gone")).toBeNull();
  });

  it("agrees when the stamp and the appointment name the same org", () => {
    const row: LivestreamMeetingRow = {
      id: "mt-1",
      streamCallId: "occurrence-ls-1",
      callType: LIVESTREAM_CALL_TYPE,
      organizationId: "org-1",
      appointmentOrganizationId: "org-1",
    };

    expect(assertSameOrganization(row)).toBeNull();
  });

  it("refuses a row whose stamp disagrees with the appointment that owns it", async () => {
    // Every org authorisation below reads the STAMP, so a stale stamp would
    // authorise a stranger against the wrong tenant, silently, with a 200 to
    // prove it. Refused rather than resolved in favour of one of the two.
    const row: LivestreamMeetingRow = {
      id: "mt-1",
      streamCallId: "occurrence-ls-1",
      callType: LIVESTREAM_CALL_TYPE,
      organizationId: "org-1",
      appointmentOrganizationId: "org-2",
    };

    const refusal = assertSameOrganization(row);

    expect(refusal).toMatchObject({ ok: false });
    // The message is the not-found one: this route must not describe its own
    // schema to a caller who has no business knowing the row exists.
    expect(refusal?.ok === false && refusal.message).toBe("Meeting not found");
  });

  it("treats two null orgs as agreement — a personal booking", () => {
    const row: LivestreamMeetingRow = {
      id: "mt-1",
      streamCallId: "occurrence-ls-1",
      callType: LIVESTREAM_CALL_TYPE,
      organizationId: null,
      appointmentOrganizationId: null,
    };

    expect(assertSameOrganization(row)).toBeNull();
  });

  it("treats one null and one set as a disagreement", () => {
    // A meeting that cannot say which tenant it belongs to is exactly the row
    // this check exists for.
    expect(
      assertSameOrganization({
        id: "mt-1",
        streamCallId: "occurrence-ls-1",
        callType: LIVESTREAM_CALL_TYPE,
        organizationId: null,
        appointmentOrganizationId: "org-1",
      }),
    ).toMatchObject({ ok: false });
  });
});
