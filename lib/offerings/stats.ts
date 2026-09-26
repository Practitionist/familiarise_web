/**
 * #1527 — the shape of the owner's per-offering stats, shared by the server
 * read (lib/data/offering-stats.ts) and the client surfaces that render it.
 */

export type OfferingPlanType =
  | "consultation"
  | "subscription"
  | "webinar"
  | "class";

export interface OfferingStat {
  planType: OfferingPlanType;
  planId: string;
  title: string;
  /** Confirmed 1:1 or subscription bookings, or live seats on group events. */
  bookings: number;
  /** The owner's share, net of refunds, in paise. */
  earningsPaise: number;
  /** Zero bookings and zero payments (#1527-6); the server still decides. */
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

export interface OfferingHistory {
  /** Any 1:1/subscription request row, whatever its status — the DELETE route refuses on these. */
  requestRows: number;
  payments: number;
  seats: number;
  earningsPaise: number;
}

/** #1527-6 — Delete is offered only on a plan nothing has ever touched. */
export function canDeleteOffering(history: Readonly<OfferingHistory>): boolean {
  return (
    history.requestRows === 0 &&
    history.payments === 0 &&
    history.seats === 0 &&
    history.earningsPaise === 0
  );
}

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
