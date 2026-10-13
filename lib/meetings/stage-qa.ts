import { z } from "zod";

export const MAX_STAGE_QUESTION_LENGTH = 280;
export const MAX_STAGE_CHAT_LENGTH = 1000;
export const MAX_STAGE_ANSWER_LENGTH = 500;

export const ALLOWED_CHAT_EMOJIS = [
  "👍",
  "❤️",
  "😂",
  "🎉",
  "🙏",
  "👀",
] as const;
export type ChatReactionEmoji = (typeof ALLOWED_CHAT_EMOJIS)[number];
export const chatReactionEmojiSchema = z.enum(ALLOWED_CHAT_EMOJIS);

export const STAGE_QA_EVENT_TYPES = {
  QUESTION_ASKED: "familiarise.qa.question",
  QUESTION_UPDATED: "familiarise.qa.question_updated",
  BANNER_PINNED: "familiarise.qa.pin",
  BANNER_UNPINNED: "familiarise.qa.unpin",
  CHAT_MESSAGE_SENT: "familiarise.chat.message",
  CHAT_MESSAGE_UPDATED: "familiarise.chat.message_updated",
} as const;

export type StageQaEventType =
  (typeof STAGE_QA_EVENT_TYPES)[keyof typeof STAGE_QA_EVENT_TYPES];

/** Retain room Q&A and live chat state in Redis for 24 hours across reloads and late joins. */
export const STAGE_QUESTION_TTL_SECONDS = 60 * 60 * 24;
export const STAGE_QUESTION_TTL_MS = STAGE_QUESTION_TTL_SECONDS * 1000;

export const stageQuestionSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1).max(MAX_STAGE_QUESTION_LENGTH),
  authorId: z.string().min(1),
  authorName: z.string().min(1).max(120),
  authorRole: z.enum(["host", "participant"]),
  createdAt: z.string().min(1),
  upvoterIds: z.array(z.string()).default([]),
  status: z.enum(["open", "answered"]).default("open"),
  answerText: z.string().nullable().optional(),
  answeredByName: z.string().nullable().optional(),
  answeredAt: z.string().nullable().optional(),
});

export type StageQuestion = z.infer<typeof stageQuestionSchema>;

export const stageChatMessageSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1).max(MAX_STAGE_CHAT_LENGTH),
  authorId: z.string().min(1),
  authorName: z.string().min(1).max(120),
  authorRole: z.enum(["host", "participant"]),
  createdAt: z.string().min(1),
  reactions: z.record(z.string(), z.array(z.string())).default({}),
  streamMessageId: z.string().nullable().optional(),
});

export type StageChatMessage = z.infer<typeof stageChatMessageSchema>;

export interface StagePinnedBanner {
  questionId: string;
  text: string;
  authorId: string;
  authorName: string;
  authorRole: "host" | "participant";
  pinnedByUserId: string;
  pinnedAt: string;
}

export const qaActionRequestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("ask"),
    text: z
      .string()
      .trim()
      .min(1, "Question cannot be empty")
      .max(
        MAX_STAGE_QUESTION_LENGTH,
        `Question cannot exceed ${MAX_STAGE_QUESTION_LENGTH} characters`,
      ),
  }),
  z.object({
    action: z.literal("toggle_upvote"),
    questionId: z.string().trim().min(1, "questionId is required"),
  }),
  z.object({
    action: z.literal("answer"),
    questionId: z.string().trim().min(1, "questionId is required"),
    answerText: z
      .string()
      .trim()
      .max(
        MAX_STAGE_ANSWER_LENGTH,
        `Answer cannot exceed ${MAX_STAGE_ANSWER_LENGTH} characters`,
      )
      .optional(),
  }),
  z.object({
    action: z.literal("reopen"),
    questionId: z.string().trim().min(1, "questionId is required"),
  }),
  z.object({
    action: z.literal("pin"),
    questionId: z.string().trim().min(1, "questionId is required"),
  }),
  z.object({
    action: z.literal("unpin"),
  }),
  z.object({
    action: z.literal("send_chat"),
    text: z
      .string()
      .trim()
      .min(1, "Message cannot be empty")
      .max(
        MAX_STAGE_CHAT_LENGTH,
        `Message cannot exceed ${MAX_STAGE_CHAT_LENGTH} characters`,
      ),
  }),
  z.object({
    action: z.literal("toggle_reaction"),
    messageId: z.string().trim().min(1, "messageId is required"),
    emoji: chatReactionEmojiSchema,
  }),
]);

export function stageQuestionRedisKey(
  callId: string,
  questionId: string,
): string {
  return `stage-qa:${callId}:${questionId}`;
}

export function stageQuestionUpvotersKey(
  callId: string,
  questionId: string,
): string {
  return `stage-qa:${callId}:${questionId}:upvoters`;
}

export function stageQuestionIndexRedisKey(callId: string): string {
  return `stage-qa:${callId}:index`;
}

export function stageChatRedisKey(callId: string, messageId: string): string {
  return `stage-chat:${callId}:${messageId}`;
}

export function stageChatReactionKey(
  callId: string,
  messageId: string,
  emoji: string,
): string {
  return `stage-chat:${callId}:${messageId}:rxn:${emoji}`;
}

export function stageChatIndexRedisKey(callId: string): string {
  return `stage-chat:${callId}:index`;
}

function parseRawJson(raw: unknown): unknown {
  if (!raw) return null;
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export function parseStoredStageQuestion(raw: unknown): StageQuestion | null {
  const parsed = stageQuestionSchema.safeParse(parseRawJson(raw));
  return parsed.success ? parsed.data : null;
}

export function parseStoredStageChatMessage(
  raw: unknown,
): StageChatMessage | null {
  const parsed = stageChatMessageSchema.safeParse(parseRawJson(raw));
  return parsed.success ? parsed.data : null;
}

export type QaActionRequest = z.infer<typeof qaActionRequestSchema>;

export function canManageStageBanner(
  role: "host" | "participant" | null | undefined,
): boolean {
  return role === "host";
}

export function normalizeStageBannerFromCustomData(
  custom: Record<string, unknown> | undefined | null,
): StagePinnedBanner | null {
  if (!custom || typeof custom !== "object") return null;
  const raw = custom.activeStageBanner;
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Record<string, unknown>;
  if (
    typeof candidate.questionId !== "string" ||
    typeof candidate.text !== "string" ||
    typeof candidate.authorId !== "string" ||
    typeof candidate.authorName !== "string"
  ) {
    return null;
  }
  return {
    questionId: candidate.questionId,
    text: candidate.text,
    authorId: candidate.authorId,
    authorName: candidate.authorName,
    authorRole: candidate.authorRole === "host" ? "host" : "participant",
    pinnedByUserId:
      typeof candidate.pinnedByUserId === "string"
        ? candidate.pinnedByUserId
        : candidate.authorId,
    pinnedAt:
      typeof candidate.pinnedAt === "string"
        ? candidate.pinnedAt
        : new Date().toISOString(),
  };
}
