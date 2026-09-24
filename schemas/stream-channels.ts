// schemas/stream-channels.ts
import { z } from "zod";

/** POST /api/stream/channels/create — boundary shape for channel creation.
 *  Semantic checks (required fields, privilege, custom-channel rules) stay
 *  in the route; this rejects wrong types, oversized strings and member
 *  arrays before anything reaches Stream or the logs. `eventType` mirrors
 *  the route's switch exactly — anything else 400s here with a better
 *  message instead of falling into the switch default. */
export const channelCreateSchema = z.object({
  channelType: z.string().min(1).max(64),
  eventId: z.string().max(128).optional(),
  eventType: z
    .enum(["webinar", "class", "consultation", "subscription"])
    .optional(),
  channelName: z.string().max(140).optional(),
  members: z.array(z.string().min(1).max(128)).max(100).optional(),
  createdById: z.string().min(1).max(128),
});

export type ChannelCreateInput = z.infer<typeof channelCreateSchema>;
