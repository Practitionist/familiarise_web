import type { ActionItem } from "@/lib/enterprise/org-activation";
import {
  CONSULTEE_JOIN_WINDOW_MS,
  getOccurrenceJoinState,
  liveOccurrencesOf,
  type JoinableOccurrence,
} from "@/lib/appointments/occurrences";

/**
 * Derives the "needs you now" queue for the personal dashboards.
 *
 * Pure functions over data those pages already fetch — no new endpoints. The
 * org dashboard has had this since #1019 (`deriveActionItems` in
 * lib/enterprise/org-activation.ts); this is the same idea for consultants
 * and consultees, and reuses that module's `ActionItem` shape so one panel
 * component renders all three.
 *
 * The bar for inclusion is deliberately high: an item earns a place here only
 * if the user is the one blocking it and there is a single obvious next
 * click. "You have 12 upcoming sessions" is not an action — it's a summary,
 * and summaries belong further down the page.
 */

/** A session is "imminent" inside this window — close enough to act on. */
const IMMINENT_MS = 60 * 60 * 1000; // 1 hour

function pluralise(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

export interface ImminentSession {
  /**
   * The slot row and the booking it belongs to. Both optional because not
   * every surface has rows to give: the consultee home tab already hands us
   * run-level times, while the consultant tab hands us the raw 30-minute
   * rows. When they are present, consecutive rows of one booking collapse
   * into a single session (#1061) instead of each half hour announcing
   * itself as a separate thing starting 30 minutes from now.
   */
  id?: string;
  appointmentId?: string | null;
  startsAt: Date | string;
  endsAt?: Date | string | null;
  title: string;
}

/**
 * Shared by both roles: the session that is running now, or starting within
 * the hour. Only the soonest is surfaced — a list of everything upcoming is
 * the Appointments tab's job, and repeating it here is exactly the
 * duplication this panel replaced.
 */
/**
 * The three distinct things a session flag can mean. Kept as a function rather
 * than a nested ternary inline: the join window opens BEFORE the start and
 * stays open throughout, so "about to begin" and "under way" are different
 * answers that one flag cannot carry (#1061).
 */
function sessionTitle(
  inProgress: boolean,
  isJoinable: boolean,
  mins: number,
): string {
  if (inProgress) return "Session in progress";
  if (isJoinable) return `Starting in ${mins} min`;
  return `Session in ${mins} min`;
}

export function imminentSessionItem(
  sessions: ImminentSession[],
  appointmentsHref: string,
  now: Date = new Date(),
): ActionItem | null {
  // The title rides along on the row so the winning run can name itself.
  const rows: Array<JoinableOccurrence & { title: string }> = sessions.map(
    (session, index) => ({
      id: session.id ?? `imminent:${index}`,
      appointmentId: session.appointmentId ?? null,
      startsAt: session.startsAt,
      endsAt: session.endsAt ?? null,
      title: session.title,
    }),
  );

  // Ordered earliest-first by the shared helper.
  for (const run of liveOccurrencesOf(rows)) {
    // The join window is the shared constant, and the window test is the
    // shared helper. #1061 was two surfaces holding private copies of both
    // and drifting apart; a third copy here would be the same mistake.
    const state = getOccurrenceJoinState(run, {
      joinWindowMs: CONSULTEE_JOIN_WINDOW_MS,
      now,
    });
    if (state === "ended" || state === "disabled") continue;

    const msUntilStart = new Date(run.startsAt).getTime() - now.getTime();
    if (msUntilStart > IMMINENT_MS) break;

    // The same helper with no pre-start allowance: it can only answer
    // "joinable" once `now` is past the start, which is exactly the "already
    // running" question, and it still answers "ended" past the end. Deriving
    // it this way rather than comparing times again keeps one definition of
    // when a session is under way.
    const inProgress =
      getOccurrenceJoinState(run, { joinWindowMs: 0, now }) === "joinable";

    // Rounded for display only — the window itself is decided above, on the
    // exact instant, because a session 10m29s out rounds to 10.
    const mins = Math.max(1, Math.round(msUntilStart / 60_000));

    return {
      key: "session-imminent",
      severity: state === "joinable" ? "critical" : "warning",
      // A session 25 minutes in used to read "starting now" (#1061): the
      // join window opens before the start and stays open throughout, so
      // one flag could not tell "about to begin" from "under way".
      title: sessionTitle(inProgress, state === "joinable", mins),
      body: run.title,
      // Both labels say "View": `ctaHref` is the appointments list, not the
      // meeting, and ActionRequiredPanel renders it as an ordinary link. Saying
      // "Join" promised a call and delivered a list. The urgency is already
      // carried by `severity` and the title.
      ctaLabel: "View",
      ctaHref: appointmentsHref,
    };
  }

  return null;
}

export interface ConsultantActionInput {
  /** The Requests badge's number: everything in the inbox waiting on them. */
  pendingApprovals: number;
  /** Documents uploaded by consultees and awaiting this consultant's review. */
  documentsAwaitingReview?: number;
  /** #1527 — a learner proposed new times; the consultant answers. */
  rescheduleReplies?: { appointmentId: string; counterpartName: string }[];
  /** #1569 — missed class sessions still owed a make-up, with the deadline. */
  owedMakeUps?: {
    appointmentId: string;
    occurrenceId: string;
    title: string;
    deadline: string;
  }[];
  upcomingSessions: ImminentSession[];
  basePath: string;
  /** #1675 PR-Y2 — earnings exist and no verified payout account can take them. */
  payoutSetupNeeded?: boolean;
  /** Words the row: before launch the account is collected ahead of the flag. */
  livePayoutsEnabled?: boolean;
}

export function deriveConsultantActionItems({
  pendingApprovals,
  documentsAwaitingReview = 0,
  rescheduleReplies = [],
  owedMakeUps = [],
  upcomingSessions,
  basePath,
  payoutSetupNeeded = false,
  livePayoutsEnabled = true,
}: ConsultantActionInput): ActionItem[] {
  const items: ActionItem[] = [];

  const imminent = imminentSessionItem(
    upcomingSessions,
    `${basePath}/appointments`,
  );
  if (imminent) items.push(imminent);

  // Money already earned with nowhere to go outranks new work: the fix is one
  // form, and every payout batch until then skips this consultant.
  if (payoutSetupNeeded) {
    items.push({
      key: "payout-setup",
      severity: "warning",
      title: livePayoutsEnabled
        ? "Add your bank account to get paid"
        : "Add your bank account — payouts begin at launch",
      body: livePayoutsEnabled
        ? "You have earnings waiting; payouts start once an account is verified."
        : "You have earnings waiting; a verified account now means you are in the first batch.",
      ctaLabel: "Set up",
      ctaHref: `${basePath}/settings/get-paid`,
    });
  }

  if (pendingApprovals > 0) {
    items.push({
      key: "pending-requests",
      severity: "warning",
      title: `${pendingApprovals} ${pluralise(pendingApprovals, "request", "requests")} to answer`,
      body: "Learners are waiting on you before they can book.",
      ctaLabel: "Answer",
      ctaHref: `${basePath}/requests`,
    });
  }

  for (const reply of rescheduleReplies) {
    items.push({
      key: `reschedule-reply:${reply.appointmentId}`,
      severity: "warning",
      title: `${reply.counterpartName} asked to reschedule`,
      body: "Accept one of their times or decline to keep the booking as it is.",
      ctaLabel: "Reply",
      ctaHref: `${basePath}/appointments/${reply.appointmentId}`,
    });
  }

  for (const owed of owedMakeUps) {
    const by = new Date(owed.deadline).toLocaleDateString("en-IN", {
      day: "numeric",
      month: "short",
    });
    items.push({
      key: `make-up:${owed.occurrenceId}`,
      severity: "warning",
      title: `Schedule a make-up for ${owed.title}`,
      body: `Hold it by ${by}, or every learner on that session is refunded for it.`,
      ctaLabel: "Schedule",
      ctaHref: `${basePath}/appointments/${owed.appointmentId}`,
    });
  }

  if (documentsAwaitingReview > 0) {
    items.push({
      key: "documents-review",
      severity: "info",
      title: `${documentsAwaitingReview} ${pluralise(documentsAwaitingReview, "document awaits", "documents await")} your review`,
      body: "Uploaded by learners ahead of their sessions.",
      ctaLabel: "Review",
      ctaHref: `${basePath}/documents`,
    });
  }

  return items;
}

export interface ConsulteeActionInput {
  /** Charges the learner still owes — blocks or risks their booking. */
  pendingPaymentCount: number;
  pendingPaymentTotalPaise?: number;
  upcomingSessions: ImminentSession[];
  basePath: string;
  /** #1527 — pay links that lapsed recently; the fix is asking again. */
  lapsedPayLinks?: { id: string; consultantName: string; href: string }[];
  /** #1527 — an expert proposed new times and is waiting on this learner. */
  rescheduleProposals?: {
    appointmentId: string;
    title: string;
    counterpartName: string;
  }[];
  /** #1300 — held sessions with no review yet; the prompt lives here, not in the room. */
  sessionsToRate?: { key: string; consultantName: string; href: string }[];
  /** The expert asked for a revised upload (review status NEEDS_REVISION). */
  documentsToRevise?: { id: string; name: string; appointmentId: string }[];
  /** A refund the gateway rejected; staff re-issue it, the learner can follow up. */
  failedRefunds?: { paymentId: string; amountText: string }[];
}

/**
 * The consultee's "Needs you" inbox (#1527 §7.1). A request still waiting on
 * the expert (PENDING_APPROVAL) is deliberately absent: the learner cannot
 * move it, and Appointments › Waiting on expert already lists it.
 */
export function deriveConsulteeActionItems({
  pendingPaymentCount,
  pendingPaymentTotalPaise = 0,
  upcomingSessions,
  basePath,
  lapsedPayLinks = [],
  rescheduleProposals = [],
  sessionsToRate = [],
  documentsToRevise = [],
  failedRefunds = [],
}: ConsulteeActionInput): ActionItem[] {
  const items: ActionItem[] = [];

  const imminent = imminentSessionItem(
    upcomingSessions,
    `${basePath}/appointments`,
  );
  if (imminent) items.push(imminent);

  if (pendingPaymentCount > 0) {
    const amount =
      pendingPaymentTotalPaise > 0
        ? ` (₹${(pendingPaymentTotalPaise / 100).toLocaleString("en-IN")})`
        : "";
    items.push({
      key: "pending-payments",
      severity: "critical",
      title: `${pendingPaymentCount} ${pluralise(pendingPaymentCount, "payment is", "payments are")} outstanding${amount}`,
      body: "Your booking isn't confirmed until payment clears.",
      ctaLabel: "Pay",
      ctaHref: `${basePath}/payments?tab=needs-you`,
    });
  }

  for (const proposal of rescheduleProposals) {
    items.push({
      key: `reschedule:${proposal.appointmentId}`,
      severity: "warning",
      title: `${proposal.counterpartName} proposed new times`,
      body: proposal.title,
      ctaLabel: "Answer",
      ctaHref: `${basePath}/appointments/${proposal.appointmentId}`,
    });
  }

  for (const doc of documentsToRevise) {
    items.push({
      key: `document:${doc.id}`,
      severity: "warning",
      title: "Your expert asked for a revised document",
      body: doc.name,
      ctaLabel: "Upload",
      ctaHref: `${basePath}/appointments/${doc.appointmentId}`,
    });
  }

  for (const refund of failedRefunds) {
    items.push({
      key: `failed-refund:${refund.paymentId}`,
      severity: "critical",
      title: `We couldn't return ${refund.amountText}`,
      body: "Our team re-issues failed refunds by hand. Open the charge to follow up.",
      ctaLabel: "View",
      ctaHref: `${basePath}/payments/${refund.paymentId}`,
    });
  }

  for (const link of lapsedPayLinks) {
    items.push({
      key: `lapsed:${link.id}`,
      severity: "info",
      title: `Your payment link for ${link.consultantName} expired`,
      body: "Ask for a new link, or book another time.",
      ctaLabel: "Request again",
      ctaHref: link.href,
    });
  }

  for (const session of sessionsToRate) {
    items.push({
      key: `rate:${session.key}`,
      severity: "info",
      title: `How was your session with ${session.consultantName}?`,
      body: "A short review helps other learners choose.",
      ctaLabel: "Rate",
      ctaHref: session.href,
    });
  }

  return items;
}
