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
import {
  bookingStatus,
  bookingStatusBadge,
} from "@/lib/appointments/booking-status";
import { formatDateTimeLabel, type DisplayOpts } from "@/lib/time/display";

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
    hint: "Under a day left to reply or schedule, or already past it.",
  },
  "this-week": { title: "This week", hint: "Under seven days left." },
  later: { title: "Later", hint: "More than a week left to reply." },
  "waiting-on-them": {
    title: "Waiting on the client",
    hint: "They need to pay, answer your new time, or finish checkout.",
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
    title: "No trials awaiting payment",
    body: "Paid trials booked from your plan pages appear here until they are paid.",
  },
};

/** A paid plan whose week is done and whose next sessions await placing. */
export const NEXT_CYCLE_BADGE = bookingStatusBadge(
  bookingStatus(
    { kind: "SUBSCRIPTION", status: "APPROVED", planWait: "NEXT_CYCLE" },
    "CONSULTANT",
  ),
);

/** "Schedule the next 2 · 4 of 24 booked" — sessions, never slots (#1639). */
export function nextCycleLine(entitlement: SubscriptionEntitlement): string {
  return `Schedule the next ${entitlement.cycle.nextBatch} · ${entitlement.held} of ${entitlement.total} booked`;
}

/** A ranked sort pages a bounded window; say so when rows sit outside it. */
const RANKED_WINDOW_KIND: Record<InboxSort, string> = {
  new: "newest",
  old: "oldest",
  priority: "most urgent",
  deadline: "most urgent",
  money: "most urgent",
};

export const RANKED_WINDOW_NOTE = (
  shown: number,
  total: number,
  sort: InboxSort,
) =>
  `Showing the ${shown} ${RANKED_WINDOW_KIND[sort]} of ${total} — pick a filter to see the rest`;

/** A direct checkout the buyer is paying for right now: never answerable. */
export const CHECKOUT_HOLD_BADGE = bookingStatusBadge(
  bookingStatus(
    { kind: "CONSULTATION", status: "PENDING", source: "DIRECT_CHECKOUT" },
    "CONSULTANT",
  ),
);
export const CHECKOUT_HOLD_LINE =
  "The learner is paying now — nothing to do. The time stays held until then.";

/** A request whose asked-for time is too close or gone. */
export const REQUESTED_TIME_PASSED =
  "Requested time has passed — propose new times";

/** One verb per toast. */
export const TOAST = {
  approved: "Confirmed",
  approvedAwaitingPayment:
    "Awaiting payment — the learner was sent the pay link",
  declined: "Declined",
  reminderSent: "Reminder sent",
  approvalWithdrawn: "Approval withdrawn",
  keptOriginal: "Kept the original time",
  proposalWithdrawn: "Request withdrawn",
  originalTimeTaken: "That time was taken meanwhile — pick a new one",
  changedElsewhere: "This request changed elsewhere — refreshed",
} as const;

/**
 * The toast after answering a reschedule from the inbox. "Keep the original
 * time" whose time was taken meanwhile comes back RELEASED: the session now
 * needs a new time, so it never claims the original was kept.
 */
export function proposalAnswerToast(
  answer: "keep-original" | "withdraw-proposal",
  outcome: string | undefined,
): string {
  if (outcome === "RELEASED") return TOAST.originalTimeTaken;
  return answer === "keep-original"
    ? TOAST.keptOriginal
    : TOAST.proposalWithdrawn;
}

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
  RESCHEDULE_ALREADY_OPEN:
    "A reschedule request is already open for this booking.",
  PROPOSAL_COUNT_MISMATCH: TOAST.changedElsewhere,
  PROPOSAL_WINDOW_CLOSED: TOAST.changedElsewhere,
  // CN-1 / #1169 PR 1 — the booking locks fail CLOSED on a Redis outage. The
  // request is untouched, so this is a wait-and-retry, same as LOCK_CONTENTION.
  BOOKING_LOCK_UNAVAILABLE:
    "The booking system is briefly busy — retry in a moment.",
  // #1319 — the server spent its Serializable budget. Nothing was written.
  SERIALIZATION_CONFLICT: "The booking system was busy — please try again.",
  // B4 — the capacity pre-check. Terminal, so the sentence points elsewhere
  // rather than at a retry.
  EVENT_SOLD_OUT:
    "This session is full. Pick another time, or use Notify me on the event page to hear when a seat opens.",
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
 * The approve toast follows the allocate response's `awaitingPayment` flag: a
 * pay order was minted, so the row moves to "Awaiting payment" rather than
 * leaving the inbox, and the toast names the pay window's real end when the
 * response carries it. Absent → the plain "Approved".
 */
export function approvedToast(
  result: { awaitingPayment?: boolean; payExpiresAt?: Date | null },
  opts: DisplayOpts = {},
): string {
  if (result.awaitingPayment !== true) return TOAST.approved;
  return result.payExpiresAt
    ? `Awaiting payment — the learner has until ${formatDateTimeLabel(result.payExpiresAt, opts)} to pay`
    : TOAST.approvedAwaitingPayment;
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
