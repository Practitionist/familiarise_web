/**
 * Expert reliability thresholds and shapes. Prisma-free: client components
 * import it.
 */
import { z } from "zod";

export const EXPERT_STRIKE_WINDOW_DAYS = 90;
/** Operations review an expert at this many strikes in the window; strikes never reach a public page. */
export const EXPERT_STRIKE_THRESHOLD = 3;

const DAY_MS = 86_400_000;

export const strikeWindowStart = (
  now: Date,
  days = EXPERT_STRIKE_WINDOW_DAYS,
): Date => new Date(now.getTime() - days * DAY_MS);

export interface ExpertStrikeReviewRow {
  consultantProfileId: string;
  name: string | null;
  strikes: number;
  lastStrikeAt: string | null;
}

/** The expert's own record, read only by its owner: the window's count and its latest strikes. */
export const ownStrikesSchema = z.object({
  windowDays: z.number().int(),
  count: z.number().int(),
  recent: z.array(
    z.object({
      at: z.string(),
      cause: z.enum(["EXPERT_CANCEL", "CONSULTANT_NO_SHOW"]),
    }),
  ),
});
export type OwnStrikes = z.infer<typeof ownStrikesSchema>;

/** A strike's cause in the expert's own words. */
export const OWN_STRIKE_CAUSE_LABEL: Record<
  OwnStrikes["recent"][number]["cause"],
  string
> = {
  EXPERT_CANCEL: "You cancelled a confirmed booking",
  CONSULTANT_NO_SHOW: "You did not join a session",
};
