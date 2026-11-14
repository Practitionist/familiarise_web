import { z } from "zod";
import { SCHEDULING_INTERVAL_MS } from "@/lib/appointments/occurrences";
import { CancellationReasonEnum } from "./enums";

export const CancelAppointmentSchema = z.object({
  reason: CancellationReasonEnum.optional(),
  notes: z.string().optional(),
  /** The refund the dialog showed; a different server quote answers 409. Optional for N-1 clients. */
  expectedRefundPaise: z.number().int().nonnegative().optional(),
  /** The credits rail's all-or-nothing answer the dialog showed. */
  expectedCreditRestoresInFull: z.boolean().optional(),
  /** False when the dialog showed an unpaid booking; a capture since then answers 409. */
  expectedPaid: z.boolean().optional(),
});

/** The 409 a cancel answers when its quote no longer matches the one the dialog showed. */
export const RefundQuoteChangedSchema = z.object({
  code: z.literal("REFUND_QUOTE_CHANGED"),
  refundPaise: z.number(),
  refundPct: z.number(),
  creditRestoresInFull: z.boolean(),
});
export type RefundQuoteChanged = z.infer<typeof RefundQuoteChangedSchema>;

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
            {
              message: "Each proposed time must be exactly one 30-minute slot",
            },
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

/** The counterparty's answer to an open reschedule proposal. */
export const RescheduleRespondSchema = z.object({
  action: z.enum(["accept", "decline"]),
});

/** The sessions a per-session subscription reschedule names; `slotId` is the legacy single form. */
export const RescheduleSlotIdsSchema = z
  .object({
    slotIds: z.array(z.string().min(1)).max(64).optional(),
    slotId: z.string().min(1).optional(),
  })
  .passthrough();

/** Returning one subscription session to the plan; the path names the session, so the body carries nothing. */
export const SessionReturnSchema = z.object({}).strict();

/** A free rebook of an incident-voided 1:1: the new start; its length is the voided session's. */
export const IncidentRebookSchema = z
  .object({ startsAt: z.string().datetime({ offset: true }) })
  .strict();

/** Bringing an incident refund forward; the path names the remedy, so the body carries nothing. */
export const IncidentRefundNowSchema = z.object({}).strict();

/** One voided 1:1 still open to a free rebook, as the consultee banner reads it. */
export const OpenIncidentRemedySchema = z.object({
  id: z.string(),
  appointmentId: z.string(),
  sessionStartsAt: z.string(),
  sessionEndsAt: z.string(),
  dueAt: z.string(),
  title: z.string(),
  expertName: z.string().nullable(),
  /** The rail the refund returns on, so the banner names where the money goes. */
  fundingRail: z.enum(["GATEWAY", "INTERNAL", "CREDITS"]),
});

export const OpenIncidentRemediesResponseSchema = z.object({
  remedies: z.array(OpenIncidentRemedySchema),
});

/** A priced cancel quote from `GET /api/appointments/[id]/cancel/preview` or the trial twin. */
const CancelRefundQuoteSchema = z.object({
  refundPct: z.number(),
  estimatedRefundPaise: z.number(),
  currency: z.string(),
  /** Null with no live session, and on the whole-event rail, which never consults the clock. */
  hoursUntilNextSession: z.number().nullable(),
  prorated: z.boolean(),
  /** Null on the whole-event rail, where a roster refunds through several rails at once. */
  fundingRail: z.enum(["GATEWAY", "INTERNAL", "CREDITS"]).nullable(),
  /** The sponsoring organisation, set only on the INTERNAL rail. */
  payerOrganizationName: z.string().nullable().optional(),
  /** A class or webinar cancel refunds the whole roster: the sum across `attendeeCount` attendees. */
  wholeEvent: z.boolean().optional(),
  attendeeCount: z.number().nullable().optional(),
  paid: z.literal(true).optional(),
  /** What was paid, for the trial breakdown line. */
  grossPaise: z.number().optional(),
  /** The credits rail restores whole; echoed back with the click. */
  creditRestoresInFull: z.boolean().optional(),
  /** Nothing was paid, in money or referral credit: the dialog says so instead of naming a rail. */
  freeBooking: z.boolean().optional(),
  /** A credit-funded plan with sessions held: our team returns the rest by hand. */
  creditReturnNeedsReview: z.boolean().optional(),
  /** Whether a captured payment funds the 1:1 booking; echoed back with the click. */
  expectedPaid: z.boolean().optional(),
});

/** The cancel preview: a priced quote, or the trial's `paid: false` when nothing was charged. */
export const CancelRefundPreviewSchema = z.union([
  z.object({ paid: z.literal(false) }),
  CancelRefundQuoteSchema,
]);
export type CancelRefundPreview = z.infer<typeof CancelRefundPreviewSchema>;
