import { z } from "zod";

/** The settings PUT's read-only `?preview=availability` answer: what the new hours would change under live bookings. */
export const availabilitySavePreviewSchema = z.object({
  sessions: z.array(
    z.object({
      appointmentId: z.string(),
      startsAt: z.string(),
      held: z.boolean(),
      // Optional so a preview from an API version without them still parses.
      planTitle: z.string().optional(),
      learnerName: z.string().nullable().optional(),
    }),
  ),
  customDatesRemoved: z.number().int().nonnegative(),
});

export type AvailabilitySavePreview = z.infer<
  typeof availabilitySavePreviewSchema
>;
