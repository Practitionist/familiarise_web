/**
 * @jest-environment node
 */

/**
 * HLS is metered, so the predicate that decides whether a meeting may be put on
 * it is pinned from both directions: what it must REFUSE and what it must
 * allow. Each `it` below names the mistake it prevents, because a policy module
 * this pure has no other evidence — nothing about it fails loudly in staging, it
 * just quietly starts charging somebody for viewer-minutes.
 *
 * The asymmetry that matters: everything unknown reads as OFF. A plan row that
 * never heard of HLS, a query that forgot to select the flag, a malformed
 * `Meeting.callType` — all of them say no. That is deliberately the opposite of
 * how the surrounding code treats an unreadable value, because this one spends
 * money when it is wrong.
 */

import {
  isLivestreamMeeting,
  livestreamEnabledForPlan,
  hlsAvailableFor,
  type LivestreamMeeting,
} from "../../lib/stream/livestream-policy";
import {
  LIVESTREAM_CALL_TYPE,
  STREAM_CALL_TYPE,
} from "../../lib/stream/call-cid";

const LIVES = { callType: LIVESTREAM_CALL_TYPE };
const MESH = { callType: STREAM_CALL_TYPE };

describe("isLivestreamMeeting", () => {
  it("is true only for the persisted broadcast type", () => {
    expect(isLivestreamMeeting(LIVES)).toBe(true);
    expect(isLivestreamMeeting(MESH)).toBe(false);
  });

  it("reads the row, never a derivation the caller could have got wrong", () => {
    // The whole reason `Meeting.callType` exists: a call's type is immutable in
    // Stream, so an appointment-type derivation is wrong on every row that
    // predates the cutover and on any row minted by the wrong arm — neither of
    // which can be repaired afterwards.
    const webinarOnMesh = { callType: STREAM_CALL_TYPE };
    expect(isLivestreamMeeting(webinarOnMesh)).toBe(false);
  });

  it("says no to every value it cannot read", () => {
    // A null or garbage type must not be mistaken for a broadcast. Leaking a
    // presenter-stage UI onto a 1:1 is ugly; mistaking a consultation for a
    // broadcast is how a two-person room would try to publish itself.
    const unreadable: LivestreamMeeting[] = [
      { callType: null },
      { callType: undefined },
      { callType: "" },
      { callType: "audio_room" },
      { callType: "development" },
      { callType: "Livestream-ish" },
    ];
    for (const meeting of [null, undefined, ...unreadable]) {
      expect(isLivestreamMeeting(meeting)).toBe(false);
    }
    // A shape the interface forbids but a hand-built object at runtime can
    // still be — hence the cast, and hence `meeting?.callType` rather than a
    // bare `.callType` in the implementation.
    expect(isLivestreamMeeting({} as LivestreamMeeting)).toBe(false);
  });

  it("tolerates a narrowed select", () => {
    // The interface is the narrowest useful shape precisely so a
    // `select: { callType: true }` is a valid argument rather than a second
    // query.
    const narrow = { callType: "livestream" } as const;
    expect(isLivestreamMeeting(narrow)).toBe(true);
  });
});

describe("livestreamEnabledForPlan", () => {
  it("is true only when the plan says so explicitly", () => {
    expect(livestreamEnabledForPlan({ livestreamEnabled: true })).toBe(true);
    expect(livestreamEnabledForPlan({ livestreamEnabled: false })).toBe(false);
  });

  it("says no when the field was never selected", () => {
    // `undefined` is what a query written before this flag existed produces.
    // Fail-closed is the whole design: this predicate is the one that spends
    // money, so an absent answer is a no, never a guess.
    expect(livestreamEnabledForPlan({})).toBe(false);
    expect(livestreamEnabledForPlan({ livestreamEnabled: undefined })).toBe(
      false,
    );
    expect(livestreamEnabledForPlan({ livestreamEnabled: null })).toBe(false);
  });

  it("says no for a missing plan", () => {
    // Which arm of the four plan models resolved is the caller's problem; a
    // webinar with no resolvable plan is not a free HLS broadcast.
    expect(livestreamEnabledForPlan(null)).toBe(false);
    expect(livestreamEnabledForPlan(undefined)).toBe(false);
  });

  it("does not coerce truthiness — `true` is the only yes", () => {
    // Guards against a future refactor to `Boolean(plan?.livestreamEnabled)`,
    // which would turn the string `"false"` from a hand-edited row into a yes.
    expect(
      livestreamEnabledForPlan({
        livestreamEnabled: "true" as unknown as boolean,
      }),
    ).toBe(false);
    expect(
      livestreamEnabledForPlan({ livestreamEnabled: 1 as unknown as boolean }),
    ).toBe(false);
  });
});

describe("hlsAvailableFor", () => {
  it("requires BOTH halves", () => {
    expect(hlsAvailableFor(LIVES, { livestreamEnabled: true })).toBe(true);
  });

  it("refuses a broadcast room on a plan that did not buy HLS", () => {
    // The headline case: `livestream` is the shape, not the product. A webinar
    // on a plan without the flag is a broadcast that must not fan out.
    expect(hlsAvailableFor(LIVES, { livestreamEnabled: false })).toBe(false);
    expect(hlsAvailableFor(LIVES, {})).toBe(false);
    expect(hlsAvailableFor(LIVES, null)).toBe(false);
  });

  it("refuses a paid plan against a 1:1 meeting", () => {
    // Not symmetric with the case above and deliberately so. A consultation's
    // participants are the counterpart and the buyer; there is no plan of
    // theirs behind that meeting, so a flag on some unrelated plan must not be
    // able to spend HLS on it.
    expect(hlsAvailableFor(MESH, { livestreamEnabled: true })).toBe(false);
    expect(isLivestreamMeeting(MESH)).toBe(false);
  });

  it("refuses an unreadable meeting even on a paid plan", () => {
    for (const meeting of [
      null,
      undefined,
      { callType: null },
      { callType: "development" },
    ]) {
      expect(hlsAvailableFor(meeting, { livestreamEnabled: true })).toBe(false);
    }
  });

  it("agrees with the two halves it is composed from, in all four cells", () => {
    // The conjunction is only worth having if it cannot drift from the halves
    // callers also ask separately — the room UI asks `isLivestreamMeeting` to
    // decide whether to show a stage at all, and this one to decide whether to
    // show a "watch on HLS" affordance. Two answers to the same fact that
    // disagree is the bug.
    for (const meeting of [LIVES, MESH, null]) {
      for (const plan of [
        { livestreamEnabled: true },
        { livestreamEnabled: false },
      ]) {
        expect(hlsAvailableFor(meeting, plan)).toBe(
          isLivestreamMeeting(meeting) && livestreamEnabledForPlan(plan),
        );
      }
    }
  });
});
