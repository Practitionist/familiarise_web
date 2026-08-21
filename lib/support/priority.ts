/**
 * #support-hub — one reason→priority map for BOTH support scopes. Flow
 * terminals carry machine-readable `reason`s; this is the single place that
 * decides how hot the resulting ticket burns, so ops triage policy lives in
 * one reviewable line per reason.
 */

import type { SupportPriority } from "@prisma/client";

/** Reasons that page the queue at HIGH (money-integrity + no-show disputes). */
const HIGH_REASONS = new Set([
  "provider_no_show",
  "double_charge",
  "high_value_refund", // set by decideEscalation on large refund exposure
]);

/** Everything escalates at MEDIUM unless mapped otherwise here. */
export function priorityForReason(reason: string | null | undefined): SupportPriority {
  if (reason && HIGH_REASONS.has(reason)) return "HIGH";
  return "MEDIUM";
}
