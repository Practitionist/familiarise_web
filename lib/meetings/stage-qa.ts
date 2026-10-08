import { z } from "zod";

export const MAX_STAGE_QUESTION_LENGTH = 280;

export const STAGE_QA_EVENT_TYPES = {
  QUESTION_ASKED: "familiarise.qa.question",
  BANNER_PINNED: "familiarise.qa.pin",
  BANNER_UNPINNED: "familiarise.qa.unpin",
} as const;

export type StageQaEventType =
  (typeof STAGE_QA_EVENT_TYPES)[keyof typeof STAGE_QA_EVENT_TYPES];

export const STAGE_QUESTION_TTL_SECONDS = 60 * 60 * 6;

export const stageQuestionSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1).max(MAX_STAGE_QUESTION_LENGTH),
  authorId: z.string().min(1),
  authorName: z.string().min(1).max(120),
  authorRole: z.enum(["host", "participant"]),
  createdAt: z.string().min(1),
});

export type StageQuestion = z.infer<typeof stageQuestionSchema>;

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
    action: z.literal("pin"),
    questionId: z.string().trim().min(1, "questionId is required"),
  }),
  z.object({
    action: z.literal("unpin"),
  }),
]);

export function stageQuestionRedisKey(
  callId: string,
  questionId: string,
): string {
  return `stage-qa:${callId}:${questionId}`;
}

export function parseStoredStageQuestion(raw: unknown): StageQuestion | null {
  if (!raw) return null;
  const candidate =
    typeof raw === "string"
      ? (() => {
          try {
            return JSON.parse(raw) as unknown;
          } catch {
            return null;
          }
        })()
      : raw;
  const parsed = stageQuestionSchema.safeParse(candidate);
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
