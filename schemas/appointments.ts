import { z } from "zod";
import { SCHEDULING_INTERVAL_MS } from "@/lib/appointments/occurrences";
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
          // Exactly one atom per row, not merely "ends after it starts".
          // Auto-confirm hands the allocator `startsAt` alone, and manual mode
          // reads each string as ONE 30-minute start — so a 60-minute row is
          // silently booked as 30.
          //
          // The count check downstream is NOT one row per released session, and
          // that is the point: a released session is a whole `AppointmentOccurrence`
          // covering `slotsPerSession` atoms, while this payload is the atom the
          // allocator consumes, so a 1-hour session is legitimately proposed as
          // two rows. One row = one atom is what lets the allocator be handed a
          // multi-atom block; `proposalCoverageMatches` then compares ATOM
          // COUNTS on both sides, so the two measures are commensurable and the
          // same total coverage is required of both.
          .refine(
            (s) =>
              new Date(s.endsAt).getTime() - new Date(s.startsAt).getTime() ===
              SCHEDULING_INTERVAL_MS,
            { message: "Each proposed time must be exactly one 30-minute slot" },
          ),
      )
      .min(1)
      .max(64)
      .optional(),
    reason: z.string().trim().max(500).optional(),
    // #1065 — how to place the replacement when no concrete time is named.
    // Mirrors the Prisma enums; the allocator SCORES on these and never filters,
    // so an unmeetable preference costs a less-liked time and not the booking.
    preferredTimeOfDay: z.enum(["MORNING", "AFTERNOON", "EVENING"]).optional(),
    preferredDays: z.enum(["WEEKDAYS", "WEEKENDS"]).optional(),
  })
  .passthrough();
