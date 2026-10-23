import { z } from "zod";

/** Wire shapes for case-linked booking chat access (server routes and the staff panel). */

export const SUPPORT_CHAT_ACCESS_KINDS = ["READ", "INTERVENE"] as const;
export const SUPPORT_CHAT_ACCESS_BASES = [
  "OPEN_CASE",
  "EVIDENCE_OVERDUE",
  "SAFETY",
  "FRAUD_OR_SCAM",
] as const;
export const SUPPORT_CHAT_INTERVENTION_BASES = [
  "EVIDENCE_OVERDUE",
  "SAFETY",
  "FRAUD_OR_SCAM",
] as const;
export const SUPPORT_CHAT_END_REASONS = [
  "EXPIRED",
  "CASE_RESOLVED",
  "ENDED_BY_STAFF",
  "CHANNEL_GONE",
] as const;
/** Intervention time-boxes in hours; there is no extension, staff re-grant. */
export const SUPPORT_CHAT_INTERVENTION_HOURS = [24, 72, 168] as const;
export const SUPPORT_CHAT_DEFAULT_INTERVENTION_HOURS = 72;
export const SUPPORT_CHAT_READ_HOURS = 24;
export const SUPPORT_CHAT_MESSAGE_MAX = 2000;

export type SupportChatInterventionBasis =
  (typeof SUPPORT_CHAT_INTERVENTION_BASES)[number];

const id = z.string().min(1).max(128);
const targets = z.array(id).max(20).optional();

export const OpenChatReadBody = z.object({
  action: z.literal("OPEN_READ"),
  /** Group channels: the attendees the case is about, validated as live participants. */
  targetUserIds: targets,
  withholdNotice: z.boolean().optional(),
});

export const StartInterventionBody = z.object({
  action: z.literal("START_INTERVENTION"),
  basis: z.enum(SUPPORT_CHAT_INTERVENTION_BASES),
  durationHours: z.union([z.literal(24), z.literal(72), z.literal(168)]),
  targetUserIds: targets,
  withholdNotice: z.boolean().optional(),
});

export const EndChatGrantBody = z.object({
  action: z.enum(["END_READ", "END_INTERVENTION"]),
  grantId: id,
});

/** The route's dispatch parse; each door re-parses its own body with `reason`. */
export const SupportChatActionBody = z.discriminatedUnion("action", [
  OpenChatReadBody,
  StartInterventionBody,
  EndChatGrantBody.extend({ action: z.literal("END_READ") }),
  EndChatGrantBody.extend({ action: z.literal("END_INTERVENTION") }),
]);

export const PostSupportMessageBody = z.object({
  grantId: id,
  clientActionId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,40}$/, "Invalid client action id"),
  text: z.string().trim().min(1).max(SUPPORT_CHAT_MESSAGE_MAX),
});

export const TranscriptQuery = z.object({
  grantId: id,
  /** Stream message id to page before; omitted for the newest page. */
  before: z.string().min(1).max(255).optional(),
});

export const ChatRefusalSchema = z.object({
  code: z.string(),
  message: z.string(),
});

export const ChatPartySchema = z.object({
  userId: z.string(),
  name: z.string(),
  role: z.enum(["REPORTER", "DELIVERING", "ATTENDEE"]),
});

export const ChatGrantSchema = z.object({
  id: z.string(),
  kind: z.enum(SUPPORT_CHAT_ACCESS_KINDS),
  basis: z.enum(SUPPORT_CHAT_ACCESS_BASES),
  grantedById: z.string(),
  grantedByName: z.string().nullable(),
  mine: z.boolean(),
  live: z.boolean(),
  windowStart: z.string(),
  expiresAt: z.string(),
  endedAt: z.string().nullable(),
  endReason: z.enum(SUPPORT_CHAT_END_REASONS).nullable(),
  streamJoinedAt: z.string().nullable(),
  streamLeftAt: z.string().nullable(),
  withholdNotice: z.boolean(),
  createdAt: z.string(),
});

export const ChatStatusSchema = z.object({
  /** null when the case can't be read at all; `read.code` says why. */
  channel: z
    .object({
      type: z.enum(["messaging", "team"]),
      kind: z.enum(["DM", "GROUP"]),
    })
    .nullable(),
  read: z.union([
    z.object({ ok: z.literal(true) }),
    z.object({ ok: z.literal(false) }).merge(ChatRefusalSchema),
  ]),
  intervene: z.union([
    z.object({
      ok: z.literal(true),
      /** Bases the server already verified; SAFETY and FRAUD_OR_SCAM may also be asserted. */
      verifiedBases: z.array(z.enum(SUPPORT_CHAT_INTERVENTION_BASES)),
    }),
    z.object({ ok: z.literal(false) }).merge(ChatRefusalSchema),
  ]),
  /** Group channels where the reporter isn't an attendee need staff-picked targets. */
  requiresTargets: z.boolean(),
  parties: z.array(ChatPartySchema),
  grants: z.array(ChatGrantSchema),
  canIntervene: z.boolean(),
});

export const TranscriptMessageSchema = z.object({
  id: z.string(),
  userId: z.string().nullable(),
  userName: z.string().nullable(),
  role: z.enum(["reporter", "target", "party", "support", "system"]),
  text: z.string(),
  attachments: z.array(z.object({ type: z.string(), name: z.string() })),
  createdAt: z.string(),
  deletedBySender: z.boolean(),
});

export const TranscriptPageSchema = z.object({
  messages: z.array(TranscriptMessageSchema),
  /** Pass as `before` to load earlier messages; null at the window start. */
  nextBefore: z.string().nullable(),
  windowStart: z.string(),
});

export type ChatStatus = z.infer<typeof ChatStatusSchema>;
export type ChatGrant = z.infer<typeof ChatGrantSchema>;
export type ChatParty = z.infer<typeof ChatPartySchema>;
export type TranscriptMessage = z.infer<typeof TranscriptMessageSchema>;
export type TranscriptPage = z.infer<typeof TranscriptPageSchema>;
