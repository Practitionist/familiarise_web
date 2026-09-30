"use client";

import {
  PLATFORM_DEFAULT_TERMS,
  computeRefundPct,
  eventRefundWindowHours,
  type CancellationPolicyTerms,
} from "@/lib/payments/operations/cancellation-policy";
import { formatInViewerZone, type ViewerZone } from "@/lib/time/viewer-zone";

/**
 * #1863 — the cancellation ladder, in the buyer's own terms, at the moment they
 * can still act on it.
 *
 * The only refund-adjacent thing a class or webinar buy showed was
 * `FreeCancellationLine`, which is a DIFFERENT mechanism: the event window
 * (a seat bought outright, refunded whole outside the window and refused inside
 * it), not the notice ladder. The ladder — the thing a consultation or
 * subscription actually settles under — was invisible until the cancel dialog,
 * by which point the buyer has already paid and can no longer choose. That is
 * the wrong order: a buyer deciding between two consultants is exactly who
 * should be able to read the ladder.
 *
 * Two rails, deliberately:
 *
 *   - EVENT (class / webinar seat): the plan's own refund window. One rung, and
 *     the honest sentence is what happens on either side of it.
 *   - INDIVIDUAL (consultation / subscription / trial): the notice ladder. At
 *     purchase there is no agreed time, so the notice is INFINITE and the whole
 *     price comes back — what the buyer is reading is the ladder itself, which
 *     starts mattering the moment a time is agreed.
 *
 * The numbers come from `PLATFORM_DEFAULT_TERMS`, the same constant
 * `quoteBookingRefund` falls back to when a booking carries no policy row, so
 * the line cannot promise a different number from the one the charge will use.
 * An organisation that has published its own ladder binds its own funded
 * bookings instead; that row is behind `settings.manage` (see
 * `app/api/organizations/[orgId]/cancellation-policy`), so this note says so
 * rather than printing numbers it cannot read.
 *
 * The rail sentence reuses `refundRailLine`'s vocabulary (INTERNAL → the
 * sponsor's balance, CREDITS → the buyer's balance, GATEWAY → 5–7 working
 * days) so the promise made here and the one made in the cancel dialog are
 * the same promise in the same words.
 */

/** Which refund rail the buyer's own choices on this page put the money on. */
export type PurchaseFunding =
  | { kind: "gateway" }
  | { kind: "credits" }
  | { kind: "organization"; name?: string | null };

/** 24 → "24 hours", 72 → "3 days", 0 → "no notice". */
export function noticePhrase(hoursBefore: number): string {
  if (hoursBefore <= 0) return "no notice";
  if (hoursBefore < 24) return `${hoursBefore} hour${hoursBefore === 1 ? "" : "s"}`;
  // Days only from three up: "cancel at least 1 day before" is less immediate
  // than "24 hours before", and 24 is the single most common rung on the
  // platform ladder. A buyer reading this is checking a deadline.
  if (hoursBefore < 72) return `${hoursBefore} hours`;
  const days = hoursBefore / 24;
  return Number.isInteger(days)
    ? `${days} day${days === 1 ? "" : "s"}`
    : `${hoursBefore} hours`;
}

/** "100%", "50%", "0%" — a whole number stays whole, 12.5 does not become 13. */
function pctPhrase(refundPct: number): string {
  return `${Number.isInteger(refundPct) ? refundPct : Number(refundPct.toFixed(2))}%`;
}

/**
 * The ladder as one sentence, top rung first — the order the policy is written
 * in and the order a buyer reads a refund table in (100% → 50% → nothing), which
 * is also the order notice is lost in.
 *
 * The top rung is special: at purchase no time is agreed, so the notice is
 * effectively infinite and the whole price comes back. The ladder has no
 * infinite rung of its own, so the top tier's threshold covers both cases and
 * the sentence says so rather than making the buyer work out that "24 hours"
 * includes "never".
 */
export function ladderSentence(
  terms: CancellationPolicyTerms,
): string {
  const descending = [...terms.tiers].sort(
    (a, b) => b.hoursBefore - a.hoursBefore,
  );
  const topPct = computeRefundPct(
    terms,
    Number.POSITIVE_INFINITY,
    false,
  );
  return descending
    .map((tier, index) => {
      // `validateTierLadder` requires the last rung to sit at 0 hours precisely
      // so that "nothing" is stated out loud rather than implied by the table
      // running out; say it that way.
      if (tier.hoursBefore === 0) return "nothing once the session starts";
      if (index === 0) {
        const clause = `${noticePhrase(tier.hoursBefore)} or more notice`;
        return tier.refundPct === topPct
          ? `${pctPhrase(tier.refundPct)} back with ${clause} — including before a time is agreed at all`
          : `${pctPhrase(tier.refundPct)} back with ${clause}`;
      }
      return `${pctPhrase(tier.refundPct)} back with ${noticePhrase(tier.hoursBefore)} or more notice`;
    })
    .join(" · ");
}

/**
 * The next boundary UP from `hoursUntilStart`: the number of hours of notice
 * that would move the buyer onto a better rung, and what that rung is worth.
 *
 * Null at the top of the ladder — there is nothing left to wait for. This is the
 * figure the audit called "the hours-until figure at the next tier boundary", and
 * it is the only part of the ladder that is a live number rather than a table:
 * everything else is what the policy says, this is what YOUR booking would get
 * right now.
 */
export function nextTierBoundary(
  terms: CancellationPolicyTerms,
  hoursUntilStart: number | null,
): { hoursBefore: number; refundPct: number; hoursToWait: number } | null {
  if (hoursUntilStart === null) return null;
  const nowPct = computeRefundPct(terms, hoursUntilStart, false);
  const better = terms.tiers
    .filter((tier) => tier.refundPct > nowPct && tier.hoursBefore > hoursUntilStart)
    .sort((a, b) => a.hoursBefore - b.hoursBefore)[0];
  if (!better) return null;
  return {
    hoursBefore: better.hoursBefore,
    refundPct: better.refundPct,
    hoursToWait: better.hoursBefore - hoursUntilStart,
  };
}

/**
 * Which rail sentence to print — the same three outcomes `refundRailLine`
 * distinguishes, said before there is anything to refund.
 */
export function purchaseRailLine(
  funding: PurchaseFunding,
  eventKind: "class" | "webinar" | "individual",
): string {
  if (funding.kind === "credits") {
    return "Any refund goes back to your referral credit balance, not to a card.";
  }
  if (funding.kind === "organization") {
    return `Any refund returns to ${
      funding.name || "your organisation"
    }'s balance — nothing is charged back to a card.`;
  }
  return eventKind === "individual"
    ? "Any refund reaches your original payment method in 5–7 working days."
    : "Any refund for this seat reaches your original payment method in 5–7 working days.";
}

export interface CancellationPolicyNoteProps {
  /** Which mechanism governs this purchase. */
  eventKind: "class" | "webinar" | "individual";
  /** The plan's own refund window, hours (class/webinar only). */
  eventWindowHours?: number | null;
  /** The seat's frozen snapshot, which wins over the plan's value. */
  eventWindowSnapshotHours?: number | null;
  /** Start of the next session — what the event window is measured back from. */
  eventStartsAt?: Date | string | null;
  /** The buyer's own funding choice on this page. */
  funding: PurchaseFunding;
  /** Named org, when one is paying, so the rail sentence can name it. */
  organizationName?: string | null;
  /** Terms override; defaults to the platform ladder the quote itself falls back to. */
  terms?: CancellationPolicyTerms;
  /** Resolved viewer zone, for the one instant this prints. */
  viewerZone: ViewerZone;
  className?: string;
}

/**
 * Pure half: everything the note says, as strings. Exported so the copy can be
 * pinned without mounting a component, and so the pages that embed it in a
 * table get the same sentences this renders in prose.
 */
export function purchaseCancellationCopy(props: {
  eventKind: CancellationPolicyNoteProps["eventKind"];
  eventWindowHours?: number | null;
  eventWindowSnapshotHours?: number | null;
  eventStartsAt?: Date | string | null;
  funding: PurchaseFunding;
  organizationName?: string | null;
  terms?: CancellationPolicyTerms;
  now?: number;
}): { heading: string; lines: string[] } {
  const terms = props.terms ?? PLATFORM_DEFAULT_TERMS;
  const now = props.now ?? Date.now();

  if (props.eventKind === "individual") {
    const lines = [
      `After a time is agreed: ${ladderSentence(terms)}.`,
    ];
    // A 1:1 checkout CAN already carry a chosen slot (`?startsAt=`), and when it
    // does the ladder stops being a table and becomes a number: which rung this
    // booking is on right now, and how much more notice would move it up. That
    // is the figure the audit called "the hours-until at the next tier
    // boundary", and it is the only version of it a buyer can act on.
    const start = props.eventStartsAt ? new Date(props.eventStartsAt) : null;
    const hoursUntil = start
      ? (start.getTime() - now) / 3_600_000
      : null;
    if (hoursUntil !== null) {
      const nowPct = computeRefundPct(terms, hoursUntil, false);
      const next = nextTierBoundary(terms, hoursUntil);
      lines.push(
        next
          ? `For the time you have picked, cancelling now returns ${pctPhrase(nowPct)}. Cancelling ${Math.ceil(next.hoursToWait)} h earlier instead would return ${pctPhrase(next.refundPct)}.`
          : `For the time you have picked, cancelling now returns ${pctPhrase(nowPct)} — the best this ladder offers.`,
      );
    }
    // The one asymmetry the buyer cannot infer from a ladder of their own
    // cancellation: the expert changing the booking is always fully refunded.
    if (terms.consultantInitiatedPct >= 100) {
      lines.push(
        "If your consultant moves or ends the booking, you are refunded in full.",
      );
    }
    return { heading: "If you cancel", lines };
  }

  const windowHours = eventRefundWindowHours(
    props.eventWindowSnapshotHours,
    props.eventWindowHours,
  );
  const label = props.eventKind === "class" ? "class" : "webinar";
  const start = props.eventStartsAt ? new Date(props.eventStartsAt) : null;
  const hoursUntil = start ? (start.getTime() - now) / 3_600_000 : null;

  const lines = [
    `Cancel at least ${noticePhrase(windowHours)} before it starts and the seat is refunded in full. Inside that window the seat cannot be refunded.`,
  ];
  if (hoursUntil !== null) {
    lines.push(
      hoursUntil > windowHours
        ? `You have ${Math.floor(hoursUntil)} h of notice left — that is ${Math.floor(hoursUntil - windowHours)} h inside the free-cancellation window.`
        : `The free-cancellation window for this ${label} closed; a cancellation now refunds nothing on this seat.`,
    );
  }
  return { heading: "If you cancel this seat", lines };
}

/**
 * The note itself. `FreeCancellationLine` stays where it is: it is the deadline,
 * this is the rule behind the deadline, and the two are the same fact at two
 * levels of detail. Rendering both is the point — a buyer who reads only the
 * deadline still does not know what happens after it passes.
 */
export function CancellationPolicyNote({
  eventKind,
  eventWindowHours,
  eventWindowSnapshotHours,
  eventStartsAt,
  funding,
  organizationName,
  terms,
  viewerZone,
  className = "text-xs text-muted-foreground",
}: Readonly<CancellationPolicyNoteProps>) {
  const copy = purchaseCancellationCopy({
    eventKind,
    eventWindowHours,
    eventWindowSnapshotHours,
    eventStartsAt,
    funding,
    organizationName,
    terms,
  });

  // The start instant, when there is one, is rendered in the viewer's own
  // resolved zone rather than the runtime's — a buy page is read on whatever
  // laptop someone happens to be on (#1863, the FreeCancellationLine fix).
  const startLabel = eventStartsAt
    ? ` (${formatInViewerZone(
        eventStartsAt,
        viewerZone.zone,
        "EEE d MMM, h:mm a",
      )})`
    : "";

  return (
    <div className={className}>
      <p className="font-medium text-foreground">{copy.heading}</p>
      <ul className="mt-1 space-y-0.5">
        {copy.lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p className="mt-1">{purchaseRailLine(funding, eventKind)}</p>
      {funding.kind === "organization" ? (
        <p className="mt-1">
          {(organizationName || "Your organisation") +
            "'s own cancellation policy applies to the bookings it funds."}
        </p>
      ) : null}
      {eventStartsAt && eventKind !== "individual" ? (
        <p className="mt-1">Next session{startLabel}</p>
      ) : null}
    </div>
  );
}
