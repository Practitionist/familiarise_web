import type { ActionItem } from "@/lib/enterprise/org-activation";

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

/** The Join button opens this far ahead of the start time. */
const JOIN_WINDOW_MS = 10 * 60 * 1000;

function minutesUntil(when: Date | string): number {
  return Math.round((new Date(when).getTime() - Date.now()) / 60000);
}

function pluralise(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

export interface ImminentSession {
  startsAt: Date | string;
  title: string;
}

/**
 * Shared by both roles: the next session starting within the hour. Only the
 * soonest is surfaced — a list of everything upcoming is the Appointments
 * tab's job, and repeating it here is exactly the duplication this panel
 * replaced.
 */
export function imminentSessionItem(
  sessions: ImminentSession[],
  appointmentsHref: string,
): ActionItem | null {
  const now = Date.now();
  const soonest = sessions
    .filter((s) => {
      const delta = new Date(s.startsAt).getTime() - now;
      return delta > -JOIN_WINDOW_MS && delta <= IMMINENT_MS;
    })
    .sort(
      (a, b) =>
        new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
    )[0];

  if (!soonest) return null;

  const mins = minutesUntil(soonest.startsAt);
  const joinable = mins <= JOIN_WINDOW_MS / 60000;

  return {
    key: "session-imminent",
    severity: joinable ? "critical" : "warning",
    title: joinable ? "A session is starting now" : `Session in ${mins} min`,
    body: soonest.title,
    ctaLabel: joinable ? "Join" : "View",
    ctaHref: appointmentsHref,
  };
}

export interface ConsultantActionInput {
  /** Requests awaiting slot allocation by this consultant. */
  pendingApprovals: number;
  /** Documents uploaded by consultees and awaiting this consultant's review. */
  documentsAwaitingReview?: number;
  upcomingSessions: ImminentSession[];
  basePath: string;
}

export function deriveConsultantActionItems({
  pendingApprovals,
  documentsAwaitingReview = 0,
  upcomingSessions,
  basePath,
}: ConsultantActionInput): ActionItem[] {
  const items: ActionItem[] = [];

  const imminent = imminentSessionItem(
    upcomingSessions,
    `${basePath}/appointments`,
  );
  if (imminent) items.push(imminent);

  if (pendingApprovals > 0) {
    items.push({
      key: "pending-requests",
      severity: "warning",
      title: `${pendingApprovals} ${pluralise(pendingApprovals, "request needs", "requests need")} slot allocation`,
      body: "Learners are waiting on times from you before they can book.",
      ctaLabel: "Allocate",
      ctaHref: `${basePath}/requests`,
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
}

export function deriveConsulteeActionItems({
  pendingPaymentCount,
  pendingPaymentTotalPaise = 0,
  upcomingSessions,
  basePath,
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
      ctaHref: `${basePath}/payments`,
    });
  }

  return items;
}
