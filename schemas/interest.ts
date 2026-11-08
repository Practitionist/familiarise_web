import { z } from "zod";

/** One open appointment-waitlist row as `GET /api/scheduling/event-waitlist` returns it. */
export const EventWaitlistAlertSchema = z.object({
  kind: z.enum(["WEBINAR", "CLASS"]),
  eventId: z.string(),
  planId: z.string(),
  planTitle: z.string(),
  /** The next live session after now, ISO; null when none is left. */
  nextSessionAt: z.string().datetime().nullable(),
  status: z.enum(["WAITING", "NOTIFIED"]),
  notifiedAt: z.string().datetime().nullable(),
  checkoutHref: z.string(),
  /** A seat can be bought now by checkout's rule; the row expires on the next sweep otherwise. */
  onSale: z.boolean(),
});
export type EventWaitlistAlert = z.infer<typeof EventWaitlistAlertSchema>;

export const EventWaitlistListResponseSchema = z.object({
  data: z.array(EventWaitlistAlertSchema),
});
export type EventWaitlistListResponse = z.infer<
  typeof EventWaitlistListResponseSchema
>;
