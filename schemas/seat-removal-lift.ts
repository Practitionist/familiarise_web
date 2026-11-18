import { z } from "zod";

import { SeatHistoryReasonSchema } from "@/lib/booking/seat-history";

/** What a lift control sends: the removed attendee. Staff add the audit reason the ops door requires. */
export const SeatLiftBodySchema = z.object({
  userId: z.string().trim().min(1).max(64),
});

/** What both lift doors answer. `rejoinPath` says whether the attendee can register again themselves. */
export const SeatLiftResponseSchema = z.object({
  lifted: z.literal(true),
  rejoinPath: z.enum(["REGISTER", "SUPPORT"]),
  conduct: z.boolean(),
});

export type SeatLiftResponse = z.infer<typeof SeatLiftResponseSchema>;

/** The caller's own seat trail on one event, oldest first. */
export const SeatTrailResponseSchema = z.object({
  steps: z.array(
    z.object({
      reason: SeatHistoryReasonSchema,
      at: z.string().datetime(),
    }),
  ),
});
