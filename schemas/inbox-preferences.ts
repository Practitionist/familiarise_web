import { z } from "zod";

export const inboxRestrictionsSchema = z.object({
  globalMuted: z.boolean(),
  workflows: z.array(z.object({ id: z.string(), name: z.string() })),
});
export type InboxRestrictions = z.infer<typeof inboxRestrictionsSchema>;
