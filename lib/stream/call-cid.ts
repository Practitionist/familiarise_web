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
