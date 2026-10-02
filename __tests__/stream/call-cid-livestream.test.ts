/**
 * @jest-environment node
 */

/**
 * Two call types, and the one place that decides whether a value is one of
 * ours.
 *
 * The failure this file exists to prevent is the shape #1285 was: a CID whose
 * type segment names a call type this app does not mint on, addressed as though
 * it did. That produced a real, correctly-signed `call.recording_ready` whose
 * id half collided with a real Meeting, binding a stranger's recording to
 * someone else's appointment.
 *
 * So the invariants are pinned from both ends:
 *
 *   - the existing exports must NOT move. `STREAM_CALL_TYPE` is `default` and
 *     thirty-odd call sites depend on it; `callTypeFromCid` returns `default` for
 *     a separator-less value because a bare id carries no type and every writer
 *     that stores one means `default`.
 *   - and `normalizeCallType` must be TOTAL. It is the only thing standing
 *     between a malformed persisted `Meeting.callType` and an unowned CID, so
 *     every input — including the ones that are not strings at all — has to come
 *     back as a type this app owns.
 */

import {
  ALL_CALL_TYPES,
  LIVESTREAM_CALL_TYPE,
  STREAM_CALL_TYPE,
  callTypeFromCid,
  isKnownCallType,
  normalizeCallType,
  toCallCid,
  toCallId,
} from "../../lib/stream/call-cid";

describe("the two call types", () => {
  it("keeps the 1:1 type exactly where thirty-odd call sites expect it", () => {
    // Not a style preference: `default` is hardcoded across join/end routes,
    // the recording services, the orphan reconciler and the webhook guard. A
    // rename here is a total video outage, not a migration.
    expect(STREAM_CALL_TYPE).toBe("default");
  });

  it("names livestream by Stream's own spelling", () => {
    // `default` and `livestream` are Stream BUILT-INS; a bespoke name would
    // not get HLS egress.
    expect(LIVESTREAM_CALL_TYPE).toBe("livestream");
  });

  it("lists exactly the two, with the 1:1 first", () => {
    // Pinned as an ordered list, not a set, because the order carries meaning
    // for anything that iterates it: `default` is both the 1:1 type and the
    // type `normalizeCallType` falls back to, so a consumer that takes the
    // first match must get the conservative one.
    expect([...ALL_CALL_TYPES]).toEqual(["default", "livestream"]);
  });
});

describe("isKnownCallType", () => {
  it("accepts both owned types", () => {
    expect(isKnownCallType("default")).toBe(true);
    expect(isKnownCallType("livestream")).toBe(true);
  });

  it("rejects the other Stream built-ins this app does not mint on", () => {
    // `harden-unused-call-types.ts` strips reach from all three. If one of them
    // ever became "known" here, a CID on it would pass a guard that exists
    // precisely to keep it out.
    for (const type of ["audio_room", "development"]) {
      expect(isKnownCallType(type)).toBe(false);
    }
  });

  it("is strict about case and surrounding space", () => {
    // Deliberately stricter than `normalizeCallType`. This answers "did Stream
    // hand us a type from our own vocabulary", and a loose answer there is the
    // bug; the lenient one lives at the boundary where a hand-edited row lands.
    expect(isKnownCallType("Livestream")).toBe(false);
    expect(isKnownCallType(" livestream")).toBe(false);
  });

  it("rejects non-strings without throwing", () => {
    // The persisted column is a `String` today, but the value reaching this
    // from a webhook body is untyped, and a guard that throws on `null` is a
    // guard that fails open on the input it was written for.
    for (const value of [null, undefined, 0, 1, {}, [], true, ""]) {
      expect(isKnownCallType(value)).toBe(false);
    }
  });
});

describe("normalizeCallType", () => {
  it("passes both owned types through unchanged", () => {
    expect(normalizeCallType("default")).toBe("default");
    expect(normalizeCallType("livestream")).toBe("livestream");
  });

  it("coerces a foreign type to the type this app owns", () => {
    // The load-bearing case. A CID built as `audio_room:occurrence-x` must not
    // survive normalisation into something we would then address; the answer
    // has to be a type our calls actually exist on.
    for (const foreign of ["audio_room", "development", "not_a_type"]) {
      expect(normalizeCallType(foreign)).toBe(STREAM_CALL_TYPE);
    }
  });

  it("recovers a broadcast whose value was mis-cased or padded", () => {
    // The forgiving direction is right for this one: `"Livestream"` is a row
    // whose author plainly meant the broadcast type, and coercing it to
    // `default` would silently downgrade a webinar to a full-mesh call — while
    // `default` is the answer we give for something we cannot read at all.
    expect(normalizeCallType("Livestream")).toBe("livestream");
    expect(normalizeCallType("LIVESTREAM")).toBe("livestream");
    expect(normalizeCallType("  livestream  ")).toBe("livestream");
    expect(normalizeCallType(" Default ")).toBe("default");
  });

  it("is total — nothing escapes as an unowned type", () => {
    // Pinned as a set rather than case by case because the point is the
    // FUNCTION's contract, not these particular values: no input may produce a
    // type outside ALL_CALL_TYPES. `Meeting.callType` is a `String` with a
    // default and therefore cannot be NULL today, and that is exactly the sort
    // of guarantee a later migration drops without anyone re-reading this.
    const hostile: unknown[] = [
      null,
      undefined,
      "",
      "   ",
      ":",
      ":::",
      "default:livestream",
      "default:",
      "livestream:occurrence-abc",
      "DeFaUlT",
      "default\nlivestream",
      0,
      1,
      false,
      true,
      {},
      [],
      { callType: "livestream" },
      Number.NaN,
    ];
    for (const value of hostile) {
      const result = normalizeCallType(value as string | null | undefined);
      expect(isKnownCallType(result)).toBe(true);
    }
  });

  it("does not read a type out of a CID — a CID is not a persisted value", () => {
    // Deliberate. `normalizeCallType` coerces a PERSISTED value; extracting the
    // type segment of a CID is `callTypeFromCid`'s job and has different rules
    // for a separator-less string. Routing a CID through the wrong one would
    // silently strip the prefix and address a different call.
    expect(normalizeCallType("livestream:occurrence-abc")).toBe(
      STREAM_CALL_TYPE,
    );
  });
});

describe("the pre-existing exports still behave exactly as they did", () => {
  it("callTypeFromCid reads the type segment", () => {
    expect(callTypeFromCid("default:occurrence-abc")).toBe("default");
    expect(callTypeFromCid("livestream:occurrence-abc")).toBe("livestream");
  });

  it("callTypeFromCid answers `default` for a bare id", () => {
    // Preserved deliberately. `Meeting.streamCallId` stores the BARE id and
    // Stream webhooks send the cid, so this input is the common one — and a
    // stored value with no separator means the 1:1 type, not "unknown".
    expect(callTypeFromCid("occurrence-abc")).toBe(STREAM_CALL_TYPE);
  });

  it("callTypeFromCid answers `default` for an empty type segment", () => {
    // `:occurrence-abc` — the pre-existing `|| STREAM_CALL_TYPE` fallback.
    expect(callTypeFromCid(":occurrence-abc")).toBe(STREAM_CALL_TYPE);
  });

  it("callTypeFromCid does NOT normalise — it reports what it was given", () => {
    // It stays a faithful reader. Callers use it to REJECT a foreign type
    // (`isOwnCallType`), and a function that quietly rewrote an unrecognised
    // type to `default` would make that check unfalsifiable.
    expect(callTypeFromCid("audio_room:occurrence-abc")).toBe("audio_room");
    expect(isKnownCallType(callTypeFromCid("audio_room:occurrence-abc"))).toBe(
      false,
    );
  });

  it("toCallCid round-trips through both types", () => {
    for (const type of ALL_CALL_TYPES) {
      const cid = toCallCid("occurrence-abc", type);
      expect(cid).toBe(`${type}:occurrence-abc`);
      expect(callTypeFromCid(cid)).toBe(type);
      expect(toCallId(cid)).toBe("occurrence-abc");
    }
  });

  it("toCallCid defaults to the 1:1 type and stays idempotent", () => {
    // Idempotence is what makes it safe to apply to a value of unknown
    // provenance — four sites relied on that before #1134 unified them.
    expect(toCallCid("occurrence-abc")).toBe("default:occurrence-abc");
    expect(toCallCid("default:occurrence-abc")).toBe("default:occurrence-abc");
    expect(toCallCid("livestream:occurrence-abc")).toBe(
      "livestream:occurrence-abc",
    );
  });

  it("toCallId accepts a bare id unchanged, on both types' rooms", () => {
    // The file header's argument for `toCallId` existing: a bare value is
    // returned as-is rather than being assumed to be a cid. `Meeting.streamCallId`
    // stores the bare id and webhooks send the cid, so BOTH arrive.
    expect(toCallId("occurrence-abc")).toBe("occurrence-abc");
    expect(toCallId("livestream:occurrence-abc")).toBe("occurrence-abc");
  });
});
