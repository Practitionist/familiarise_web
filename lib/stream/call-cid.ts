/**
 * #1134 P1-5 — one definition of the Stream call cid, because there were four.
 *
 * A Stream call is addressed as `<type>:<id>`. Three sites in recording-service
 * split on `:` defensively, the session and recording webhook handlers each did
 * their own `call_cid.split(":")[1] || call_cid`, and the orphan reconciler
 * passed the stored value straight through — so a prefixed value 404'd there and
 * was silently recorded as an UNVERIFIED completion.
 *
 * That paragraph used to end "All of them go through here now", and it was
 * FALSE: eight sites in `session-handlers.ts` and `recording-handlers.ts` still
 * had their own copy of the split, which is how the two ends of the same webhook
 * could disagree about which call an event was about. They do not any more. If
 * you are adding a site that reads a `call_cid`, import `toCallId` — do not
 * inline a split, and do not assume the value is already bare. `toCallId` is
 * idempotent, so applying it to a value of unknown provenance is free.
 *
 * `Meeting.streamCallId` stores the BARE id (e.g. `occurrence-<occurrenceId>`),
 * never the cid. Stream webhooks send the cid. Keep the two straight.
 *
 * ## There are two call types now, and only one of them can be chosen
 *
 * `livestream` was added for webinars and classes; `default` stays for
 * consultations, subscriptions and trials. Because a Stream call's type is
 * immutable, that split is NEW calls only — there is no migration and there
 * will never be one, so any code that reads a call type must resolve it from
 * the row (`Meeting.callType`) rather than from the appointment type, and any
 * code that WRITES one must get it right the first time.
 */

/**
 * The call type every appointment call uses.
 *
 * Deliberately still Stream's built-in `default` rather than a bespoke type: a
 * call's type is immutable once created, so a new type would only protect calls
 * made after the cutover and leave every existing one permissive forever.
 * Hardening `default`'s grants in place covers both (#1134 P0-1). Adding other
 * types later — a livestream, say — is unaffected by this choice.
 */
export const STREAM_CALL_TYPE = "default";

/**
 * The broadcast call type, for webinars and classes.
 *
 * `livestream` is Stream's built-in, and it is the ONLY way to get HLS: a
 * `default` call has no egress to fan out from, so `start-hls` is not merely
 * refused there, it is meaningless. Stream cannot move a call between types, so
 * this applies to calls minted from here on and never to an existing one — a
 * `default` call stays full mesh forever.
 *
 * The destructive grants this type ships with are another PR's problem:
 * `scripts/stream/ensure-call-type-grants.ts` revokes the `-owner` variants of
 * `end-call` / `update-call` / `kick-user` from `user` and `call_member`, which
 * matters here because there is no host role on a broadcast type — every
 * attendee is `call_member`. Do not re-derive those grants; read that script.
 */
export const LIVESTREAM_CALL_TYPE = "livestream";

/**
 * Every call type this app mints calls against, in one list.
 *
 * The single answer to "is this CID ours?", for callers that must accept both
 * rather than one — a webhook guard that wants every type this product knows,
 * as opposed to `isOwnCallType` in `webhook-dispatch.ts`, which wants the one
 * type a 1:1 is minted on. Two different questions, two different lists; keep
 * them apart.
 */
export const ALL_CALL_TYPES = [STREAM_CALL_TYPE, LIVESTREAM_CALL_TYPE] as const;

export type KnownCallType = (typeof ALL_CALL_TYPES)[number];

/** Exact-match test against the owned set. Case- and whitespace-SENSITIVE. */
export function isKnownCallType(value: unknown): value is KnownCallType {
  return (ALL_CALL_TYPES as readonly unknown[]).includes(value);
}

/**
 * Coerce anything to a call type this app owns, defaulting to
 * {@link STREAM_CALL_TYPE}.
 *
 * This is the fail-safe door for a value of unknown provenance: a persisted
 * `Meeting.callType` edited by hand, a Stream-supplied type from a CID built by
 * someone else, a config string. None of those may produce an UNOWNED cid —
 * `livestream:occurrence-x` resolving against a type this app does not mint on
 * is how #1285 happened, and an unrecognised-but-plausible type from a typo
 * reaches the same place without anybody noticing. Defaulting to `default`
 * resolves against a call this app really does own, so the worst a malformed
 * value can do is degrade a broadcast to a full-mesh call.
 *
 * Case- and whitespace-insensitive on the way in, because that is the cheap
 * half of the typo and the forgiving one is right: `"Livestream"` is a row
 * whose author plainly meant the broadcast type, and coercing it to `default`
 * would silently downgrade a webinar. `isKnownCallType` stays strict — it
 * exists to answer "did Stream hand us a type from our own vocabulary", and a
 * loose answer there is exactly the bug.
 */
export function normalizeCallType(
  value: string | null | undefined,
): KnownCallType {
  const candidate = typeof value === "string" ? value.trim().toLowerCase() : "";
  return isKnownCallType(candidate) ? candidate : STREAM_CALL_TYPE;
}

/** Bare call id → cid. Idempotent: an already-prefixed value is returned as-is. */
export function toCallCid(
  callId: string,
  type: string = STREAM_CALL_TYPE,
): string {
  return callId.includes(":") ? callId : `${type}:${callId}`;
}

/**
 * cid → bare call id. Accepts a bare id unchanged, so it is safe to apply to a
 * value of unknown provenance.
 */
export function toCallId(callCidOrId: string): string {
  const separator = callCidOrId.indexOf(":");
  return separator === -1
    ? callCidOrId
    : callCidOrId.slice(separator + 1) || callCidOrId;
}

/** cid → call type, falling back to the app default for a bare id. */
export function callTypeFromCid(callCidOrId: string): string {
  const separator = callCidOrId.indexOf(":");
  return separator === -1
    ? STREAM_CALL_TYPE
    : callCidOrId.slice(0, separator) || STREAM_CALL_TYPE;
}
