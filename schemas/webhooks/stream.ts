import { z } from "zod";
import type { HandledEventType } from "@/lib/stream/webhook-events";

/**
 * Stream webhook payload schemas. Zod objects strip undeclared keys, so what a
 * schema declares is exactly what the handlers can read and what the stored
 * `WebhookEvent.payload` keeps: no profile name, image or custom data survives.
 */

// call_cid is optional because chat moderation events don't include it.
export const streamBaseEventSchema = z.object({
  type: z.string(),
  call_cid: z.string().optional(),
  created_at: z.string(),
});

const streamCallBaseEventSchema = z.object({
  type: z.string(),
  call_cid: z.string(),
  created_at: z.string(),
});

export const streamRecordingReadySchema = streamCallBaseEventSchema.extend({
  type: z.literal("call.recording_ready"),
  call_recording: z.object({
    filename: z.string(),
    url: z.string(),
    start_time: z.string(),
    end_time: z.string(),
    session_id: z.string().optional(),
  }),
});

// Stream sends no error detail on a failed recording, only which egress failed.
export const streamRecordingFailedSchema = streamCallBaseEventSchema.extend({
  type: z.literal("call.recording_failed"),
  egress_id: z.string(),
  recording_type: z.string(),
});

const streamRecordingStartedSchema = streamCallBaseEventSchema.extend({
  type: z.literal("call.recording_started"),
  user: z.object({ id: z.string() }).optional(),
});

const streamRecordingStoppedSchema = streamCallBaseEventSchema.extend({
  type: z.literal("call.recording_stopped"),
});

const streamSessionEndedSchema = streamCallBaseEventSchema.extend({
  type: z.literal("call.session_ended"),
  session_id: z.string().optional(),
  call: z
    .object({
      id: z.string(),
      type: z.string(),
      created_by_user_id: z.string().optional(),
    })
    .optional(),
});

export const streamCallEndedSchema = streamCallBaseEventSchema.extend({
  type: z.literal("call.ended"),
  call: z
    .object({
      id: z.string(),
      type: z.string(),
      created_by_user_id: z.string().nullish(),
      ended_by_user_id: z.string().nullish(),
      session: z.object({ id: z.string() }).nullish(),
    })
    .optional(),
  // Stream sends `user: null` when the call ends without an acting user (server end, timeout).
  user: z.object({ id: z.string() }).nullish(),
  reason: z.string().nullish(),
  ended_by_user_id: z.string().nullish(),
});

// Handlers need only the app user id (participant.user.id) and the session id.
const streamParticipantSchema = z.object({
  user: z.object({ id: z.string() }),
  user_session_id: z.string().optional(),
  role: z.string().optional(),
});

const streamSessionParticipantJoinedSchema = streamCallBaseEventSchema.extend({
  type: z.literal("call.session_participant_joined"),
  session_id: z.string(),
  participant: streamParticipantSchema,
});

const streamSessionParticipantLeftSchema = streamCallBaseEventSchema.extend({
  type: z.literal("call.session_participant_left"),
  session_id: z.string(),
  duration_seconds: z.number().optional(),
  participant: streamParticipantSchema,
});

// Message `text` is deliberately undeclared, so no message content is ever parsed or stored.
const streamReminderMessageSchema = z.object({
  type: z.string(),
  user: z.object({ id: z.string() }).optional(),
});

const streamReminderChannelSchema = z.object({
  channel: z.object({
    id: z.string().min(1),
    type: z.string().min(1),
    cid: z.string().min(1),
    members: z.array(z.object({ user_id: z.string().min(1) })),
  }),
  /** The channel's last five messages, newest first. */
  messages: z.array(streamReminderMessageSchema).default([]),
});

export const streamUnreadMessageReminderSchema = z.object({
  type: z.literal("user.unread_message_reminder"),
  created_at: z.string(),
  user: z.object({ id: z.string().min(1) }),
  /** Keyed by channel cid; Stream sends at most ten. */
  channels: z.record(z.string(), streamReminderChannelSchema),
});

export type StreamUnreadMessageReminderEvent = z.infer<
  typeof streamUnreadMessageReminderSchema
>;

/** One schema per handled event type; `satisfies` makes a missing row a compile error. */
export const STREAM_EVENT_SCHEMAS = {
  "call.recording_started": streamRecordingStartedSchema,
  "call.recording_stopped": streamRecordingStoppedSchema,
  "call.recording_ready": streamRecordingReadySchema,
  "call.recording_failed": streamRecordingFailedSchema,
  "call.session_ended": streamSessionEndedSchema,
  "call.ended": streamCallEndedSchema,
  "call.session_participant_joined": streamSessionParticipantJoinedSchema,
  "call.session_participant_left": streamSessionParticipantLeftSchema,
  "user.unread_message_reminder": streamUnreadMessageReminderSchema,
} satisfies Record<HandledEventType, z.ZodTypeAny>;
