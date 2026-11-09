import { z } from "zod";
import type { ParticipantRemovalReason } from "@prisma/client";

/** A type-only Prisma import: this module is bundled into the in-call and roster UIs. */
export const PARTICIPANT_REMOVAL_REASONS = [
  "DISRUPTIVE",
  "HARASSMENT",
  "SPAM_OR_PROMOTION",
  "OFF_TOPIC",
  "IMPERSONATION",
  "OTHER",
] as const satisfies readonly ParticipantRemovalReason[];

export const PARTICIPANT_REMOVAL_REASON_LABELS: Record<
  ParticipantRemovalReason,
  string
> = {
  DISRUPTIVE: "Disrupting the session",
  HARASSMENT: "Harassing or abusing others",
  SPAM_OR_PROMOTION: "Spam or unsolicited promotion",
  OFF_TOPIC: "Persistently off-topic",
  IMPERSONATION: "Impersonating someone",
  OTHER: "Other",
};

export const PARTICIPANT_REMOVAL_NOTE_MAX = 500;

/** What a host sends to remove an attendee for conduct. "Other" must say why. */
export const ParticipantRemovalRequestSchema = z
  .object({
    reason: z.enum(PARTICIPANT_REMOVAL_REASONS),
    note: z.string().trim().max(PARTICIPANT_REMOVAL_NOTE_MAX).optional(),
  })
  .refine((v) => v.reason !== "OTHER" || (v.note?.length ?? 0) > 0, {
    path: ["note"],
    message: "Tell the attendee and support why they were removed.",
  });

export type ParticipantRemovalRequest = z.infer<
  typeof ParticipantRemovalRequestSchema
>;

/** The body of a conduct removal: who, and the reason. Shared by the roster and in-call routes. */
export const ConductRemovalBodySchema = z
  .object({ targetUserId: z.string().trim().min(1).max(64) })
  .and(ParticipantRemovalRequestSchema);
