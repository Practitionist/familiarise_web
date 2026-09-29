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
const mockWriteFileSync = jest.fn();
// #1270 — the pre-flight assertion reads real member records before it will
// write. These back it.
const mockQueryCalls = jest.fn();
const mockQueryMembers = jest.fn();

// The target-app guard greps its own source in one case, the way
// grants-deploy-gate.test.ts does for the deploy gate. `node:fs` is mocked
// above (the drift branch writes a recovery pre-image through it), so the real
// reader is pulled in where the source is needed.
import { join } from "path";

// The drift branch writes the recovery pre-image to disk. Unmocked, every run of
// this suite would leave a real file in tmpdir — and the payload, which is the
// only copy of a config Stream just discarded, would go unasserted.
jest.mock("node:fs", () => ({
  writeFileSync: (...a: unknown[]) => mockWriteFileSync(...a),
}));

jest.mock("../../lib/stream-client", () => ({
  isStreamConfigured: jest.fn(() => true),
  getStreamVideoClient: jest.fn(() => ({
    video: {
      getCallType: mockGetCallType,
      updateCallType: mockUpdateCallType,
      queryCalls: mockQueryCalls,
      call: () => ({ queryMembers: mockQueryMembers }),
    },
  })),
}));

import {
  ensureCallTypeGrants,
  DRIFT_EXIT_CODE,
} from "../../scripts/stream/ensure-call-type-grants";
import { PRODUCTION_APP_NAME } from "../../scripts/stream/target-guard";

/**
 * The script's own flag object, defaulted.
 *
 * Every write case below now has to assert a target app (`target-guard.ts`), and
 * 30 call sites repeating it would be 30 chances to forget one. The defaults are
 * the SAFE ones — a dry run that names nothing and asserts no deploy — so a case
 * that means to write opts in explicitly, which is the direction a mistake
 * should go.
 *
 * `argv: []` passed explicitly means "names no target at all", which is what the
 * guard cases need; that is why the default is a fallback rather than a spread
 * that would overwrite it.
 */
function opts(
  o: Partial<Parameters<typeof ensureCallTypeGrants>[0]> = {},
): Parameters<typeof ensureCallTypeGrants>[0] {
  const { argv, ...rest } = o;
  return {
    apply: false,
    restore: false,
    deployConfirmed: false,
    check: false,
    ...rest,
    argv: argv ?? (rest.apply ? ["--target-app", PRODUCTION_APP_NAME] : []),
  };
}

/**
 * The live `default` grants, trimmed to the permissions this script touches.
 *
 * Read from `video_get_call_type` on 2026-09-29, not from Stream's docs, which
 * is the whole lesson of the fixture: the live map has no `host` and no
 * `moderator` key, and it holds four billable grants that a first pass over the
 * documentation never named.
 */
const LIVE_GRANTS = (): Record<string, string[]> => ({
  admin: [
    "join-call",
    "end-call",
    "start-recording",
    "stop-recording",
    "start-transcription",
    "start-broadcasting",
    "enable-noise-cancellation-any-team",
    "mute-users",
  ],
  call_member: [
    "join-call",
    "end-call",
    "start-recording",
    "stop-recording",
    "start-transcription",
    "stop-transcription",
    "start-closed-captions",
    "stop-closed-captions",
    "start-broadcasting",
    "stop-broadcasting",
    "enable-noise-cancellation-any-team",
    "send-audio",
  ],
  global_admin: ["read-call"],
  global_read_only: ["read-call"],
  guest: ["join-call", "send-audio", "enable-noise-cancellation-any-team"],
  user: [
    "join-call",
    "end-call",
    "start-recording",
    "stop-recording",
    "start-transcription",
    "stop-transcription",
    "start-closed-captions",
    "stop-closed-captions",
    "start-broadcasting",
    "stop-broadcasting",
    "enable-noise-cancellation-any-team",
    "send-audio",
  ],
});

/**
 * What the grants map should look like after a successful apply.
 *
 * The two settings-drift cases below need a verify-read that represents a write
 * that WORKED, so that they isolate the branch they are actually about. Feeding
 * them `LIVE_GRANTS()` would trip the post-write grants assertions first and
 * make them pass — or fail — for the wrong reason.
 */
const EXPECTED_GRANTS_AFTER = (): Record<string, string[]> => ({
  admin: LIVE_GRANTS().admin,
  call_member: ["join-call", "send-audio"],
  global_admin: ["read-call"],
  global_read_only: ["read-call"],
  guest: ["send-audio"],
  user: ["send-audio"],
});

/**
 * The live `livestream` grants, read 2026-09-29 with `video_get_call_type`.
 *
 * The point of this fixture is that `user` and `call_member` hold NEARLY THE
 * SAME LIST — both carry the whole owner-suffixed set. Stream has no host
 * concept on this type, so `call_member`, which the app hands to every
 * participant, is holding `end-call-owner`. Trimming the two roles down to what
 * this script touches would have hidden exactly that.
 */
const LIVE_LIVESTREAM_GRANTS = (): Record<string, string[]> => ({
  admin: [
    "create-call",
    "end-call",
    "start-recording",
    "stop-recording",
    "update-call",
  ],
  global_admin: ["end-call-any-team", "end-call-owner", "update-call-any-team"],
  global_read_only: ["read-call", "read-call-stats"],
  // `anonymous` IS a key here, and is not on `default`. One filter for both
  // types because of it.
  anonymous: ["read-call"],
  call_member: [
    "block-user-owner",
    "create-call-reaction",
    "enable-noise-cancellation-any-team",
    "end-call-owner",
    "join-backstage-owner",
    "join-ended-call-owner",
    "kick-user-owner",
    "mute-users-owner",
    "read-call",
    "remove-call-member-owner",
    "screenshare-owner",
    "send-audio-owner",
    "send-event",
    "send-video-owner",
    "start-broadcasting-owner",
    "start-recording-owner",
    "stop-broadcasting-owner",
    "stop-recording-owner",
    "update-call-member-owner",
    "update-call-member-role-owner",
    "update-call-owner",
  ],
  user: [
    "block-user-owner",
    "create-call-reaction",
    "enable-noise-cancellation-any-team",
    "end-call-owner",
    "join-backstage-owner",
    "kick-user-owner",
    "mute-users-owner",
    "read-call",
    "remove-call-member-owner",
    "send-audio-owner",
    "send-event",
    "send-video-owner",
    "start-broadcasting-owner",
    "start-recording-owner",
    "stop-broadcasting-owner",
    "stop-recording-owner",
    "update-call-member-owner",
    "update-call-member-role-owner",
    "update-call-owner",
  ],
});

const LIVE_SETTINGS = { recording: { mode: "available", quality: "720p" } };
const LIVE_NOTIFICATIONS = { enabled: true };

function mockCallType(grants: Record<string, string[]>, name = "default") {
  return {
    name,
    grants,
    settings: LIVE_SETTINGS,
    notification_settings: LIVE_NOTIFICATIONS,
  };
}

/**
 * The grants of ONE call type as they end up on Stream after an --apply run.
 *
 * Filtered by name because the script now writes two call types, and `default`
 * first: a "last call wins" helper would silently start describing `livestream`
 * in every case that meant to describe the type a consultation resolves against.
 */
function applied(name = "default"): Record<string, string[]> {
  const call = mockUpdateCallType.mock.calls
    .filter((c) => c[0].name === name)
    .at(-1);
  if (!call) throw new Error(`updateCallType was never called for ${name}`);
  return call[0].grants as Record<string, string[]>;
}

/**
 * A stateful fake, not a pair of canned responses. The script now re-reads the
 * call type after writing it, so a `getCallType` that keeps returning the
 * PRE-write state makes every apply look like a failed write. Storing what was
 * written is what the real server does; tests that need the two to diverge
 * override with `mockResolvedValueOnce`, which is consumed ahead of this.
 *
 * Keyed by call type for the same reason `applied()` is: the two types have
 * different live grants, and a single shared bag would let a livestream write
 * make a `default` assertion pass.
 */
let stored: Record<string, Record<string, string[]>>;

/** One open call whose members hold the roles given. */
function openCallWithMembers(roles: Array<string | undefined>) {
  mockQueryCalls.mockResolvedValue({
    calls: [{ call: { id: "slot-A", type: "default" } }],
    next: undefined,
  });
  mockQueryMembers.mockResolvedValue({
    members: roles.map((role, i) => ({ user_id: `user-${i}`, role })),
    next: undefined,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  stored = { default: LIVE_GRANTS(), livestream: LIVE_LIVESTREAM_GRANTS() };
  mockGetCallType.mockImplementation(async ({ name }: { name: string }) =>
    mockCallType({ ...stored[name] }, name),
  );
  mockUpdateCallType.mockImplementation(
    async ({
      name,
      grants,
    }: {
      name: string;
      grants: Record<string, string[]>;
    }) => {
      stored[name] = { ...grants };
      return {};
    },
  );
  // A healthy app: the join route has been running and members hold the role
  // the write below is about to make load-bearing.
  openCallWithMembers(["call_member", "call_member"]);
});

describe("ensure-call-type-grants", () => {
  it("is a dry run by default and writes nothing", async () => {
    const code = await ensureCallTypeGrants(
      opts({ apply: false, restore: false, deployConfirmed: false }),
    );

    expect(code).toBe(0);
    expect(mockUpdateCallType).not.toHaveBeenCalled();
  });

  it("takes join-call off user AND guest", async () => {
    await ensureCallTypeGrants(
      opts({ apply: true, restore: false, deployConfirmed: true }),
    );

    // `guest` matters as much as `user`: the app has
    // guest_user_creation_disabled: false, so guest sessions are creatable
    // client-side with nothing but NEXT_PUBLIC_STREAM_API_KEY. Stripping only
    // `user` leaves the devtools bypass fully intact.
    expect(applied().user).not.toContain("join-call");
    expect(applied().guest).not.toContain("join-call");
  });

  it("leaves call_member able to join — the whole system depends on it", async () => {
    await ensureCallTypeGrants(
      opts({ apply: true, restore: false, deployConfirmed: true }),
    );

    // The join route assigns call_member to EVERY participant. If this role
    // cannot join, nobody can join anything.
    expect(applied().call_member).toContain("join-call");
  });

  it("takes recording control off call_member, not just off user", async () => {
    await ensureCallTypeGrants(
      opts({ apply: true, restore: false, deployConfirmed: true }),
    );

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

  it("revokes end-call from call_member, now that the end route exists", async () => {
    await ensureCallTypeGrants(
      opts({ apply: true, restore: false, deployConfirmed: true }),
    );

    // The join route assigns `call_member` to EVERY participant, and Stream's
    // roles do not separate host from participant here — host-ness is
    // `custom.consultantUserId`, which Stream knows nothing about. So this grant
    // let any attendee end a paid consultation for both sides from devtools;
    // `EndCallButton`'s `isHost` only decides what renders.
    //
    // It could not be revoked until the client stopped needing it. #1270 moved
    // the button onto POST /api/meetings/[meetingId]/end, so it can now go.
    expect(applied().call_member).not.toContain("end-call");
    expect(applied().user).not.toContain("end-call");
    expect(applied().guest).not.toContain("end-call");

    // The one thing that must survive: call_member is what admits anyone at all.
    expect(applied().call_member).toContain("join-call");
  });

  it("leaves end-call on admin", async () => {
    await ensureCallTypeGrants(
      opts({ apply: true, restore: false, deployConfirmed: true }),
    );

    // `admin` is not a role any participant is assigned by the join route, and
    // the server client acts outside the permission system anyway. Stripping it
    // would buy nothing and break operator tooling.
    expect(applied().admin).toContain("end-call");
  });

  it("does not touch admin", async () => {
    await ensureCallTypeGrants(
      opts({ apply: true, restore: false, deployConfirmed: true }),
    );

    expect(applied().admin).toEqual(LIVE_GRANTS().admin);
  });

  it("does not invent role keys the call type does not have", async () => {
    await ensureCallTypeGrants(
      opts({ apply: true, restore: false, deployConfirmed: true }),
    );

    // Review suggested initialising `host` and `moderator`, on the strength of
    // Stream's docs. Neither key exists on this app's `default` type, and the
    // join route assigns neither, so creating them would add grants for roles
    // nobody is ever given.
    expect(Object.keys(applied()).sort()).toEqual(
      Object.keys(LIVE_GRANTS()).sort(),
    );
  });

  it("heals a call type that arrives without a joinable member role", async () => {
    delete stored.default.call_member;

    const code = await ensureCallTypeGrants(
      opts({ apply: true, restore: false, deployConfirmed: true }),
    );

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

    const code = await ensureCallTypeGrants(
      opts({ apply: true, restore: false, deployConfirmed: true }),
    );

    expect(code).toBe(1);
  });

  it("is idempotent — a second run over its own output is a no-op", async () => {
    await ensureCallTypeGrants(
      opts({ apply: true, restore: false, deployConfirmed: true }),
    );
    mockUpdateCallType.mockClear();

    const code = await ensureCallTypeGrants(
      opts({ apply: true, restore: false, deployConfirmed: true }),
    );

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
        grants: EXPECTED_GRANTS_AFTER(),
        settings: {},
        notification_settings: LIVE_NOTIFICATIONS,
      });

    const code = await ensureCallTypeGrants(
      opts({ apply: true, restore: false, deployConfirmed: true }),
    );

    expect(code).toBe(1);

    // The pre-image is the recovery path. It must carry the config as it was
    // BEFORE the write, or the operator has nothing to restore from.
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    const [path, payload] = mockWriteFileSync.mock.calls[0] as [string, string];
    expect(path).toContain("stream-call-type-default-preimage.json");
    expect(JSON.parse(payload)).toEqual({
      callType: "default",
      settings: LIVE_SETTINGS,
      notification_settings: LIVE_NOTIFICATIONS,
    });
  });

  it("does not report drift when only key ORDER differs", async () => {
    // Two independent getCallType reads. Key order between them is not
    // guaranteed, and a false positive here tells the operator Stream wiped a
    // config it never touched.
    mockGetCallType
      .mockResolvedValueOnce(mockCallType(LIVE_GRANTS()))
      .mockResolvedValueOnce({
        name: "default",
        grants: EXPECTED_GRANTS_AFTER(),
        // Same content, keys reversed.
        settings: { recording: { quality: "720p", mode: "available" } },
        notification_settings: LIVE_NOTIFICATIONS,
      });

    const code = await ensureCallTypeGrants(
      opts({ apply: true, restore: false, deployConfirmed: true }),
    );

    expect(code).toBe(0);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  /**
   * #1270 — the blind spot in the post-apply guard.
   *
   * That guard confirms Stream STORED `join-call` on `call_member`, which it
   * always will, because the transform writes it a few lines earlier. It says
   * nothing about whether anybody HOLDS the role — and until the mint started
   * naming members `call_member`, the answer for every call created by the app
   * was no: the consultant was stamped `host` (not a role on this call type at
   * all) and everyone else `user`. A green run and a total video outage.
   */
  describe("pre-flight: somebody has to hold the role", () => {
    it("refuses to apply when no member of any open call holds call_member", async () => {
      openCallWithMembers(["host", "user"]);

      const code = await ensureCallTypeGrants(
        opts({ apply: true, restore: false, deployConfirmed: true }),
      );

      expect(code).toBe(1);
      expect(mockUpdateCallType).not.toHaveBeenCalled();
    });

    it("refuses a MIXED roster, where only some members hold it", async () => {
      // #1270 review — the check used to pass on one member anywhere holding
      // the role, which is exactly the shape that locks people out: `host` is
      // not a role on this call type at all, so after the write that member
      // cannot join a call they are entitled to. A guard against a partial
      // outage must not be satisfied by a partial result.
      openCallWithMembers(["host", "call_member"]);

      const code = await ensureCallTypeGrants(
        opts({ apply: true, restore: false, deployConfirmed: true }),
      );

      expect(code).toBe(1);
      expect(mockUpdateCallType).not.toHaveBeenCalled();
    });

    it("applies when EVERY member holds it", async () => {
      openCallWithMembers(["call_member", "call_member"]);

      const code = await ensureCallTypeGrants(
        opts({ apply: true, restore: false, deployConfirmed: true }),
      );

      expect(code).toBe(0);
      expect(mockUpdateCallType).toHaveBeenCalled();
    });

    it("applies when there are no open calls to lock anyone out of", async () => {
      // A quiet app or a fresh environment. Refusing here would make the script
      // unrunnable rather than safe.
      mockQueryCalls.mockResolvedValue({ calls: [], next: undefined });

      const code = await ensureCallTypeGrants(
        opts({ apply: true, restore: false, deployConfirmed: true }),
      );

      expect(code).toBe(0);
      expect(mockUpdateCallType).toHaveBeenCalled();
    });

    it("treats an unreadable roster as a refusal, not as an empty one", async () => {
      // A Stream outage must not be mistaken for "nobody holds the role", and
      // it must not be waved through either. The question went unanswered, so
      // the write does not happen.
      mockQueryCalls.mockRejectedValue(new Error("stream down"));

      const code = await ensureCallTypeGrants(
        opts({ apply: true, restore: false, deployConfirmed: true }),
      );

      expect(code).toBe(1);
      expect(mockUpdateCallType).not.toHaveBeenCalled();
    });

    it("does not scan on a dry run", async () => {
      await ensureCallTypeGrants(
        opts({ apply: false, restore: false, deployConfirmed: false }),
      );

      expect(mockQueryCalls).not.toHaveBeenCalled();
    });

    it("does not scan on a rollback", async () => {
      // --restore-user-join hands `join-call` BACK to `user`. It can only widen
      // access, so gating it on who holds `call_member` would block the very
      // command an operator reaches for when they are already locked out.
      openCallWithMembers(["host", "user"]);

      const code = await ensureCallTypeGrants(
        opts({ apply: true, restore: true, deployConfirmed: false }),
      );

      expect(code).toBe(0);
      expect(mockQueryCalls).not.toHaveBeenCalled();
    });
  });

  it("restores join-call without handing back recording control", async () => {
    await ensureCallTypeGrants(
      opts({ apply: true, restore: false, deployConfirmed: true }),
    );
    mockUpdateCallType.mockClear();

    const code = await ensureCallTypeGrants(
      opts({ apply: true, restore: true, deployConfirmed: false }),
    );

    expect(code).toBe(0);
    // Rolling the join change back is an availability rollback. Handing every
    // participant end-call and start-recording again is not part of that.
    expect(applied().user).toContain("join-call");
    expect(applied().user).not.toContain("start-recording");
    expect(applied().user).not.toContain("end-call");
  });

  it("restores end-call to call_member on a rollback, but only to call_member", async () => {
    await ensureCallTypeGrants(
      opts({ apply: true, restore: false, deployConfirmed: true }),
    );
    mockUpdateCallType.mockClear();

    const code = await ensureCallTypeGrants(
      opts({ apply: true, restore: true, deployConfirmed: false }),
    );

    expect(code).toBe(0);
    // This rollback exists for exactly one situation: the end route is not
    // actually serving traffic. In that situation a host has no way to close a
    // room at all, so restoring join without end-call would fix the lockout and
    // strand every host inside a call they cannot end.
    expect(applied().call_member).toContain("end-call");
    expect(applied().call_member).toContain("join-call");

    // Ordinary roles get join-call back and nothing else. Their end-call
    // revocation carried no availability risk, so undoing it would only re-open
    // the hole.
    expect(applied().user).not.toContain("end-call");
    expect(applied().guest).not.toContain("end-call");
    expect(applied().call_member).not.toContain("start-recording");
  });

  it("fails the ROLLBACK if Stream did not restore end-call to call_member", async () => {
    // Both post-write grant checks are gated on `!opts.restore`, so before this
    // the rollback path reached the settings comparison, found nothing moved,
    // and returned 0 — reporting success without asking whether the restoration
    // landed. That is the wrong way round: the rollback is the emergency path,
    // reached when the revocation has already locked people out.
    await ensureCallTypeGrants(
      opts({ apply: true, restore: false, deployConfirmed: true }),
    );
    mockGetCallType.mockClear();

    // A stale second read: Stream reports the post-revocation grants, i.e. the
    // restore did not take.
    mockGetCallType
      .mockResolvedValueOnce(mockCallType(EXPECTED_GRANTS_AFTER()))
      .mockResolvedValueOnce(mockCallType(EXPECTED_GRANTS_AFTER()));

    const code = await ensureCallTypeGrants(
      opts({ apply: true, restore: true, deployConfirmed: false }),
    );

    expect(code).toBe(1);
  });

  it("fails the run if Stream reads back end-call still on call_member", async () => {
    // The mirror of the join-call assertion. A silently-ignored revocation would
    // leave every attendee able to end a paid consultation while this script
    // printed a green tick — asserting the ABSENCE against returned data is the
    // only thing that catches it.
    mockGetCallType
      .mockResolvedValueOnce(mockCallType(LIVE_GRANTS()))
      .mockResolvedValueOnce(mockCallType(LIVE_GRANTS()));

    const code = await ensureCallTypeGrants(
      opts({ apply: true, deployConfirmed: true }),
    );

    expect(code).toBe(1);
  });

  /**
   * The grants hardening that half-landed.
   *
   * The live `default` type, read 2026-09-29, grants seven billable
   * permissions to BOTH `user` and `call_member` — transcription, closed
   * captions, broadcasting and the noise-cancellation grant — and this script
   * revoked only `start-recording`/`stop-recording`. So a run that succeeded
   * left every participant able to turn on a per-participant-minute meter, and
   * the run reported success.
   */
  describe("the billable grants #1301 left in place", () => {
    const BILLABLE = [
      "start-transcription",
      "stop-transcription",
      "start-closed-captions",
      "stop-closed-captions",
      "start-broadcasting",
      "stop-broadcasting",
      "enable-noise-cancellation-any-team",
    ];

    it("takes every one of them off call_member, not just off user", async () => {
      await ensureCallTypeGrants(opts({ apply: true, deployConfirmed: true }));

      // `call_member` is the load-bearing role: /api/meetings/[meetingId]/join
      // hands it to EVERY participant. Revoking from `user` alone removes the
      // grant from nobody and reads exactly like a fix.
      for (const perm of BILLABLE) {
        expect(applied().call_member).not.toContain(perm);
      }
    });

    it("takes them off user, guest and anonymous too", async () => {
      await ensureCallTypeGrants(opts({ apply: true, deployConfirmed: true }));

      for (const role of ["user", "guest"]) {
        for (const perm of BILLABLE) {
          expect(applied()[role]).not.toContain(perm);
        }
      }
    });

    it("filters a role the call type does not have rather than inventing it", async () => {
      // `anonymous` is not a key on `default` — it IS one on `livestream`, and
      // listing it in the revoked-roles set means the two types need one filter.
      // Creating the key would grant a role nobody is ever assigned.
      delete stored.default.guest;
      const keysBefore = Object.keys(stored.default).sort();

      const code = await ensureCallTypeGrants(
        opts({ apply: true, deployConfirmed: true }),
      );

      expect(code).toBe(0);
      expect(Object.keys(applied())).not.toContain("anonymous");
      expect(Object.keys(applied()).sort()).toEqual(keysBefore);
    });

    it("leaves admin alone — an operator must still be able to inspect a call", async () => {
      await ensureCallTypeGrants(opts({ apply: true, deployConfirmed: true }));

      expect(applied().admin).toContain("enable-noise-cancellation-any-team");
      expect(applied().admin).toEqual(LIVE_GRANTS().admin);
    });

    it("fails the run if Stream reads any of them back still granted", async () => {
      // The check the half-landed fix did not have. A 200 from updateCallType is
      // not evidence that a revocation was stored, and the one that failed to
      // land here is the one that costs money.
      mockGetCallType
        .mockResolvedValueOnce(mockCallType(LIVE_GRANTS()))
        .mockResolvedValueOnce(
          mockCallType({
            ...EXPECTED_GRANTS_AFTER(),
            call_member: [
              ...EXPECTED_GRANTS_AFTER().call_member,
              "enable-noise-cancellation-any-team",
            ],
          }),
        );

      const code = await ensureCallTypeGrants(
        opts({ apply: true, deployConfirmed: true }),
      );

      expect(code).toBe(1);
    });

    it("is idempotent with the billable revocations in place", async () => {
      await ensureCallTypeGrants(opts({ apply: true, deployConfirmed: true }));
      mockUpdateCallType.mockClear();

      const code = await ensureCallTypeGrants(
        opts({ apply: true, deployConfirmed: true }),
      );

      expect(code).toBe(0);
      expect(mockUpdateCallType).not.toHaveBeenCalled();
    });
  });

  /**
   * `--check` is what makes this script usable by a scheduled job at all.
   *
   * `ensure-webhook-subscription.ts` returned 0 whatever it found for as long
   * as it existed, so nothing ran it; a detector that always exits green
   * detects nothing.
   */
  describe("--check", () => {
    it("exits 2 on drift and writes nothing", async () => {
      const code = await ensureCallTypeGrants(opts({ check: true }));

      expect(code).toBe(DRIFT_EXIT_CODE);
      expect(mockUpdateCallType).not.toHaveBeenCalled();
    });

    it("exits 0 when the live grants already match the desired ones", async () => {
      await ensureCallTypeGrants(opts({ apply: true, deployConfirmed: true }));
      mockUpdateCallType.mockClear();

      const code = await ensureCallTypeGrants(opts({ check: true }));

      expect(code).toBe(0);
      expect(mockUpdateCallType).not.toHaveBeenCalled();
    });

    it("uses an exit code distinct from the unrunnable one", () => {
      // 1 means the script could not evaluate drift (Stream unconfigured, or
      // unreachable) — a failure of the runner. 2 means it read the call type
      // and there really is drift. Both fail the job; a log reader must not have
      // to guess which, because a missing credential and a re-granted meter need
      // completely different responses.
      expect(DRIFT_EXIT_CODE).toBe(2);
    });

    it("does not need a deploy assertion or a target app", async () => {
      // A scheduled job runs this on a runner that has no business asserting
      // either, and a gate on the read path would train operators to pass the
      // flags reflexively until they stopped meaning anything.
      const code = await ensureCallTypeGrants(
        opts({ check: true, deployConfirmed: false, argv: [] }),
      );

      expect(code).toBe(DRIFT_EXIT_CODE);
    });
  });

  describe("the target-app guard", () => {
    it("refuses an --apply that names no target app", async () => {
      const code = await ensureCallTypeGrants(
        opts({ apply: true, deployConfirmed: true, argv: [] }),
      );

      expect(code).toBe(1);
      expect(mockUpdateCallType).not.toHaveBeenCalled();
    });

    it("refuses an --apply that names a DIFFERENT app", async () => {
      // A stale `STREAM_TARGET_APP` in a shell is the case this exists for, and
      // it is why the guard checks the VALUE rather than merely requiring one.
      const code = await ensureCallTypeGrants(
        opts({
          apply: true,
          deployConfirmed: true,
          argv: ["--target-app", "SomebodyElsesTrialApp"],
        }),
      );

      expect(code).toBe(1);
      expect(mockUpdateCallType).not.toHaveBeenCalled();
    });

    it("gates the rollback too", async () => {
      // --restore-user-join is a write. The moment it is reached, people are
      // locked out of every call; that is not the moment to relax the one check
      // that says which account is being written to.
      const code = await ensureCallTypeGrants(
        opts({ apply: true, restore: true, argv: [] }),
      );

      expect(code).toBe(1);
      expect(mockUpdateCallType).not.toHaveBeenCalled();
    });

    it("leaves a dry run alone", async () => {
      const code = await ensureCallTypeGrants(opts({ argv: [] }));

      expect(code).toBe(0);
      expect(mockUpdateCallType).not.toHaveBeenCalled();
    });

    it("runs before the call type is even read", async () => {
      // A refusal that depends on Stream being reachable turns a clear message
      // into a connection error, and one that reads first has already
      // established a session against an app the operator did not name.
      const source = jest
        .requireActual("node:fs")
        .readFileSync(
          join(process.cwd(), "scripts/stream/ensure-call-type-grants.ts"),
          "utf8",
        ) as string;
      const guard = source.indexOf("requireNamedTargetApp({");
      expect(guard).toBeGreaterThan(-1);
      // The first READ, not the first mention of the call — the plans' doc
      // comments and the pre-flight helper both talk about reading call types,
      // and indexing those would assert nothing about order.
      const firstRead = source.indexOf(
        "await client.video.getCallType({ name: plan.name })",
      );
      expect(firstRead).toBeGreaterThan(-1);
      // Source order is not execution order once the body has been split into
      // `applyPlanTo`, so this pins the position of the guard in the ENTRY point
      // and the read in the shared helper. What it actually protects is that
      // neither has been moved below the other's first use.
      expect(guard).toBeLessThan(source.indexOf("for (const plan of PLANS)"));
      expect(firstRead).toBeLessThan(guard);
      expect(source.indexOf("requireDeployConfirmation(opts)")).toBeLessThan(
        guard,
      );
    });
  });
});

/**
 * B3 — `livestream`, where `call_member` is the attendee role and Stream has no
 * host concept.
 *
 * Read off the live type 2026-09-29. `call_member` held `end-call-owner`,
 * `join-backstage-owner`, `start-recording-owner`, `stop-recording-owner`,
 * `update-call-owner`, `update-call-member-role-owner` and
 * `remove-call-member-owner`, so any participant of a webinar could end the
 * broadcast, remove or promote other participants, and start and stop a paid
 * recording. `-owner` scopes the permission to a call you own; the owner is the
 * host; Stream does not know who the host is.
 */
describe("livestream — the owner's powers are the attendee's powers", () => {
  const OWNER_DESTRUCTIVE = [
    "end-call-owner",
    "join-backstage-owner",
    "start-recording-owner",
    "stop-recording-owner",
    "remove-call-member-owner",
    "update-call-member-role-owner",
    "start-broadcasting-owner",
    "stop-broadcasting-owner",
  ];

  it("takes every owner-suffixed destructive grant off call_member", async () => {
    await ensureCallTypeGrants(opts({ apply: true, deployConfirmed: true }));

    for (const perm of OWNER_DESTRUCTIVE) {
      expect(applied("livestream").call_member).not.toContain(perm);
    }
  });

  it("takes them off `user` as well as `call_member`", async () => {
    // On the live type `user` and `call_member` hold nearly the same list, so a
    // revocation applied to one and not the other would leave the same capability
    // reachable under the other name. This is the same mistake the first round of
    // the `default` fix made, with `user` versus `call_member`.
    await ensureCallTypeGrants(opts({ apply: true, deployConfirmed: true }));

    for (const perm of OWNER_DESTRUCTIVE) {
      expect(applied("livestream").user).not.toContain(perm);
    }
    // `guest` is in the revoked-roles list and is NOT a key on this type. A plan
    // that created it would grant a role nobody is ever assigned.
    expect(applied("livestream").guest).toBeUndefined();
  });

  it("filters `anonymous`, which is a key here and NOT on `default`", async () => {
    // One filter for both call types because of this. Inventing the key on
    // `default` would grant a role nobody is ever assigned.
    await ensureCallTypeGrants(opts({ apply: true, deployConfirmed: true }));

    expect(applied("livestream").anonymous).toEqual(["read-call"]);
    expect(Object.keys(applied("default"))).not.toContain("anonymous");
  });

  it("leaves admin and global_admin alone — they ARE the operators", async () => {
    await ensureCallTypeGrants(opts({ apply: true, deployConfirmed: true }));

    const written = applied("livestream");
    expect(written.admin).toContain("end-call");
    expect(written.admin).toContain("start-recording");
    // `global_admin` holds the `-any-team` forms, which the plan never touches.
    expect(written.global_admin).toContain("end-call-any-team");
    expect(written.global_admin).toContain("end-call-owner");
  });

  it("leaves what an attendee legitimately needs to be in the room", async () => {
    await ensureCallTypeGrants(opts({ apply: true, deployConfirmed: true }));

    const member = applied("livestream").call_member;
    for (const perm of [
      "send-audio-owner",
      "send-video-owner",
      "screenshare-owner",
    ]) {
      expect(member).toContain(perm);
    }
  });

  it("also takes the metered noise-cancellation grant", async () => {
    // `harden-unused-call-types.ts` strips the billable STARTERS from this type
    // but never `enable-noise-cancellation-any-team` and never any of the `stop-`
    // half. Two scripts removing overlapping sets is fine — they only remove —
    // and one of them being the SOLE remover of a per-participant-minute grant is
    // not.
    await ensureCallTypeGrants(opts({ apply: true, deployConfirmed: true }));

    expect(applied("livestream").call_member).not.toContain(
      "enable-noise-cancellation-any-team",
    );
  });

  it("fails the run if Stream reads any of them back still granted", async () => {
    // A 200 from updateCallType is not evidence that a revocation was stored, and
    // the one that failed to land here is the one that lets an attendee end a
    // broadcast. `default` is read twice and passes (the stateful mock serves what
    // was written); `livestream` is then read twice with the PRE-write grants, so
    // the read-back finds every revocation still in place.
    mockGetCallType
      .mockResolvedValueOnce(mockCallType({ ...LIVE_GRANTS() }, "default"))
      // `default` verifies clean, so the run continues to `livestream` — which is
      // the point: a per-type failure stops the run, and this case needs livestream
      // to be REACHED for its read-back to be the thing that fails.
      .mockResolvedValueOnce(
        mockCallType({ ...EXPECTED_GRANTS_AFTER() }, "default"),
      )
      .mockResolvedValueOnce(
        mockCallType({ ...LIVE_LIVESTREAM_GRANTS() }, "livestream"),
      )
      .mockResolvedValueOnce(
        mockCallType({ ...LIVE_LIVESTREAM_GRANTS() }, "livestream"),
      );

    const code = await ensureCallTypeGrants(
      opts({ apply: true, deployConfirmed: true }),
    );

    expect(code).toBe(1);
  });

  it("is not touched by --restore-user-join", async () => {
    // The rollback exists for the `default` lockout. There is nothing here to roll
    // back: these revocations carry no availability risk on a type the app does
    // not yet resolve calls against, and handing them back would re-open a hole
    // rather than fix an outage.
    await ensureCallTypeGrants(opts({ apply: true, deployConfirmed: true }));
    mockUpdateCallType.mockClear();

    const code = await ensureCallTypeGrants(
      opts({ apply: true, restore: true }),
    );

    expect(code).toBe(0);
    expect(
      mockUpdateCallType.mock.calls.some((c) => c[0].name === "livestream"),
    ).toBe(false);
  });

  it("does not run the call_member pre-flight against it", async () => {
    // The pre-flight asks whether anybody HOLDS `call_member` on `default`, and
    // `livestream` has no such role to hold. Running it there would refuse a
    // healthy account for a question that does not apply to it.
    await ensureCallTypeGrants(opts({ apply: true, deployConfirmed: true }));
    mockQueryCalls.mockClear();

    await ensureCallTypeGrants(opts({ apply: true, deployConfirmed: true }));

    // Once, not twice.
    expect(mockQueryCalls).toHaveBeenCalledTimes(1);
  });
});

describe("--check across both call types", () => {
  it("exits 2 when either type drifts, and names both", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});

    const code = await ensureCallTypeGrants(opts({ check: true }));

    expect(code).toBe(DRIFT_EXIT_CODE);
    const said = error.mock.calls.map((c) => String(c[0])).join("\n");
    expect(said).toContain("`default`");
    expect(said).toContain("`livestream`");
    error.mockRestore();
  });

  it("exits 0 when both are at target", async () => {
    await ensureCallTypeGrants(opts({ apply: true, deployConfirmed: true }));
    mockUpdateCallType.mockClear();

    const code = await ensureCallTypeGrants(opts({ check: true }));

    expect(code).toBe(0);
    expect(mockUpdateCallType).not.toHaveBeenCalled();
  });
});
