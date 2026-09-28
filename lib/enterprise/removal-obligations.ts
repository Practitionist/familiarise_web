import type { RemovalObligations } from "./membership-guards";

/**
 * #1854 — the Remove-member dialog lists what the removal guard would refuse
 * on, before the operator confirms. This module is pure (no Prisma) so the
 * client can describe the counts a 409 `MEMBER_HAS_OBLIGATIONS` carries with
 * the same words the obligations read returns.
 */

/** Display order; `satisfies` keeps it in step with the guard's counts. */
export const REMOVAL_OBLIGATION_KEYS = [
  "upcomingSessions",
  "liveSeats",
  "overageInflight",
  "unpaidEarnings",
  "pendingRefunds",
  "openDisputes",
] as const satisfies readonly (keyof RemovalObligations)[];

export type RemovalObligationKey = (typeof REMOVAL_OBLIGATION_KEYS)[number];

export interface RemovalObligationItem {
  key: RemovalObligationKey;
  count: number;
  label: string;
}

const NOUNS: Record<RemovalObligationKey, [string, string]> = {
  upcomingSessions: ["upcoming session", "upcoming sessions"],
  liveSeats: ["live program seat", "live program seats"],
  overageInflight: [
    "overage charge in progress",
    "overage charges in progress",
  ],
  unpaidEarnings: ["unpaid earning", "unpaid earnings"],
  pendingRefunds: ["pending refund", "pending refunds"],
  openDisputes: ["open dispute", "open disputes"],
};

/** How an operator clears each obligation, shown under its label. */
export const REMOVAL_OBLIGATION_RESOLUTION: Record<
  RemovalObligationKey,
  string
> = {
  upcomingSessions:
    "Cancel or reassign these sessions from the Appointments page.",
  liveSeats: "End the seat from the program's assignments.",
  overageInflight: "Settle the overage charges from Billing first.",
  unpaidEarnings: "Settle these earnings from Payouts first.",
  pendingRefunds: "Wait for the refunds to finish.",
  openDisputes: "Settle the open disputes first.",
};

/** The non-zero obligations, in a fixed order, with a short counted label. */
export function describeRemovalObligations(
  counts: Readonly<Partial<Record<RemovalObligationKey, number>>>,
): RemovalObligationItem[] {
  return REMOVAL_OBLIGATION_KEYS.flatMap((key) => {
    const count = counts[key] ?? 0;
    if (count <= 0) return [];
    const [one, many] = NOUNS[key];
    return [{ key, count, label: `${count} ${count === 1 ? one : many}` }];
  });
}
