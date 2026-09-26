import type { CreditSource } from "@prisma/client";

/**
 * #1527 — words for `CreditSource`. Keyed by the real enum so a new source is
 * a type error here rather than a raw "MANUAL_ADJUSTMENT"-style fallback on a
 * page (the old map named a value that does not exist and missed three).
 */
export const CREDIT_SOURCE_LABEL: Record<CreditSource, string> = {
  REFERRAL_BONUS: "Referral bonus",
  REFEREE_BONUS: "Welcome bonus",
  PROMOTION: "Promotion",
  COMPENSATION: "Goodwill credit",
  MANUAL: "Added by support",
};

export function creditSourceLabel(source: string): string {
  return CREDIT_SOURCE_LABEL[source as CreditSource] ?? "Credit";
}
