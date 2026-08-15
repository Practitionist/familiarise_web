/**
 * The Stream webhook events this app handles.
 *
 * Deliberately in its OWN dependency-free module. It is imported both by
 * `lib/stream/webhook-dispatch.ts` (which transitively pulls in Prisma, Supabase
 * and `server-only`) and by `scripts/stream/ensure-webhook-subscription.ts`,
 * which runs as a bare tsx process and cannot load any of that.
 *
 * One list, two consumers — so the code that HANDLES an event and the script
 * that SUBSCRIBES to it can never drift. #1134 found them four apart: the live
 * hook carried six event types while the dispatcher handled ten, so
 * MeetingAttendance and every chat moderation flag were dead code.
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
  // STR-4 — per-attendee presence (unblocks #471 no-show / #472 overrun)
  "call.session_participant_joined",
  "call.session_participant_left",
  // Chat moderation events
  "user.flagged",
  "message.flagged",
] as const;

export type HandledEventType = (typeof HANDLED_EVENT_TYPES)[number];
