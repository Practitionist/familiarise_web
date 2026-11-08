import { NewsletterSource } from "@prisma/client";
import { z } from "zod";

/** The largest audience the synchronous broadcast sends to; above it a campaign outbox is needed. */
export const BROADCAST_AUDIENCE_LIMIT = 2_000;

export const AUDIENCE_TOO_LARGE_MESSAGE = `This audience is larger than ${BROADCAST_AUDIENCE_LIMIT.toLocaleString("en-IN")} recipients, the most one broadcast sends. Narrow the audience or use a warm-up send; a larger list needs a campaign outbox.`;

export const BROADCAST_ROLES = ["LEARNER", "EXPERT", "NO_ACCOUNT"] as const;

/** Every filter narrows the confirmed list; tags match any of the given ones. */
export const broadcastAudienceSchema = z
  .object({
    sources: z.array(z.nativeEnum(NewsletterSource)).max(10).optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
    role: z.enum(BROADCAST_ROLES).optional(),
  })
  .strict();

export type BroadcastAudience = z.infer<typeof broadcastAudienceSchema>;
