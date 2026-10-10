/**
 * #1527 — the shape of the owner's per-offering stats, shared by the server
 * read (lib/data/offering-stats.ts) and the client surfaces that render it.
 */

export type OfferingPlanType =
  "consultation" | "subscription" | "webinar" | "class";

export interface OfferingStat {
  planType: OfferingPlanType;
  planId: string;
  title: string;
  /** Confirmed 1:1 or subscription bookings, or live seats on group events. */
  bookings: number;
  /** The owner's share, net of refunds, in paise. */
  earningsPaise: number;
  /**
   * #1527-6 / #1846 — nothing has ever touched it: the DELETE route's own
   * guard (lib/offerings/delete-guard.ts), read as a query, so the two agree.
   */
  canDelete: boolean;
  /** #1509 — the org catalog governs archive for these. */
  orgGoverned: boolean;
  archived: boolean;
}

export interface OfferingStats {
  rows: OfferingStat[];
  /** Every share this profile ever earned, net of refunds, collaborations included. */
  lifetimePaise: number;
}

export const offeringStatKey = (type: OfferingPlanType, planId: string) =>
  `${type}:${planId}`;

/** The owner-only route both the Offerings list and Earnings read. */
export const OFFERING_STATS_URL = "/api/consultant/offering-stats";

export const offeringStatsQueryKey = (consultantId: string) =>
  ["offering-stats", consultantId] as const;

export async function fetchOfferingStats(): Promise<OfferingStats> {
  const res = await fetch(OFFERING_STATS_URL, { cache: "no-store" });
  if (!res.ok) throw new Error("Failed to load offering stats");
  const body = (await res.json()) as { data: OfferingStats };
  return body.data;
}
