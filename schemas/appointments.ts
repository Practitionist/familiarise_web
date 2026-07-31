import { z } from "zod";
import { CancellationReasonEnum } from "./enums";

export const CancelAppointmentSchema = z.object({
  reason: CancellationReasonEnum.optional(),
  notes: z.string().optional(),
});

/**
 * Optional proposal attached to a reschedule.
 *
 * Every field is optional: "release these slots, any time works" stays a valid
 * request, and it is the only shape group events accept. `.passthrough()`
 * because the same body also carries `slotIds`, which the route parses itself.
 */
export const RescheduleProposalSchema = z
  .object({
    proposedSlots: z
      .array(
        z
          .object({
            startsAt: z.string().datetime(),
            endsAt: z.string().datetime(),
          })
          .refine((s) => new Date(s.endsAt) > new Date(s.startsAt), {
            message: "endsAt must be after startsAt",
          }),
      )
      .min(1)
      .max(64)
      .optional(),
    reason: z.string().trim().max(500).optional(),
  })
  .passthrough();
