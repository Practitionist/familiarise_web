import { z } from "zod";

/** Why a host removed an attendee; the attendee and support see the label. */
export const CONDUCT_REMOVAL_REASONS = [
  "DISRUPTIVE",
  "HARASSMENT",
  "SPAM_OR_PROMOTION",
  "OFF_TOPIC",
  "IMPERSONATION",
  "OTHER",
] as const;
export type ConductRemovalReason = (typeof CONDUCT_REMOVAL_REASONS)[number];

export const CONDUCT_REMOVAL_REASON_LABELS: Record<
  ConductRemovalReason,
  string
> = {
  DISRUPTIVE: "Disrupting the session",
  HARASSMENT: "Harassing or abusing others",
  SPAM_OR_PROMOTION: "Spam or unsolicited promotion",
  OFF_TOPIC: "Persistently off-topic",
  IMPERSONATION: "Impersonating someone",
  OTHER: "Other",
};

export const CONDUCT_REMOVAL_NOTE_MAX = 500;

/** The reason and note a host gives. "Other" must say why. */
export const ConductRemovalReasonSchema = z
  .object({
    reason: z.enum(CONDUCT_REMOVAL_REASONS),
    note: z.string().trim().max(CONDUCT_REMOVAL_NOTE_MAX).optional(),
  })
  .refine((v) => v.reason !== "OTHER" || (v.note?.length ?? 0) > 0, {
    path: ["note"],
    message: "Tell the attendee and support why they were removed.",
  });

export type ConductRemovalReasonInput = z.infer<
  typeof ConductRemovalReasonSchema
>;

/** The body of a conduct removal: who, and why. Shared by the roster, chat and in-room routes. */
export const ConductRemovalBodySchema = z
  .object({ targetUserId: z.string().trim().min(1).max(64) })
  .and(ConductRemovalReasonSchema);

export type ConductRemovalBody = z.infer<typeof ConductRemovalBodySchema>;
