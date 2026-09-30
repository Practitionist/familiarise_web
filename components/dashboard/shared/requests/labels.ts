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
  approvedAwaitingPayment: "Approved — the learner has 24 h to pay",
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
  // #1863 — the codes the booking paths below the inbox emit with no entry
  // here. Each arrived as a bracketed/raw server string, which is both ugly and
  // a lie: the sentence beside the code is the actionable half and the code is
  // the durable one. Registered rather than left to the regex fallback so a
  // reworded server message cannot change what the consultant is told.
  //
  // The reschedule family: a second reschedule click, a proposal that closed
  // while they were choosing, or the notice window. The last one is not a
  // failure at all — it is a policy answer, and the server's own sentence names
  // the hours, so pass it through rather than inventing a vaguer one.
  RESCHEDULE_ALREADY_OPEN: "A reschedule request is already open for this booking.",
  PROPOSAL_COUNT_MISMATCH: TOAST.changedElsewhere,
  PROPOSAL_WINDOW_CLOSED: TOAST.changedElsewhere,
  // CN-1 / #1169 PR 1 — the booking locks fail CLOSED on a Redis outage. The
  // request is untouched, so this is a wait-and-retry, same as LOCK_CONTENTION.
  BOOKING_LOCK_UNAVAILABLE: "The booking system is briefly busy — retry in a moment.",
  // #1319 — the server spent its Serializable budget. Nothing was written.
  SERIALIZATION_CONFLICT: "The booking system was busy — please try again.",
  // B4 — the capacity pre-check. Terminal, so the sentence points elsewhere
  // rather than at a retry.
  EVENT_SOLD_OUT: "This session is full — pick another time or join the waitlist.",
  // DELIBERATELY ABSENT, because the server's own sentence is the better copy
  // and the fallback below already reaches it (with any `[CODE]` stripped):
  //   RESCHEDULE_WINDOW, SLOT_TOO_SOON, SLOT_NOT_ON_GRID
  // The first names the hours until the meeting and the minimum notice; the
  // second names how many minutes are left and the lead time. Restating either
  // here would be a vaguer duplicate of a sentence the route already wrote for
  // this person.
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

/**
 * The approve toast follows the allocate response's `awaitingPayment` flag
 * (PR-B #1782): a pay order was minted, so the row moves to "Awaiting
 * payment" rather than leaving the inbox. Absent → today's plain "Approved".
 */
export function approvedToast(result: { awaitingPayment?: boolean }): string {
  return result.awaitingPayment === true
    ? TOAST.approvedAwaitingPayment
    : TOAST.approved;
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
