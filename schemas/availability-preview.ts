import { z } from "zod";

/** The settings PUT's read-only `?preview=availability` answer: what the new hours would change under live bookings. */
export const availabilitySavePreviewSchema = z.object({
  sessions: z.array(
    z.object({
      appointmentId: z.string(),
      startsAt: z.string(),
      held: z.boolean(),
      planTitle: z.string(),
      learnerName: z.string().nullable(),
    }),
  ),
  customDatesRemoved: z.number().int().nonnegative(),
});

export type AvailabilitySavePreview = z.infer<
  typeof availabilitySavePreviewSchema
>;
