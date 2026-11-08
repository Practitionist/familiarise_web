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
  /** A seat can be bought right now: on sale by checkout's rule and a seat is free. */
  seatAvailable: z.boolean(),
});
export type EventWaitlistAlert = z.infer<typeof EventWaitlistAlertSchema>;

export const EventWaitlistListResponseSchema = z.object({
  data: z.array(EventWaitlistAlertSchema),
});
export type EventWaitlistListResponse = z.infer<
  typeof EventWaitlistListResponseSchema
>;

/** One open slot backup-interest row as `GET /api/scheduling/backup-interest` returns it. */
export const backupInterestEntrySchema = z.object({
  id: z.string(),
  status: z.string(),
  windowStart: z.string(),
  windowEnd: z.string(),
  planKind: z.string().nullable().optional(),
  planId: z.string().nullable().optional(),
  consultantProfileId: z.string(),
  consultantProfile: z
    .object({ user: z.object({ name: z.string().nullable().optional() }) })
    .optional(),
});
export type BackupInterestEntry = z.infer<typeof backupInterestEntrySchema>;

export const BackupInterestListResponseSchema = z.object({
  data: z.array(backupInterestEntrySchema),
});
