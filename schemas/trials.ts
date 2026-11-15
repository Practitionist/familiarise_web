import { z } from "zod";
import { TrialSessionStatusEnum } from "./enums";
import { MAX_TEXT_LENGTH } from "@/lib/validation/input-limits";

export const CreateTrialSchema = z.object({
  consulteeProfileId: z.string().min(1, "Consultee profile ID is required"),
  consultantProfileId: z.string().min(1, "Consultant profile ID is required"),
  subscriptionPlanId: z.string().min(1, "Subscription plan ID is required"),
  notes: z.string().max(MAX_TEXT_LENGTH).optional(), // #831
  // Enterprise (arch-4) — optional org attribution. When the booker is a
  // LEARNER of an org, passing the orgId here stamps the trial with
  // `TrialSession.organizationId` so analytics can segment org-tagged
  // trials from organic ones and measure conversion. The org pays
  // nothing — this is *attribution*, not sponsorship. Membership is
  // verified server-side before persisting.
  organizationId: z.string().optional(),
  // The buyer's pick: one window of the plan's trial length, from the
  // expert's open times. The route checks the length and the lead time.
  slot: z.object({
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }),
  }),
});

export const UpdateTrialSchema = z.object({
  status: TrialSessionStatusEnum.optional(),
  notes: z.string().max(MAX_TEXT_LENGTH).optional(), // #831
  // Required when status = CONVERTED — the subscription created via checkout
  subscriptionId: z.string().optional(),
});

/** The trial cancel door's optional body: the refund the caller confirmed from its preview, in paise. */
export const TrialCancelBodySchema = z.object({
  confirmedRefundPaise: z.number().int().nonnegative().optional(),
});

/** What a trial cancel sends; the DELETE route parses the body with `TrialCancelBodySchema`. */
export function trialCancelRequest(
  trialId: string,
  quote?: { estimatedRefundPaise: number },
): { url: string; body: z.infer<typeof TrialCancelBodySchema> } {
  return {
    url: `/api/trials/${trialId}`,
    body: quote ? { confirmedRefundPaise: quote.estimatedRefundPaise } : {},
  };
}
