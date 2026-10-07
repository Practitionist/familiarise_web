import { z } from "zod";

export const MAX_STAGE_QUESTION_LENGTH = 280;

export const STAGE_QA_EVENT_TYPES = {
  QUESTION_ASKED: "familiarise.qa.question",
  BANNER_PINNED: "familiarise.qa.pin",
  BANNER_UNPINNED: "familiarise.qa.unpin",
} as const;

export type StageQaEventType =
  (typeof STAGE_QA_EVENT_TYPES)[keyof typeof STAGE_QA_EVENT_TYPES];

export interface StageQuestion {
  id: string;
  text: string;
  authorId: string;
  authorName: string;
  authorRole: "host" | "participant";
  createdAt: string;
}

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
    text: z
      .string()
      .trim()
      .min(1, "Banner text cannot be empty")
      .max(
        MAX_STAGE_QUESTION_LENGTH,
        `Banner text cannot exceed ${MAX_STAGE_QUESTION_LENGTH} characters`,
      ),
    authorId: z.string().trim().min(1, "authorId is required"),
    authorName: z.string().trim().min(1, "authorName is required").max(120),
    authorRole: z.enum(["host", "participant"]).default("participant"),
  }),
  z.object({
    action: z.literal("unpin"),
  }),
]);

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
