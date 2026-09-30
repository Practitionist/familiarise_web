/**
 * The Stream room id for a session, in one place.
 *
 * #1554 keyed every call to its `AppointmentOccurrence` row, so both sides of a
 * consultation resolve the same room by deriving the same string from the same
 * id: `occurrence-<occurrenceId>`. #1607 added a second shape for a room the
 * host closed BEFORE the booked start — a call's `ended_at` never clears, so the
 * room has to be rebuilt under a fresh id, `occurrence-<occurrenceId>-r<suffix>`.
 *
 * That second shape is why this module exists at all. The builder used to be a
 * template literal in the middle of `provisionAppointmentMeeting` and there was
 * no reader anywhere, so the moment a rebuild happened the ONLY way to find the
 * room was the bare `streamCallId` on the row — and a URL minted before the
 * rebuild (`/meetings/occurrence-abc`) stopped resolving. The person's tab was
 * still open on a room that no longer had a URL, and `CallEnded`'s "Try to
 * Rejoin" posted back to the dead id.
 *
 * So the id is parsed, not just built. `resolveMeetingAccess` falls back to
 * `appointmentOccurrenceId` — which is `@unique` on `Meeting` and therefore the
 * one identifier that survives a rebuild — whenever the id it was handed names an
 * occurrence. The occurrence id is the durable key; the room id is a
 * presentation of it that can change under the user.
 *
 * Kept dependency-free on purpose: this sits under the join gate, under the
 * mint, and under a Stream call, and none of those should have to import each
 * other to agree on a string.
 */

const ROOM_ID_PREFIX = "occurrence-";

/**
 * A rebuild suffix, base36. `Date.now()` is enough and needs no coordination: the
 * CAS in `provisionAppointmentMeeting` decides which of two racing rebuilds owns
 * the row, and identical suffixes are harmless (the same id, minted twice, is
 * the same `getOrCreate`).
 */
const REBUILD_SUFFIX = /-r[0-9a-z]+$/;

/** The room for an occurrence's first (and usually only) call. */
export function roomIdForOccurrence(occurrenceId: string): string {
  return `${ROOM_ID_PREFIX}${occurrenceId}`;
}

/**
 * A fresh room for an occurrence whose previous call is dead on Stream (#1607).
 *
 * The suffix exists ONLY to clear the old call. Stream refuses to reuse a call
 * id once the call has ended — a participant joining gets the SDK's "ended"
 * screen no matter what the local state says — so the rebuild has to name a call
 * that has never existed.
 */
export function rebuiltRoomIdForOccurrence(
  occurrenceId: string,
  rebuiltAt: Date = new Date(),
): string {
  return `${ROOM_ID_PREFIX}${occurrenceId}-r${rebuiltAt.getTime().toString(36)}`;
}

/**
 * The occurrence a room id names, or null when it names none.
 *
 * Accepts BOTH shapes, which is the point: a URL minted before a rebuild still
 * resolves through this, and so does a room id copied out of the row after one.
 * Returns null rather than throwing for anything unrecognised — the caller is a
 * gate whose job is to answer "no such meeting", not to fail loudly on a
 * malformed URL segment.
 */
export function occurrenceIdFromRoomId(roomId: string): string | null {
  if (!roomId.startsWith(ROOM_ID_PREFIX)) return null;
  const withoutPrefix = roomId.slice(ROOM_ID_PREFIX.length);
  // Strip a rebuild suffix from the RIGHT. Occurrence ids are cuids (alphanumeric),
  // so `-r…` is unambiguous; a left-anchored split would also eat a dash out of
  // any id format that ever gains one.
  const occurrenceId = withoutPrefix.replace(REBUILD_SUFFIX, "");
  return occurrenceId || null;
}
