/**
 * #1838 — the warning ladder for a session that runs past its booked end.
 *
 * A one-hour session used to run free until roughly 1h45 and then die
 * mid-sentence with no warning, no billing event and no announcement. This
 * module is the policy: when to warn, when free grace ends, what a block of
 * overtime costs, when a purchase counts as granted, and what has to be said
 * before a live call is closed.
 *
 * ## Three deliberate properties
 *
 * **1. It is pure.** No Prisma, no Stream client, no `Date.now()` read hidden
 * in a getter — `now` is always a parameter. That is what makes the ladder's
 * boundaries assertable at the exact millisecond, and it keeps the module
 * importable from a client component without dragging a `$transaction`-capable
 * global client into the browser bundle (the `PG_POOL_MAX=1` trap: nothing
 * inside a transaction may read through the global client, and a module that
 * merely *imports* it invites the next author to).
 *
 * **2. The grace window is DERIVED, never stored.**
 *
 * The issue named `OverrunGrace { meetingId, endsAt }` as a "start grace window
 * record". It is kept here as a TYPE, but it is computed, not persisted, and
 * that is the single most important decision in this feature.
 *
 * The obvious implementation is a `Map` in module scope: on T+0 write
 * `{ meetingId, endsAt: now + 10min }`, on read consult it. It is wrong on this
 * runtime. Next.js on Netlify runs each request in its own Lambda instance, so
 * module scope is per-instance, is discarded on freeze/thaw, and is simply not
 * shared between two concurrent invocations — and the invocation that decides
 * the hard close is a *different* invocation from the one that opened grace.
 * A cold second instance reads an empty map and either re-opens a fresh
 * ten-minute grace on every poll (grace never ends, nothing is ever billable)
 * or falls through to the hard close and kills a call that was supposed to have
 * ten free minutes left. Neither failure is loud; both read as a bug report.
 *
 * So the anchor is the slot's own `endsAt` — a column that was already there,
 * already indexed, and is the one thing every invocation is guaranteed to read
 * the same value from. `graceEndsAt = occurrence.endsAt + OVERRUN_GRACE_MS` is
 * a pure function of it, so every invocation, on any instance, at any moment,
 * derives a byte-identical window. Durable, idempotent, and free. The only cost
 * is that grace starts on the BOOKED end rather than on first join, which is
 * the honest definition anyway: free overrun is a property of the booking, not
 * of who happened to be in the room.
 *
 * `resolveOverrunGrace` below is the whole of it. There is deliberately no
 * writer, no store and no cache; `__tests__/stream/overrun-ladder.test.ts`
 * pins that with an isolated-module-registry test, so a re-introduced
 * module-scope `Map` fails the build rather than production.
 *
 * **3. It does not touch the Stream duration cap.**
 *
 * The issue's last ladder row reads "Cap (booked+45 today) — Stream ends call
 * (unchanged mechanism)", and the "Cap-2 min" announcement is defined as
 * "display off existing cap math". So the cap is an INPUT to this module —
 * `hardStopAt` — supplied by the caller, which is the only way the ladder can
 * be correct without importing a module whose output is currently untrustworthy.
 *
 * `lib/meetings/sync-call-window.ts` in the Stream mega-PR has a confirmed
 * unfixed defect: a failed planner sync leaves the previously minted
 * `max_duration_seconds` in place, so a 60-minute booking that was extended to
 * four hours keeps its old ~105-minute hard stop, and the "a later join repairs
 * it" comment in that file does not describe what the code does. Wiring the
 * ladder to that cap today would mean warning people about a deadline the
 * server does not actually hold, and selling extension minutes the SFU will
 * cut off. So: the cap is passed in, `hardStopAt` may be `null`, and the
 * ladder degrades to its own conservative backstop. Fixing the cap sync and
 * then deriving `hardStopAt` from `resolveMaxCallDurationSeconds` is the
 * follow-up this file is shaped for — no signature here changes when it lands.
 */

/**
 * T-5: the pill turns amber and both sides are told to start wrapping up.
 *
 * Five minutes is long enough to finish a thought and short enough that nobody
 * can claim they did not see it.
 */
export const OVERRUN_WARN_MS = 5 * 60 * 1000;

/**
 * Free overrun grace, measured from the BOOKED end.
 *
 * The issue shrinks billing grace from thirty minutes to ten. This deliberately
 * does NOT touch `REJOIN_GRACE_MS` (`lib/meetings/access.ts`) or
 * `CALL_DURATION_GRACE_MS` (`lib/meetings/duration-cap.ts`): those protect a
 * RECONNECT — a participant whose connection dropped mid-session and who must
 * not be locked out of a call that is demonstrably still running. This number
 * is about what a session is WORTH once its clock has run out. Conflating them
 * would mean either re-admitting people forever, or locking out a dropped
 * participant ten minutes early because the money had run out.
 */
export const OVERRUN_GRACE_MS = 10 * 60 * 1000;

/** Overtime is sold in whole fifteen-minute blocks. No per-second metering. */
export const EXTEND_BLOCK_MIN = 15;
export const EXTEND_BLOCK_MS = EXTEND_BLOCK_MIN * 60 * 1000;

/** The smallest saleable quantity, and the floor on how much may be bought. */
export const MIN_EXTENSION_BLOCKS = 1;

/**
 * Cap-2: the announcement that turns a silent kill into a scheduled one.
 */
export const HARD_CLOSE_WARN_MS = 2 * 60 * 1000;

/**
 * How long the consultee has to answer Accept/Decline.
 *
 * A backgrounded app must not hold a consultant hostage, and a consultant who
 * is told "extend?" with no deadline has to be assumed to have said no.
 * Timeout is therefore a decline, not a hold.
 */
export const CONSULTEE_RESPONSE_MS = 60 * 1000;

/**
 * How long a live call may be kept open after the notice was delivered.
 *
 * The announcement must precede the end (see `planHardClose`), but "announce
 * first" must not become "never close" when the instance that announced dies
 * before anything re-runs. Thirty seconds is long enough for a banner and a
 * notification to land on a phone that was backgrounded, and short enough that
 * a session does not run on indefinitely past its hard stop.
 */
export const HARD_CLOSE_ESCALATION_MS = 30 * 1000;

/**
 * The hard stop to assume when the caller knows none.
 *
 * Mirrors `REJOIN_GRACE_MS` in `lib/meetings/access.ts`: thirty minutes past
 * the booked end is where the server's own join gate stops admitting anyone.
 * Falling back to it means the ladder still announces and still closes rather
 * than running unbounded on a `null` cap — the failure direction is "we end it
 * a bit early, having warned", never "we never end it".
 */
export const OVERRUN_JOIN_BACKSTOP_MS = 30 * 60 * 1000;

/**
 * Smallest chargeable amount, in paise, so a paid block is never zero.
 */
const MIN_CHARGE_PAISE = 1;

/**
 * Paise are `number` at this boundary, deliberately.
 *
 * `check-money-columns.ts` (#780) governs the COLUMN, which is BigInt so an int4
 * cannot silently overflow at ₹2.14cr. `lib/prisma-extensions.ts` converts every
 * BigInt column to `number` on read, because no bigint may cross the RSC or
 * Zod boundary. This module is on the JS side of that line, so it speaks
 * `number` like every other money function in `lib/payments/` — and
 * MAX_SAFE_INTEGER is roughly ₹90 lakh crore, five orders of magnitude above a
 * single block of overtime.
 */
function assertSafePaise(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(
      `overrun: ${label} is not a safe paise integer: ${value}`,
    );
  }
  return value;
}

/**
 * The grace window, as the issue names it.
 *
 * A computed value, not a row. See the module header for why — and for why
 * that is the serverless-correct answer rather than a defeat.
 */
export interface OverrunGrace {
  meetingId: string;
  /**
   * When free overrun ends: the slot's own `endsAt` plus
   * `OVERRUN_GRACE_MS`. Identical in every invocation on every instance,
   * because it is a function of a durable column.
   */
  endsAt: Date;
  /** Always `"derived"`. Present so a consumer can assert where it came from. */
  source: "derived";
}

/**
 * The grace window for a meeting, or null when the slot has no booked end.
 *
 * `bookedEndsAt` is `Meeting.occurrence.endsAt`. A `Meeting` row has no end of
 * its own — the room is keyed to exactly one occurrence (#1554) — so this
 * cannot be derived from the call profile that `duration-cap.ts` reads, and it
 * does not depend on it.
 */
export function resolveOverrunGrace(args: {
  meetingId: string;
  bookedEndsAt: Date | null;
}): OverrunGrace | null {
  if (!args.bookedEndsAt) return null;
  return {
    meetingId: args.meetingId,
    endsAt: new Date(args.bookedEndsAt.getTime() + OVERRUN_GRACE_MS),
    source: "derived",
  };
}

/** A plan's price, reduced to what pro-rata needs. BigInt on purpose. */
export interface OverrunRate {
  /** Plan list price in paise, as the JS boundary sees it after #780. */
  planPricePaise: number;
  /**
   * Booked minutes the plan price covers — the denominator.
   *
   * The occurrence's real `endsAt - startsAt`, NOT the plan's nominal
   * `durationInHours`: a consultant who ran a 45-minute session on a 60-minute
   * plan priced the overrun against 60 minutes, because that is what was sold.
   */
  bookedMinutes: number;
}

/**
 * The pre-tax base price of `blocks` blocks of overtime, in paise.
 *
 * Pro-rata of the plan rate (plan per-minute × 15 minutes × blocks), which is
 * the only defensible formula: a 60-minute plan at ₹600 books at ₹10/min, so a
 * 15-minute block is ₹150 and four blocks are ₹600 — the whole session again.
 * Nobody can be surprised by a number that is just their own rate times the
 * minutes they used.
 *
 * **Rounding is DOWN, always.** The competitor sweep in the issue (§3) found
 * overcharging is the complaint that gets consultants actioned against them,
 * and a paise of "we rounded your favour" is the cheapest possible place to
 * stand. Flooring also means the sum of N blocks can never exceed the exact
 * pro-rata of N blocks, so no number of repeats can over-bill in aggregate.
 *
 * Tax is NOT applied here. This is the pre-tax base; the platform is the
 * principal supplier (ADR 26, 18% on the full price) and the existing engine in
 * `lib/payments/tax/` owns that. Re-deriving a tax path here would be inventing
 * a second one, which is worse than leaving the composition to the module that
 * already has it.
 */
export function proRataBasePaiseForBlock(
  rate: OverrunRate,
  blocks: number = MIN_EXTENSION_BLOCKS,
): number {
  if (!Number.isInteger(blocks) || blocks < MIN_EXTENSION_BLOCKS) {
    throw new RangeError(
      `overrun: blocks must be an integer >= ${MIN_EXTENSION_BLOCKS}, got ${blocks}`,
    );
  }
  if (!Number.isFinite(rate.bookedMinutes) || rate.bookedMinutes <= 0) {
    // No denominator means no rate. Refusing is the only safe answer: a
    // guessed denominator is a wrong price, and this one gets charged to a
    // person mid-session.
    return 0;
  }
  if (!Number.isFinite(rate.planPricePaise) || rate.planPricePaise <= 0) {
    return 0;
  }

  const price = assertSafePaise(rate.planPricePaise, "planPricePaise");
  const booked = Math.round(rate.bookedMinutes);
  assertSafePaise(price * EXTEND_BLOCK_MIN * blocks, "block price");

  const floored = Math.floor((price * EXTEND_BLOCK_MIN * blocks) / booked);

  return floored < MIN_CHARGE_PAISE ? MIN_CHARGE_PAISE : floored;
}

/* -------------------------------------------------------------------------- */
/* The purchase: what was asked for, what was agreed, and whether it counts.   */
/* -------------------------------------------------------------------------- */

/**
 * The states a single overrun block moves through.
 *
 * `GRANTED` is the ONLY one that extends the window. That is the whole point of
 * the type: a consultee tapping "Accept" buys nothing, and money captured by a
 * webhook that has not been reconciled buys nothing. Overtime that nobody paid
 * for is unpaid labour with a receipt attached, which is the exact failure the
 * issue opens with.
 */
export type OverrunPurchaseState =
  /** The host asked for a block. Not yet visible to the consultee. */
  | "REQUESTED"
  /** Pushed to the consultee; inside the 60-second answer window. */
  | "AWAITING_CONSULTEE"
  /** The consultee said yes. No money has moved. */
  | "ACCEPTED"
  /** An acquirer is out; inside the pay window. */
  | "AWAITING_PAYMENT"
  /** Money is captured AND reconciled. This block's minutes are real. */
  | "GRANTED"
  /** The consultee said no. */
  | "DECLINED"
  /** No answer inside `CONSULTEE_RESPONSE_MS`. Treated as a decline. */
  | "EXPIRED"
  /** The acquirer failed, or the pay window lapsed. Not granted. */
  | "PAYMENT_FAILED";

/**
 * One block of overtime.
 *
 * `id` is the durable primary key and `blockIndex` is the idempotency key:
 * `(meetingId, blockIndex)` is unique, so a double tap or a retried request
 * cannot mint two purchases for the same minutes. The second writer adopts the
 * first (see `adoptConcurrentPurchase`) exactly as the R1 receipt pattern does.
 */
export interface OverrunPurchase {
  id: string;
  meetingId: string;
  /** 0-based block after the grace end. Unique per meeting. */
  blockIndex: number;
  minutes: number;
  /** Pre-tax base, in paise. GST is composed by the tax engine, not here. */
  amountPaise: number;
  state: OverrunPurchaseState;
  createdAt: Date;
  /** Stamped when the consultee answers, however it answers. */
  respondedAt?: Date | null;
  /** Stamped when the acquirer completes. The gate on GRANTED. */
  capturedAt?: Date | null;
  /** Payment row id, for the refund path. */
  paymentId?: string | null;
  /** Why it ended, for support and for the "free minutes given" metric. */
  reason?: string | null;
}

/** Illegal to move from, keyed by TARGET state. */
const PURCHASE_ALLOWED_FROM: Readonly<
  Record<OverrunPurchaseState, readonly OverrunPurchaseState[]>
> = {
  REQUESTED: [],
  AWAITING_CONSULTEE: ["REQUESTED"],
  ACCEPTED: ["AWAITING_CONSULTEE"],
  DECLINED: ["AWAITING_CONSULTEE", "AWAITING_PAYMENT"],
  AWAITING_PAYMENT: ["ACCEPTED"],
  GRANTED: ["AWAITING_PAYMENT"],
  EXPIRED: ["AWAITING_CONSULTEE", "AWAITING_PAYMENT"],
  PAYMENT_FAILED: ["AWAITING_PAYMENT"],
};

/**
 * A transition this module refused. Distinct from a provider failure: nothing
 * tried, and nothing changed.
 */
export class OverrunTransitionError extends Error {
  readonly code = "ILLEGAL_OVERRUN_TRANSITION";
  constructor(
    readonly from: OverrunPurchaseState,
    readonly to: OverrunPurchaseState,
  ) {
    super(`overrun purchase cannot move ${from} → ${to}`);
    this.name = "OverrunTransitionError";
  }
}

/** What the caller is asking the purchase to do. */
export type OverrunPurchaseEvent =
  | { type: "offer" }
  | { type: "accept"; at: Date }
  | { type: "decline"; at: Date; reason?: string }
  | { type: "expire"; at: Date; reason: string }
  | { type: "sendToAcquirer"; paymentId: string }
  | { type: "capture"; at: Date; paymentId?: string }
  | { type: "failPayment"; at: Date; reason: string };

/**
 * The purchase state machine, as a pure reducer over an allowed-from map.
 *
 * Keyed by TARGET, like `lib/booking/transitions.ts`, because the map is what
 * goes into the CAS `WHERE` clause in the durable adapter — the database is
 * supposed to refuse the same moves this function refuses, so a racing writer
 * and a sequential writer cannot disagree. An illegal transition throws rather
 * than silently returning the row unchanged, so a caller cannot mistake "the
 * CAS matched zero rows" for "fine, nothing to do".
 */
export function reduceOverrunPurchase(
  purchase: OverrunPurchase,
  event: OverrunPurchaseEvent,
): OverrunPurchase {
  const to = targetOf(event);
  const allowed = PURCHASE_ALLOWED_FROM[to];
  if (!allowed.includes(purchase.state)) {
    throw new OverrunTransitionError(purchase.state, to);
  }

  const next: OverrunPurchase = { ...purchase, state: to };

  switch (event.type) {
    case "accept":
      next.respondedAt = event.at;
      break;
    case "decline":
      next.respondedAt = event.at;
      next.reason = event.reason ?? "CONSULTEE_DECLINED";
      break;
    case "expire":
      next.respondedAt = event.at;
      next.reason = event.reason;
      break;
    case "sendToAcquirer":
      next.paymentId = event.paymentId;
      break;
    case "capture":
      // The gate. `GRANTED` is unreachable without a capturedAt, so a bug that
      // wrote the state directly is the only way to skip it.
      next.capturedAt = event.at;
      if (event.paymentId) next.paymentId = event.paymentId;
      break;
    case "failPayment":
      next.reason = event.reason;
      break;
    case "offer":
      break;
  }

  return next;
}

function targetOf(event: OverrunPurchaseEvent): OverrunPurchaseState {
  switch (event.type) {
    case "offer":
      return "AWAITING_CONSULTEE";
    case "accept":
      return "ACCEPTED";
    case "decline":
      return "DECLINED";
    case "expire":
      return "EXPIRED";
    case "sendToAcquirer":
      return "AWAITING_PAYMENT";
    case "capture":
      return "GRANTED";
    case "failPayment":
      return "PAYMENT_FAILED";
  }
}

/**
 * Force the time-driven deadlines: an unanswered offer becomes `EXPIRED`, a
 * lapsed acquirer becomes `EXPIRED`.
 *
 * Called on every read, so the deadline is enforced by whoever looks rather
 * than by a poller that might not be running. Idempotent — a purchase already
 * past a deadline is terminal and is returned untouched, so two readers racing
 * both get the same answer.
 */
export function settleOverrunPurchase(
  purchase: OverrunPurchase,
  now: Date,
  payWindowMs: number,
): OverrunPurchase {
  if (purchase.state === "AWAITING_CONSULTEE") {
    const deadline = purchase.createdAt.getTime() + CONSULTEE_RESPONSE_MS;
    if (now.getTime() >= deadline) {
      return reduceOverrunPurchase(purchase, {
        type: "expire",
        at: now,
        reason: "CONSULTEE_TIMEOUT",
      });
    }
  }
  if (purchase.state === "AWAITING_PAYMENT") {
    const deadline =
      purchase.respondedAt?.getTime() ?? purchase.createdAt.getTime();
    if (now.getTime() >= deadline + payWindowMs) {
      return reduceOverrunPurchase(purchase, {
        type: "expire",
        at: now,
        reason: "PAYMENT_WINDOW_LAPSED",
      });
    }
  }
  return purchase;
}

/**
 * A fresh block request, before anything has been offered to anyone.
 *
 * `REQUESTED` is the only state this module creates, and it is created here and
 * nowhere else — every other state is reached through `reduceOverrunPurchase`,
 * so "how did this row get to GRANTED" has exactly one answer to audit.
 */
export function newOverrunPurchase(args: {
  meetingId: string;
  blockIndex: number;
  minutes?: number;
  amountPaise: number;
  now: Date;
}): OverrunPurchase {
  return {
    id: "",
    meetingId: args.meetingId,
    blockIndex: args.blockIndex,
    minutes: args.minutes ?? EXTEND_BLOCK_MIN,
    amountPaise: args.amountPaise,
    state: "REQUESTED",
    createdAt: args.now,
  };
}

/**
 * Two writers, one block. The loser adopts the winner's row.
 *
 * This is the in-process half of the `(meetingId, blockIndex)` unique: the
 * durable half is a P2002 from the insert, and this is what a handler does with
 * the row it finds afterwards. Both halves return the SAME purchase for the same
 * block, so a double tap charges once and extends once.
 */
export function resolveIdempotentBlock(args: {
  /** The row already stored for `(meetingId, blockIndex)`, if any. */
  existing: OverrunPurchase | null;
  /** The row this writer intends to insert. */
  proposed: OverrunPurchase;
}): { purchase: OverrunPurchase; adopted: boolean } {
  return args.existing
    ? { purchase: args.existing, adopted: true }
    : { purchase: args.proposed, adopted: false };
}

/** Only these minutes are real. Everything else is a promise or a receipt. */
export function grantedMinutesFor(
  purchases: readonly OverrunPurchase[],
): number {
  return purchases
    .filter((p) => p.state === "GRANTED" && p.capturedAt !== null)
    .reduce((sum, p) => sum + p.minutes, 0);
}

/* -------------------------------------------------------------------------- */
/* The back-to-back guard                                                      */
/* -------------------------------------------------------------------------- */

export interface ExtensionCap {
  /** Whole blocks the host may buy, already limited by the gap and the stop. */
  blocks: number;
  /** True when a following booking is what shrank the allowance. */
  limitedByNextBooking: boolean;
  /** Minutes before the next booking, or null when there is none. */
  minutesBeforeNext: number | null;
  /** Copy for the host BEFORE they accept. Never after the fact. */
  warning: string | null;
}

/**
 * How much overtime this host may sell, given the next thing on their calendar.
 *
 * The issue's guard: if the consultant's next occurrence starts less than a
 * block after the extension would end, warn them before they accept and cap the
 * extension to the gap. Selling a 15-minute block that runs into a booked
 * client does not create revenue — it creates a no-show and a refund, and it is
 * the single most reliable way to make a consultant stop trusting the feature.
 *
 * `hardStopAt` participates too, and for the same reason: minutes past the SFU
 * duration cap are minutes nobody gets. In this PR the cap is an input (see
 * the module header), so the honest rule is to refuse to sell past a stop we
 * cannot move — and to report the missing integration rather than quietly
 * selling dead air.
 */
export function extensionCapFor(args: {
  bookedEndsAt: Date;
  now: Date;
  nextOccurrenceStartsAt: Date | null;
  hardStopAt: Date | null;
}): ExtensionCap {
  const gapMs = args.nextOccurrenceStartsAt
    ? args.nextOccurrenceStartsAt.getTime() - args.bookedEndsAt.getTime()
    : null;

  // Blocks that fit before the next booking. A partial trailing block is not
  // sellable — the block size is the product, not a rounding convenience.
  const blocksByNext =
    gapMs === null
      ? Number.POSITIVE_INFINITY
      : Math.max(0, Math.floor(gapMs / EXTEND_BLOCK_MS));

  const blocksByStop = (() => {
    if (!args.hardStopAt) return Number.POSITIVE_INFINITY;
    const roomMs =
      args.hardStopAt.getTime() -
      Math.max(args.now.getTime(), args.bookedEndsAt.getTime());
    return Math.max(0, Math.floor(roomMs / EXTEND_BLOCK_MS));
  })();

  const blocks = Math.max(0, Math.min(blocksByNext, blocksByStop));
  const limitedByNextBooking = blocksByNext < blocksByStop;
  const minutesBeforeNext = gapMs === null ? null : Math.floor(gapMs / 60_000);

  return {
    blocks,
    limitedByNextBooking,
    minutesBeforeNext,
    warning:
      limitedByNextBooking && minutesBeforeNext !== null
        ? `Your next session starts in ${minutesBeforeNext} min — the extension is capped to fit before it.`
        : null,
  };
}

/* -------------------------------------------------------------------------- */
/* The ladder                                                                  */
/* -------------------------------------------------------------------------- */

/** Where a live session sits on the ladder. Ordered most-urgent first. */
export type OverrunRung =
  /** No booked end stamped on the call — the ladder cannot be placed. */
  | "unknown"
  /** Booked run still going, more than five minutes left. */
  | "in-progress"
  /** T-5. The pill is amber and the copy says to wrap up. */
  | "wrapping-up"
  /** T+0. Free grace is running. */
  | "grace"
  /** Grace is over, nothing purchased. The host may sell a block or end. */
  | "grace-expired"
  /** A purchased block is running. */
  | "extended"
  /** Inside two minutes of the hard stop. Announced, not yet acted on. */
  | "hard-close-warning"
  /** At or past the hard stop. */
  | "closed"
  /** Before the booked start. */
  | "not-started";

export interface OverrunLadder {
  rung: OverrunRung;
  /** One line for the pill. Short. */
  status: string;
  /**
   * The banner, when there is one worth showing. `null` on the quiet rungs —
   * a banner that says nothing is noise, and this feature's whole claim is
   * that the previous behaviour was silent.
   */
  banner: string | null;
  /** Free-grace end for this meeting, derived. Null when there is no slot end. */
  grace: OverrunGrace | null;
  /** When the announcement must already have been delivered. */
  hardStopAt: Date | null;
  /** Milliseconds to the hard stop, or null when there is none to count to. */
  msToHardStop: number | null;
  /** Overtime blocks already paid for and reconciled. */
  grantedMinutes: number;
  /** What the host may sell right now, after the gap and the stop. */
  offer: ExtensionCap;
  /** Pre-tax base of one block, in paise. Zero when nothing may be sold. */
  blockPricePaise: number;
  /**
   * Whether the host may open the extension modal at all.
   *
   * False before grace ends (there is nothing to sell yet), false once the stop
   * is inside the announcement window (the minutes would be dead air), and
   * false when `blocks` is zero for any reason.
   */
  canRequestBlock: boolean;
}

export interface OverrunLadderInput {
  meetingId: string;
  startsAt: Date | null;
  /** `Meeting.occurrence.endsAt`. The anchor for the whole ladder. */
  bookedEndsAt: Date | null;
  now: Date;
  /**
   * When Stream's duration cap fires, if the caller can say.
   *
   * Deliberately an INPUT. See the module header: `duration-cap.ts` is not
   * imported here because `sync-call-window.ts` can currently leave a stale cap
   * in place, and a ladder that warns about a deadline the server does not
   * hold is worse than no ladder. When the cap sync is fixed, the caller
   * derives this from `resolveMaxCallDurationSeconds` and nothing here changes.
   */
  hardStopAt?: Date | null;
  /** Durable purchases for this meeting. Only GRANTED ones count. */
  purchases?: readonly OverrunPurchase[];
  nextOccurrenceStartsAt?: Date | null;
  rate?: OverrunRate | null;
  /** Trials do not sell overtime; a plan opts in explicitly. */
  extensionEnabled?: boolean;
}

/**
 * Where the session is on the ladder right now.
 *
 * Rungs are evaluated most-urgent-first, so the stop always outranks the
 * ladder's softer states: a purchased block does not survive the hard stop,
 * and the announcement is never suppressed by an active extension.
 */
export function resolveOverrunLadder(input: OverrunLadderInput): OverrunLadder {
  const grace = resolveOverrunGrace({
    meetingId: input.meetingId,
    bookedEndsAt: input.bookedEndsAt,
  });

  const fallbackStop = input.bookedEndsAt
    ? new Date(input.bookedEndsAt.getTime() + OVERRUN_JOIN_BACKSTOP_MS)
    : null;
  const hardStopAt = input.hardStopAt ?? fallbackStop;

  const offer: ExtensionCap = input.bookedEndsAt
    ? extensionCapFor({
        bookedEndsAt: input.bookedEndsAt,
        now: input.now,
        nextOccurrenceStartsAt: input.nextOccurrenceStartsAt ?? null,
        hardStopAt,
      })
    : {
        blocks: 0,
        limitedByNextBooking: false,
        minutesBeforeNext: null,
        warning: null,
      };

  const grantedMinutes = grantedMinutesFor(input.purchases ?? []);

  const blockPricePaise =
    input.rate && offer.blocks >= MIN_EXTENSION_BLOCKS
      ? proRataBasePaiseForBlock(input.rate, MIN_EXTENSION_BLOCKS)
      : 0;

  const base: Omit<
    OverrunLadder,
    "rung" | "status" | "banner" | "canRequestBlock"
  > = {
    grace,
    hardStopAt,
    msToHardStop: hardStopAt
      ? hardStopAt.getTime() - input.now.getTime()
      : null,
    grantedMinutes,
    offer,
    blockPricePaise,
  };

  if (!grace || !hardStopAt || !input.bookedEndsAt) {
    return {
      ...base,
      rung: "unknown",
      status: "",
      banner: null,
      canRequestBlock: false,
    };
  }

  const endsAtMs = input.bookedEndsAt.getTime();
  const nowMs = input.now.getTime();
  // Grace can never outlive the stop. A caller supplying a stop tighter than
  // the grace (a very short cap, a 10-minute booking with a 12-minute stop)
  // gets the tighter of the two rather than a grace window that outlives the
  // call it is protecting.
  const graceEndsAtMs = Math.min(grace.endsAt.getTime(), hardStopAt.getTime());
  const extensionEndsAtMs =
    grantedMinutes > 0 ? graceEndsAtMs + grantedMinutes * 60_000 : null;

  if (nowMs >= hardStopAt.getTime()) {
    return {
      ...base,
      rung: "closed",
      status: "Call ended",
      banner: null,
      canRequestBlock: false,
    };
  }

  if (hardStopAt.getTime() - nowMs <= HARD_CLOSE_WARN_MS) {
    return {
      ...base,
      rung: "hard-close-warning",
      status: `Call ends in ${Math.max(
        1,
        Math.ceil((hardStopAt.getTime() - nowMs) / 60_000),
      )} min`,
      banner: `This call ends in ${Math.max(
        1,
        Math.ceil((hardStopAt.getTime() - nowMs) / 60_000),
      )} minutes. Wrap up now — it will close for everyone.`,
      canRequestBlock: false,
    };
  }

  if (extensionEndsAtMs !== null && nowMs < extensionEndsAtMs) {
    const leftMin = Math.max(
      1,
      Math.ceil((extensionEndsAtMs - nowMs) / 60_000),
    );
    return {
      ...base,
      rung: "extended",
      status: `${leftMin} min of paid extension left`,
      banner: `Extended — ${leftMin} min left on the paid extension.`,
      canRequestBlock: false,
    };
  }

  if (nowMs >= graceEndsAtMs) {
    return {
      ...base,
      rung: "grace-expired",
      status: "Overtime is billable now",
      banner:
        "Free grace has ended. End the session, or extend it — overtime is billed in 15-minute blocks once you agree.",
      canRequestBlock:
        input.extensionEnabled !== false &&
        offer.blocks >= MIN_EXTENSION_BLOCKS &&
        blockPricePaise > 0,
    };
  }

  if (nowMs >= endsAtMs) {
    const freeLeftMin = Math.max(
      1,
      Math.ceil((graceEndsAtMs - nowMs) / 60_000),
    );
    return {
      ...base,
      rung: "grace",
      status: `${freeLeftMin} min of free grace`,
      banner: `You're in grace — free for ${freeLeftMin} more min. Overtime after that is billed in ${EXTEND_BLOCK_MIN}-minute blocks, and only if you agree to it.`,
      canRequestBlock: false,
    };
  }

  if (endsAtMs - nowMs <= OVERRUN_WARN_MS) {
    return {
      ...base,
      rung: "wrapping-up",
      status: `${Math.max(1, Math.ceil((endsAtMs - nowMs) / 60_000))} min left — start wrapping up`,
      banner: null,
      canRequestBlock: false,
    };
  }

  const startsAtMs = input.startsAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  if (nowMs >= startsAtMs) {
    return {
      ...base,
      rung: "in-progress",
      status: "",
      banner: null,
      canRequestBlock: false,
    };
  }

  return {
    ...base,
    rung: "not-started",
    status: "",
    banner: null,
    canRequestBlock: false,
  };
}

/* -------------------------------------------------------------------------- */
/* The announced hard close                                                    */
/* -------------------------------------------------------------------------- */

/** What the room is told before anything happens to it. */
export interface HardCloseNotice {
  headline: string;
  body: string;
  /** Seconds left at the moment the notice was composed. */
  secondsRemaining: number;
  /** How many people are still connected — the reason the copy says "everyone". */
  participantCount: number;
}

export type HardCloseStep =
  | { step: "announce"; notice: HardCloseNotice; at: Date }
  | {
      step: "end-call";
      reason: "duration_cap_reached";
      at: Date;
      participants: readonly string[];
    };

export interface HardCloseInput {
  now: Date;
  hardStopAt: Date;
  /** Who is still in the room. Empty means "nobody is there to warn". */
  participants: readonly string[];
  /**
   * When the notice was DELIVERED, durably stamped by the caller.
   *
   * `null` means nobody has been told yet, and that is the single fact this
   * whole function exists to respect: while it is null the call is not ended,
   * however far past the stop `now` is.
   */
  announcedAt: Date | null;
}

/**
 * The two steps a hard close is allowed to take, in order.
 *
 * A session that dies at an unannounced `max_duration_seconds` reads as a
 * platform crash, and the issue names that as the source of the support load.
 * So the end is conditional on the announcement having been DELIVERED, and the
 * condition is checked against a caller-stamped `announcedAt` rather than
 * against a local variable — a flag that lives in the same invocation as the
 * end would be set by the same invocation that ends, which is exactly the
 * ordering bug this guards against.
 *
 * `HARD_CLOSE_ESCALATION_MS` bounds the other failure: an instance that
 * announces and then dies must not leave the call open forever. Past that, the
 * call closes on a notice that is already out.
 */
export function planHardClose(input: HardCloseInput): HardCloseStep[] {
  const msToStop = input.hardStopAt.getTime() - input.now.getTime();

  if (input.announcedAt === null) {
    if (msToStop > HARD_CLOSE_WARN_MS) return [];
    const secondsRemaining = Math.max(0, Math.ceil(msToStop / 1000));
    return [
      {
        step: "announce",
        at: input.now,
        notice: {
          headline: "This call is ending",
          body:
            input.participants.length > 0
              ? `${input.participants.length === 1 ? "Someone is" : `${input.participants.length} people are`} still connected. Say your goodbyes — the call closes for everyone in ${secondsRemaining >= 60 ? `${Math.ceil(secondsRemaining / 60)} minutes` : `${secondsRemaining} seconds`}.`
              : "The room is empty. The call will close for everyone shortly.",
          secondsRemaining,
          participantCount: input.participants.length,
        },
      },
    ];
  }

  const sinceAnnouncement = input.now.getTime() - input.announcedAt.getTime();
  const mayEnd = msToStop <= 0 && sinceAnnouncement >= HARD_CLOSE_ESCALATION_MS;

  return mayEnd
    ? [
        {
          step: "end-call",
          reason: "duration_cap_reached",
          at: input.now,
          participants: [...input.participants],
        },
      ]
    : [];
}

/* -------------------------------------------------------------------------- */
/* The purchase, as a view                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What the block in flight means, from a seat's point of view.
 *
 * `"none"` is the no-purchase-yet case, and it is deliberately NOT named
 * "requestable": whether a block can be requested at all depends on the LADDER
 * (`canRequestBlock` — the back-to-back guard, the hard stop, the rate, the
 * plan's opt-in), which this view cannot see. Keeping the two apart stops the
 * modal from offering a button the server would refuse.
 */
export type OverrunPurchaseStage =
  | "none"
  | "awaiting-consultee"
  | "accepted-awaiting-payment"
  | "granted"
  | "declined"
  | "expired"
  | "payment-failed";

/**
 * What each seat should be shown, and whether the minutes are real.
 *
 * Kept separate from `OverrunPurchase` on purpose: the record is the money
 * system's business and may carry ids nobody in the room should see, while
 * this is copy plus one boolean. `extendsWindow` is the boolean the ladder
 * consumes, and it is false for everything except `granted`.
 */
export interface OverrunPurchaseView {
  stage: OverrunPurchaseStage;
  extendsWindow: boolean;
  /** Seconds left on the consultee's answer window, or null. */
  secondsToAnswer: number | null;
  /** Copy for the person being asked. Null when nobody is being asked. */
  prompt: string | null;
  /** Copy for whoever is waiting. Null when nobody is waiting. */
  outcome: string | null;
}

export function readOverrunPurchaseView(
  purchase: OverrunPurchase | null,
  now: Date,
  payWindowMs: number,
): OverrunPurchaseView {
  if (!purchase) {
    return {
      stage: "none",
      extendsWindow: false,
      secondsToAnswer: null,
      prompt: null,
      outcome: null,
    };
  }

  const settled = settleOverrunPurchase(purchase, now, payWindowMs);
  const deadline = purchase.createdAt.getTime() + CONSULTEE_RESPONSE_MS;

  switch (settled.state) {
    case "REQUESTED":
    case "AWAITING_CONSULTEE":
      return {
        stage: "awaiting-consultee",
        extendsWindow: false,
        secondsToAnswer: Math.max(
          0,
          Math.ceil((deadline - now.getTime()) / 1000),
        ),
        prompt: `Extend this session by ${EXTEND_BLOCK_MIN} minutes? Overtime after the free grace is billed in ${EXTEND_BLOCK_MIN}-minute blocks. You have ${CONSULTEE_RESPONSE_MS / 1000} seconds to answer — no answer is a no.`,
        outcome: null,
      };
    case "ACCEPTED":
    case "AWAITING_PAYMENT":
      return {
        stage: "accepted-awaiting-payment",
        // Accepted but not captured is not paid for. This is the assertion the
        // issue's "payment fails mid-call" edge case turns on.
        extendsWindow: false,
        secondsToAnswer: null,
        prompt: null,
        outcome:
          "Agreed — taking payment now. The extra minutes start once payment completes.",
      };
    case "GRANTED":
      return {
        stage: "granted",
        extendsWindow: settled.capturedAt !== null,
        secondsToAnswer: null,
        prompt: null,
        outcome: `Extended by ${settled.minutes} min.`,
      };
    case "DECLINED":
      return {
        stage: "declined",
        extendsWindow: false,
        secondsToAnswer: null,
        prompt: null,
        outcome: "Declined — no extra charge. Wrap up when you're ready.",
      };
    case "EXPIRED":
      return {
        stage: "expired",
        extendsWindow: false,
        secondsToAnswer: null,
        prompt: null,
        outcome:
          settled.reason === "CONSULTEE_TIMEOUT"
            ? "No response — no extra charge. Wrap up when you're ready."
            : "Payment was not completed — no extra charge. Wrap up when you're ready.",
      };
    case "PAYMENT_FAILED":
      return {
        stage: "payment-failed",
        extendsWindow: false,
        secondsToAnswer: null,
        prompt: null,
        outcome: "Payment failed — no extra charge.",
      };
  }
}
