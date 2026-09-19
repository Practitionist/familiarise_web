/**
 * #1675 — the consultee's lapsed pay-links, the pure half. `expireLapsedPayLink`
 * (and the 7 d fallback in expire-stale-requests) moves an unpaid request from
 * APPROVED_PENDING_PAYMENT to EXPIRED with no reason on the history row, so
 * the lapse is told apart from the other EXPIRED edges (PENDING → EXPIRED when
 * the expert never answered, APPROVED → EXPIRED when nothing was scheduled) by
 * the from-status alone. Prisma-free so client components can import the type
 * and the pin can run without a client (prisma → pg → fs).
 */

import { AppointmentStatus } from "@prisma/client";

export const LAPSED_PAY_LINK_VISIBLE_MS = 7 * 24 * 60 * 60 * 1000;
export const LAPSED_PAY_LINK_LIMIT = 3;

export interface LapsedPayLink {
  id: string;
  type: "consultation" | "subscription";
  title: string;
  consultantName: string;
  /** ISO — the EXPIRED history row's clock, i.e. when the link lapsed. */
  expiredAt: string;
  /** The consultant's booking page, the existing REQUEST-mode entry. */
  requestAgainHref: string;
}

/** One EXPIRED request with every EXPIRED history row it has, any order. */
export interface ExpiredRequestRow {
  id: string;
  type: "consultation" | "subscription";
  title: string;
  consultantName: string;
  consultantProfileId: string;
  history: { fromStatus: string; toStatus: string; createdAt: Date }[];
}

/** Pure: keep the pay-link lapses of the last 7 d, newest first, capped. */
export function toLapsedPayLinks(
  rows: ExpiredRequestRow[],
  now: Date,
): LapsedPayLink[] {
  const cutoff = now.getTime() - LAPSED_PAY_LINK_VISIBLE_MS;
  const lapsed: { item: LapsedPayLink; at: number }[] = [];
  for (const row of rows) {
    // The newest EXPIRED edge is the one that put the row where it is.
    const edge = row.history
      .filter((h) => h.toStatus === AppointmentStatus.EXPIRED)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    if (!edge) continue;
    if (edge.fromStatus !== AppointmentStatus.APPROVED_PENDING_PAYMENT)
      continue;
    const at = edge.createdAt.getTime();
    if (at < cutoff) continue;
    lapsed.push({
      at,
      item: {
        id: row.id,
        type: row.type,
        title: row.title,
        consultantName: row.consultantName,
        expiredAt: edge.createdAt.toISOString(),
        requestAgainHref: `/explore/experts/${row.consultantProfileId}`,
      },
    });
  }
  return lapsed
    .sort((a, b) => b.at - a.at)
    .slice(0, LAPSED_PAY_LINK_LIMIT)
    .map((l) => l.item);
}
