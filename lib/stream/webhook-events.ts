/**
 * The Stream webhook events this app handles.
 *
 * Deliberately in its OWN dependency-free module. It is imported both by
 * `lib/stream/webhook-dispatch.ts` (which transitively pulls in Prisma, Supabase
 * and `server-only`) and by `scripts/stream/ensure-webhook-subscription.ts`,
 * which runs as a bare tsx process and cannot load any of that.
 *
 * One list, two consumers — so the code that HANDLES an event and the script
 * that SUBSCRIBES to it can never drift.
 */
export const HANDLED_EVENT_TYPES = [
  // Recording events
  "call.recording_started",
  "call.recording_stopped",
  "call.recording_ready",
  "call.recording_failed",
  // Session events
  "call.session_ended",
  "call.ended",
  // Room state only: a join after a rejoinable timeout reopens the room. Attendance comes from Stream's settled record.
  "call.session_participant_joined",
  // #1270 — `user.flagged` / `message.flagged` were removed deliberately, and
  // NOT replaced with a chat hook. Three reasons: the in-app report button
  // already writes the ModerationReport itself via POST /api/report, so the
  // webhook was a second path to the same row that double-counted it; automod
  // is disabled on both channel types, so there are no automated flags to
  // receive; and Stream considers `message.flagged` obsolete under v2
  // moderation, which uses `review_queue_item.*` instead. Subscribing to a
  // deprecated event to feed a path that already works was the wrong trade.
  // Chat unread digest; delivered by the `chat` hook, not the `video` one.
  "user.unread_message_reminder",
] as const;

export type HandledEventType = (typeof HANDLED_EVENT_TYPES)[number];

export function isHandledEventType(t: string): t is HandledEventType {
  return (HANDLED_EVENT_TYPES as readonly string[]).includes(t);
}

export const DESIRED_EVENT_TYPES = [...HANDLED_EVENT_TYPES] as const;

export type DesiredEventType = (typeof DESIRED_EVENT_TYPES)[number];

/** Unsubscribed lifecycle events acknowledged immediately with no DB work if delivered. */
export const IGNORED_EVENT_TYPES = ["call.session_started"] as const;

export type IgnoredEventType = (typeof IGNORED_EVENT_TYPES)[number];

export function isIgnoredEventType(t: string): t is IgnoredEventType {
  return (IGNORED_EVENT_TYPES as readonly string[]).includes(t);
}
