import { z } from "zod";

/** The owner-only demand read behind the "You're in demand" banner (`GET /api/user/consultants/[id]/demand`). */
export const expertDemandSchema = z.object({
  acceptingRequests: z.boolean(),
  bookingMode: z.enum(["INSTANT", "REQUEST"]),
  openRequests: z.number().int().nonnegative(),
  maxOpenRequests: z.number().int().positive().nullable(),
  /** When the oldest open request lapses unanswered. */
  nearestRequestExpiry: z.string().datetime().nullable(),
  /** Paid plans with no session placed yet. */
  unplacedPlans: z.number().int().nonnegative(),
  /** The oldest of those payments, and its 48-hour placement deadline. */
  oldestUnplacedPaidAt: z.string().datetime().nullable(),
  nearestPlacementDeadline: z.string().datetime().nullable(),
  /** Share of the next 14 days' published time already booked; null with nothing published. */
  bookedShare: z.number().min(0).max(1).nullable(),
  /** Distinct learners waiting on a taken time ahead. */
  learnersWaiting: z.number().int().nonnegative(),
});

export type ExpertDemand = z.infer<typeof expertDemandSchema>;
