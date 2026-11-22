// Turns the validator's tagged findings into plain user copy. The tagged
// strings (times as ISO, counts) are developer detail: they ride `details`
// to logs and Sentry, never the response.

import { SLOT_TOO_FAR_MESSAGE } from "@/lib/payments/utils/slot-validation";
import {
  AllocationConflictError,
  AllocationValidationError,
} from "@/utils/scheduling-engine/errors";

/** Plain copy per validator tag. */
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
  TOO_FAR: SLOT_TOO_FAR_MESSAGE,
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

/** Plan-week findings name the real cause when a generic one is reported beside them. */
const PLAN_WEEK_TAGS = [
  "PLAN_TOTAL_REACHED",
  "PLAN_WEEK_FULL",
  "OUTSIDE_PLAN_WEEK",
];

/** Plain copy for a list of validator findings: a plan-week finding first, else the first tagged one. */
export function refusalCopyFor(findings: readonly string[]): string {
  const tags = findings.map(tagOf);
  const tag =
    PLAN_WEEK_TAGS.find((planTag) => tags.includes(planTag)) ??
    tags.find((found) => found !== null && COPY_BY_TAG[found] !== undefined);
  return tag ? COPY_BY_TAG[tag] : FALLBACK_COPY;
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
