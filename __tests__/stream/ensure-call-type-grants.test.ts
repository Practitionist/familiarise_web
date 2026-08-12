/**
 * @jest-environment node
 */

/**
 * #1134 P0-1 — the grants script, which is the half of the fix that lives in
 * Stream's config rather than in our code.
 *
 * Two rounds of this went wrong in ways reading the code could not show, so the
 * cases below are pinned against the LIVE grants map rather than against the
 * docs. Stream's published docs list five built-in roles including `host` and
 * `moderator` and spell the member role `call-member`; the live `default` type
 * has exactly six keys — `admin, call_member, global_admin, global_read_only,
 * guest, user` — with no `host`, no `moderator`, and an underscore. An earlier
 * draft trusted the docs, assigned `role: "host"`, and would have refused both
 * sides of every 1:1.
 */

const mockGetCallType = jest.fn();
const mockUpdateCallType = jest.fn();

jest.mock("../../lib/stream-client", () => ({
  isStreamConfigured: jest.fn(() => true),
  getStreamVideoClient: jest.fn(() => ({
    video: {
      getCallType: mockGetCallType,
      updateCallType: mockUpdateCallType,
    },
  })),
}));

import { ensureCallTypeGrants } from "../../scripts/stream/ensure-call-type-grants";

/** The live `default` grants, trimmed to the permissions this script touches. */
const LIVE_GRANTS = (): Record<string, string[]> => ({
  admin: ["join-call", "end-call", "start-recording", "stop-recording", "mute-users"],
  call_member: ["join-call", "end-call", "start-recording", "stop-recording", "send-audio"],
  global_admin: ["read-call"],
  global_read_only: ["read-call"],
  guest: ["join-call", "send-audio"],
  user: ["join-call", "end-call", "start-recording", "stop-recording", "send-audio"],
});

const LIVE_SETTINGS = { recording: { mode: "available", quality: "720p" } };
const LIVE_NOTIFICATIONS = { enabled: true };

function mockCallType(grants: Record<string, string[]>) {
  return {
    name: "default",
    grants,
    settings: LIVE_SETTINGS,
    notification_settings: LIVE_NOTIFICATIONS,
  };
}

/** Grants as they end up on Stream after an --apply run. */
function applied(): Record<string, string[]> {
  const call = mockUpdateCallType.mock.calls.at(-1);
  if (!call) throw new Error("updateCallType was never called");
  return call[0].grants as Record<string, string[]>;
}

/**
 * A stateful fake, not a pair of canned responses. The script now re-reads the
 * call type after writing it, so a `getCallType` that keeps returning the
 * PRE-write state makes every apply look like a failed write. Storing what was
 * written is what the real server does; tests that need the two to diverge
 * override with `mockResolvedValueOnce`, which is consumed ahead of this.
 */
let stored: Record<string, string[]>;

beforeEach(() => {
  jest.clearAllMocks();
  stored = LIVE_GRANTS();
  mockGetCallType.mockImplementation(async () => mockCallType({ ...stored }));
  mockUpdateCallType.mockImplementation(
    async ({ grants }: { grants: Record<string, string[]> }) => {
      stored = { ...grants };
      return {};
    },
  );
});

describe("ensure-call-type-grants", () => {
  it("is a dry run by default and writes nothing", async () => {
    const code = await ensureCallTypeGrants({ apply: false, restore: false });

    expect(code).toBe(0);
    expect(mockUpdateCallType).not.toHaveBeenCalled();
  });

  it("takes join-call off user AND guest", async () => {
    await ensureCallTypeGrants({ apply: true, restore: false });

    // `guest` matters as much as `user`: the app has
    // guest_user_creation_disabled: false, so guest sessions are creatable
    // client-side with nothing but NEXT_PUBLIC_STREAM_API_KEY. Stripping only
    // `user` leaves the devtools bypass fully intact.
    expect(applied().user).not.toContain("join-call");
    expect(applied().guest).not.toContain("join-call");
  });

  it("leaves call_member able to join — the whole system depends on it", async () => {
    await ensureCallTypeGrants({ apply: true, restore: false });

    // The join route assigns call_member to EVERY participant. If this role
    // cannot join, nobody can join anything.
    expect(applied().call_member).toContain("join-call");
  });

  it("takes recording control off call_member, not just off user", async () => {
    await ensureCallTypeGrants({ apply: true, restore: false });

    // The live type grants call_member start-recording and stop-recording, and
    // the join route hands call_member to everyone — so revoking these from
    // `user` alone changed nothing at all, while reading as a fix. Recording is
    // server-only here (RecordingControls posts to /api/stream/recordings/*;
    // there is no client-side call.startRecording in the tree), so the grant has
    // no legitimate use and its only effect is to let a participant walk around
    // the pre-join consent gate.
    for (const role of ["user", "guest", "call_member"]) {
      expect(applied()[role]).not.toContain("start-recording");
      expect(applied()[role]).not.toContain("stop-recording");
    }
  });

  it("leaves end-call on call_member, because EndCallButton needs it", async () => {
    await ensureCallTypeGrants({ apply: true, restore: false });

    // EndCallButton.tsx calls call.endCall() client-side and the Stream role no
    // longer separates host from participant, so revoking this would take the
    // host's End Call button down with it. Tracked separately; deliberately not
    // half-fixed here.
    expect(applied().call_member).toContain("end-call");
    // Still revoked from user/guest as defence in depth.
    expect(applied().user).not.toContain("end-call");
  });

  it("does not touch admin", async () => {
    await ensureCallTypeGrants({ apply: true, restore: false });

    expect(applied().admin).toEqual(LIVE_GRANTS().admin);
  });

  it("does not invent role keys the call type does not have", async () => {
    await ensureCallTypeGrants({ apply: true, restore: false });

    // Review suggested initialising `host` and `moderator`, on the strength of
    // Stream's docs. Neither key exists on this app's `default` type, and the
    // join route assigns neither, so creating them would add grants for roles
    // nobody is ever given.
    expect(Object.keys(applied()).sort()).toEqual(Object.keys(LIVE_GRANTS()).sort());
  });

  it("heals a call type that arrives without a joinable member role", async () => {
    delete (stored as Record<string, string[] | undefined>).call_member;

    const code = await ensureCallTypeGrants({ apply: true, restore: false });

    expect(code).toBe(0);
    expect(applied().call_member).toContain("join-call");
  });

  it("fails loudly if Stream did not store join-call on call_member", async () => {
    // The pre-apply version of this check was unreachable — the transform adds
    // join-call to call_member a few lines earlier, so the condition was false
    // by construction. It only means anything against what Stream actually
    // stored, which is what this exercises: the write "succeeds" but the re-read
    // shows the role cannot join, i.e. every participant is locked out.
    mockGetCallType
      .mockResolvedValueOnce(mockCallType(LIVE_GRANTS()))
      .mockResolvedValueOnce({
        name: "default",
        grants: { ...LIVE_GRANTS(), call_member: ["send-audio"] },
        settings: LIVE_SETTINGS,
        notification_settings: LIVE_NOTIFICATIONS,
      });

    const code = await ensureCallTypeGrants({ apply: true, restore: false });

    expect(code).toBe(1);
  });

  it("is idempotent — a second run over its own output is a no-op", async () => {
    await ensureCallTypeGrants({ apply: true, restore: false });
    mockUpdateCallType.mockClear();

    const code = await ensureCallTypeGrants({ apply: true, restore: false });

    expect(code).toBe(0);
    expect(mockUpdateCallType).not.toHaveBeenCalled();
  });

  it("verifies settings survived the write, and fails loudly if not", async () => {
    // Stream does not document whether updateCallType merges or replaces the
    // fields it is not given, and the chat twin (channel.update) is a full
    // replace that deletes everything absent from the payload. If that turns out
    // to be true here, the run must not report success.
    mockGetCallType
      .mockResolvedValueOnce(mockCallType(LIVE_GRANTS()))
      .mockResolvedValueOnce({
        name: "default",
        grants: LIVE_GRANTS(),
        settings: {},
        notification_settings: LIVE_NOTIFICATIONS,
      });

    const code = await ensureCallTypeGrants({ apply: true, restore: false });

    expect(code).toBe(1);
  });

  it("restores join-call without handing back recording control", async () => {
    await ensureCallTypeGrants({ apply: true, restore: false });
    mockUpdateCallType.mockClear();

    const code = await ensureCallTypeGrants({ apply: true, restore: true });

    expect(code).toBe(0);
    // Rolling the join change back is an availability rollback. Handing every
    // participant end-call and start-recording again is not part of that.
    expect(applied().user).toContain("join-call");
    expect(applied().user).not.toContain("start-recording");
    expect(applied().user).not.toContain("end-call");
  });
});
