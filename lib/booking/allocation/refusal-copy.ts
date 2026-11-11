// Turns the validator's tagged findings into plain user copy. The tagged
// strings (times as ISO, counts) are developer detail: they ride `details`
// to logs and Sentry, never the response.

import {
  AllocationConflictError,
  AllocationValidationError,
} from "@/utils/scheduling-engine/errors";

/** Plain copy per validator tag; the first finding decides. */
const COPY_BY_TAG: Record<string, string> = {
  CONFLICT: "One of these times is already booked. Pick another time.",
  COLLABORATOR_CONFLICT:
    "A co-host already has a session at one of these times. Pick another time.",
  COLLABORATOR_SCHEDULE:
    "One of these times is outside a co-host's available hours. Pick another time.",
  OUTSIDE_AVAILABILITY:
    "One of these times is outside the expert's available hours or this plan's scheduling period. Pick another time.",
  DAILY_LIMIT:
    "These times put too many sessions on one day. Spread them across more days.",
  TOO_SOON:
    "One of these times has passed or starts too soon to confirm. Pick a later time.",
  OUTSIDE_PLAN_WEEK:
    "A subscription is scheduled one plan week at a time. Pick times inside the open week shown on the calendar.",
  PLAN_WEEK_FULL:
    "That's more sessions than this plan week has room for. Remove a time, or place it next week.",
  PLAN_TOTAL_REACHED:
    "Every session this plan includes already has a time. Remove a time to place a new one.",
};

const FALLBACK_COPY =
  "These times don't fit this booking's sessions. Pick different times.";

/** The `[TAG]` a validator finding starts with, if any. */
function tagOf(finding: string): string | null {
  return /^\[([A-Z_]+)\]/.exec(finding)?.[1] ?? null;
}

/** Plain copy for a list of validator findings. */
export function refusalCopyFor(findings: readonly string[]): string {
  for (const finding of findings) {
    const tag = tagOf(finding);
    if (tag && COPY_BY_TAG[tag]) return COPY_BY_TAG[tag];
  }
  return FALLBACK_COPY;
}

/** A failed out-of-transaction validation, as a typed 400 with plain copy. */
export function validationRefusal(
  findings: readonly string[],
): AllocationValidationError {
  return new AllocationValidationError(
    refusalCopyFor(findings),
    "VALIDATION_ERROR",
    { findings },
  );
}

/** A time taken between the validation and the write, as a typed 409. */
export function slotTakenRefusal(
  findings: readonly string[],
): AllocationConflictError {
  return new AllocationConflictError(
    "One of these times was just booked. Pick another time and try again.",
    "SLOT_TAKEN",
    { findings },
  );
}
