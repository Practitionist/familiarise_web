/**
 * #1775 — the ONE label map the Requests inbox reads beside the presentation
 * layer. Booking and money words come from `deriveBookingPresentation`; what
 * lives here is the chrome around them (tab, chip, sort and bucket names),
 * the row kinds, the empty states, and the sentences a server code maps to
 * so no `[CONFLICT]` / code text ever reaches a toast (#1705).
 */

import type { SubscriptionEntitlement } from "@/lib/booking/entitlement";
import type {
  InboxBucket,
  InboxChip,
  InboxRowKind,
  InboxSort,
  InboxType,
} from "@/lib/dashboard/requests-inbox-state";
import { toneBadge } from "@/lib/dashboard/money-state";

export const TYPE_LABEL: Record<InboxType, string> = {
  consultation: "Consultations",
  subscription: "Subscriptions",
  trial: "Trials",
};

export const KIND_LABEL: Record<InboxRowKind, string> = {
  consultation: "Consultation",
  subscription: "Subscription",
  trial: "Trial",
  "next-cycle": "Next cycle",
};

export const CHIP_LABEL: Record<InboxChip, string> = {
  "answer-today": "Answer today",
  "awaiting-payment": "Awaiting payment",
  "next-cycle": "Next cycle",
  declined: "Declined",
};

/** Which chips a tab offers; a next cycle only exists on a subscription. */
export const CHIPS_FOR_TYPE: Record<InboxType, InboxChip[]> = {
  consultation: ["answer-today", "awaiting-payment", "declined"],
  subscription: ["answer-today", "awaiting-payment", "next-cycle", "declined"],
  trial: ["answer-today", "awaiting-payment", "declined"],
};

export const SORT_LABEL: Record<InboxSort, string> = {
  priority: "Priority",
  deadline: "Deadline",
  money: "Money",
  new: "Newest first",
  old: "Oldest first",
};

export const BUCKET_LABEL: Record<
  InboxBucket,
  { title: string; hint: string }
> = {
  "answer-today": {
    title: "Answer today",
    hint: "Under a day left on the hold, or already past it.",
  },
  "this-week": { title: "This week", hint: "Under seven days left." },
  later: { title: "Later", hint: "More than a week left on the hold." },
  "waiting-on-them": {
    title: "Waiting on them",
    hint: "The next step is the other side's — a payment or a new cycle.",
  },
};

export const EMPTY_STATE: Record<InboxType, { title: string; body: string }> = {
  consultation: {
    title: "No consultation requests",
    body: "New requests land here the moment someone asks for a session.",
  },
  subscription: {
    title: "No subscription requests",
    body: "New plans, pay links and cycles to schedule land here.",
  },
  trial: {
    title: "No trial requests",
    body: "Trial requests from your plan pages land here.",
  },
};

/** The one badge the presentation cannot name: a finished cycle with sessions left (#1766). */
export const NEXT_CYCLE_BADGE = toneBadge("info", "Next cycle open");

/** "Schedule the next 2 · 4 of 24 booked" — sessions, never slots (#1639). */
export function nextCycleLine(entitlement: SubscriptionEntitlement): string {
  return `Schedule the next ${entitlement.cycle.nextBatch} · ${entitlement.held} of ${entitlement.total} booked`;
}

/** One verb per toast. */
export const TOAST = {
  approved: "Approved",
  declined: "Declined",
  reminderSent: "Reminder sent",
  approvalWithdrawn: "Approval withdrawn",
  changedElsewhere: "This request changed elsewhere — refreshed",
} as const;

/** Server codes → sentences; the code itself never renders. */
const CODE_SENTENCE: Record<string, string> = {
  REMIND_RATE_LIMITED:
    "A reminder went out recently — the next one can go later.",
  REQUEST_CHANGED_ELSEWHERE: TOAST.changedElsewhere,
  ILLEGAL_TRANSITION: TOAST.changedElsewhere,
  RESCHEDULE_STATE_CHANGED: TOAST.changedElsewhere,
  ALREADY_ALLOCATED: "This request was already allocated in another tab.",
  VALIDATION_ERROR: "That request could not be read. Refresh and try again.",
  RATE_LIMITED: "Too many attempts — wait a moment, then retry.",
  ACCESS_DENIED: "You do not have access to this request.",
};

export function errorSentence(
  code: string | undefined,
  fallback: string,
): string {
  if (code && CODE_SENTENCE[code]) return CODE_SENTENCE[code];
  // A bracketed code inside a server message is stripped, never shown.
  return (
    fallback.replace(/\[[A-Z_]+\]\s*/g, "").trim() || "Something went wrong."
  );
}

/** "Remind sent · next in 3 h" from the route's `nextAllowedAt`. */
export function nextReminderLine(
  nextAllowedAt: Date,
  now = new Date(),
): string {
  const hours = Math.max(
    1,
    Math.ceil((nextAllowedAt.getTime() - now.getTime()) / 3_600_000),
  );
  return `Remind sent · next in ${hours} h`;
}
