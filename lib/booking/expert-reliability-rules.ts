/**
 * Expert reliability thresholds and shapes. Prisma-free: client components
 * import it.
 */

const EXPERT_STRIKE_WINDOW_DAYS = 90;
/** The public profile shows the notice at this many strikes in the window. */
export const EXPERT_STRIKE_THRESHOLD = 3;

const DAY_MS = 86_400_000;

export const strikeWindowStart = (
  now: Date,
  days = EXPERT_STRIKE_WINDOW_DAYS,
): Date => new Date(now.getTime() - days * DAY_MS);

export const showsReliabilityNotice = (strikes: number): boolean =>
  strikes >= EXPERT_STRIKE_THRESHOLD;

export interface ExpertStrikeReviewRow {
  consultantProfileId: string;
  name: string | null;
  strikes: number;
  lastStrikeAt: string | null;
}
