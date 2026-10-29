import { z } from "zod";

/**
 * What a reschedule released, recorded on its RescheduleRequest in the release
 * transaction: the durable source of the notice the initiator gave, which
 * survives the released rows being replaced.
 */
export const ReleasedSessionsSchema = z.array(
  z.object({
    ordinal: z.number().int(),
    startsAt: z.string().datetime({ offset: true }),
  }),
);
export type ReleasedSessions = z.infer<typeof ReleasedSessionsSchema>;

export function releasedSessionsOf(
  slots: readonly { ordinal: number; startsAt: Date | string }[],
): ReleasedSessions {
  return slots.map((s) => ({
    ordinal: s.ordinal,
    startsAt: new Date(s.startsAt).toISOString(),
  }));
}
