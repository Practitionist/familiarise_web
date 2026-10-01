/**
 * #1838 — the only overrun module allowed to touch the database.
 *
 * `lib/meetings/overrun.ts` is pure on purpose: it holds the ladder, the money
 * arithmetic, the state machine and the announced hard close, and it can be
 * asserted at an exact millisecond without a database, a Stream client, or a
 * wall clock. This file is the other half — the two things that genuinely must
 * be durable and genuinely must consult the booking.
 *
 * ## Why authority is not decided here
 *
 * #1270 moved "may this user join this meeting" into `resolveMeetingAccess`
 * because identity alone was never sufficient: identity alone let a valid
 * participant days early, after cancellation, and into an unpaid tentative
 * booking, because every one of those rules lived only in React. A THIRD copy of
 * "who is allowed" — one that asks only "is this user the consultant" — would
 * reopen exactly that hole in a narrower keyhole: the host could extend a
 * session whose booking had been cancelled, or whose slot had already been
 * released.
 *
 * So this file asks the existing resolver and then narrows its answer to
 * `role === "host"`. It does not re-derive the role, does not re-read the plan's
 * consultant, and does not consult the SDK's `hostUserIds` (a client hint, never
 * an authority). `resolveMeetingAccess` already grants `host` to the consultant
 * AND to an accepted presenter collaborator, which is the correct reading of
 * "an authorised role" for extension: the people who may end the call for
 * everyone are the people who may buy more of it.
 *
 * ## What is deliberately NOT here
 *
 * **No Prisma writes.** The durable side of a purchase needs a table —
 * `OverrunPurchase { meetingId, blockIndex, minutes, amountPaise, state, ... }`
 * with a unique on `(meetingId, blockIndex)` for the double-tap guard. That is a
 * `prisma/schema.prisma` change, and schema is out of scope for this change;
 * writing to a model that does not exist is a build failure, not a deferral. The
 * port below is the contract the adapter must satisfy, and
 * `lib/meetings/overrun.ts` is already written to consume it.
 *
 * **No payment call.** A granted block is `AWAITING_PAYMENT → GRANTED`, driven
 * by the EXISTING confirmation pipeline rather than a new path: the money must
 * land through `lib/payments/` so it picks up a Payment row, a payment leg, the
 * earnings split and the refund trail for free. A second acquirer path invented
 * here would be the one thing the finance doctrine forbids outright — money
 * truth is written in exactly one transaction per event.
 *
 * What is here instead is the SEAM: `requireOverrunHost` is exactly the guard a
 * `POST /api/meetings/[id]/extend` route needs, and it is testable without a
 * route existing.
 */

import { resolveMeetingAccess, type MeetingRole } from "@/lib/meetings/access";
import prisma from "@/lib/prisma";
import type {
  OverrunPurchase,
  OverrunPurchaseState,
} from "@/lib/meetings/overrun";

/**
 * Why an extension was refused. Stable values — the route maps these to HTTP
 * statuses, and rewording a message must never become a 403→404 flip.
 */
export type OverrunAuthorityRefusal =
  | "not_found"
  | "unauthorized"
  /** Authorized to be in the room, but not to decide for the room. */
  | "not_host"
  /** The booking cannot be priced, so nothing may be sold against it. */
  | "unpriceable";

export type OverrunAuthority =
  | {
      ok: true;
      userId: string;
      /** The `Meeting` row id. NOT the `/meetings/[id]` call id. */
      meetingId: string;
      streamCallId: string;
      /** Booked run end — the anchor the whole ladder is derived from. */
      bookedEndsAt: Date;
      /** Booked run start, for the pro-rata denominator. */
      startsAt: Date;
      /**
       * Plan price and the minutes it covers, for `proRataBasePaiseForBlock`.
       * `null` for a trial: there is no rate, so nothing is quotable.
       */
      rate: { planPricePaise: number; bookedMinutes: number } | null;
      /**
       * Whether this booking may sell overtime at all.
       *
       * Trials default OFF, mirroring `recordingEnabled`: a free introductory
       * session is not the place to introduce a paywall mid-call, and the first
       * time a learner sees "would you like to pay more?" it should be a
       * decision somebody made deliberately.
       */
      extensionEnabled: boolean;
    }
  | { ok: false; refusal: OverrunAuthorityRefusal; message: string };

/**
 * The one read this module needs beyond the access check.
 *
 * `resolveMeetingAccess` deliberately returns only the APPOINTMENT (so it can
 * be handed to consent handlers without re-querying), which means the slot's
 * own times and the plan's price are not in its result. Both are needed here:
 * `occurrence.endsAt` is the anchor the whole ladder is derived from — it is the
 * only value every invocation is guaranteed to read identically — and the plan
 * price is the denominator of the pro-rata. One read of the meeting row with the
 * occurrence nested; sequential queries, never nested, because the pool is
 * capped at one connection per function instance and a nested read inside a
 * transaction would deadlock.
 */
const OVERRUN_CONTEXT_SELECT = {
  id: true,
  occurrence: {
    select: {
      startsAt: true,
      endsAt: true,
      appointment: {
        select: {
          trial: { select: { id: true } },
          consultation: {
            select: { consultationPlan: { select: { price: true } } },
          },
          subscription: {
            select: { subscriptionPlan: { select: { price: true } } },
          },
          webinar: { select: { webinarPlan: { select: { price: true } } } },
          class: { select: { classPlan: { select: { price: true } } } },
        },
      },
    },
  },
} as const;

/**
 * Authorize an extension request, and return everything the caller needs to
 * price and place it.
 *
 * `callId` is the `/meetings/[id]` segment — the Stream call id, NOT the
 * `Meeting` row id — because that is what `resolveMeetingAccess` resolves and
 * what a route's params carry. Swapping them is the silent-404 class of bug the
 * split-call-cid helper exists to prevent.
 */
export async function requireOverrunHost(args: {
  callId: string;
  userId: string;
}): Promise<OverrunAuthority> {
  const access = await resolveMeetingAccess(args.callId, args.userId);

  if (!access.hasAccess) {
    return {
      ok: false,
      refusal: access.reason === "not_found" ? "not_found" : "unauthorized",
      message: access.message,
    };
  }

  if (access.role !== "host") {
    // A participant is in the room and is entitled to be ASKED for consent —
    // but asking is the consultee's job, not theirs. Same rule as "End for
    // everyone": one decision, one person.
    return {
      ok: false,
      refusal: "not_host",
      message: "Only the host can extend this session.",
    };
  }

  const meeting = await prisma.meeting.findUnique({
    where: { streamCallId: args.callId },
    select: OVERRUN_CONTEXT_SELECT,
  });

  // Access said yes from a row that has since been deleted out from under it.
  // Refusing is the only safe direction: the grant we are about to act on no
  // longer has a booking behind it.
  if (!meeting) {
    return {
      ok: false,
      refusal: "not_found",
      message: "Meeting not found",
    };
  }

  const { occurrence } = meeting;
  const appointment = occurrence.appointment;
  const planPricePaise =
    appointment.consultation?.consultationPlan?.price ??
    appointment.subscription?.subscriptionPlan?.price ??
    appointment.webinar?.webinarPlan?.price ??
    appointment.class?.classPlan?.price ??
    null;

  const bookedMinutes = Math.max(
    Math.round(
      (occurrence.endsAt.getTime() - occurrence.startsAt.getTime()) / 60_000,
    ),
    0,
  );

  const isTrial = appointment.trial !== null;

  // A trial is a normal refusal with a normal reason, not an error: it is
  // authorized, and it simply does not sell overtime. `rate: null` plus
  // `extensionEnabled: false` is what the ladder turns into "no price, no
  // offer" — the same shape as an unpriced plan, reached without inventing a
  // second rejection path.
  if (isTrial) {
    return {
      ok: true,
      userId: args.userId,
      meetingId: meeting.id,
      streamCallId: args.callId,
      bookedEndsAt: occurrence.endsAt,
      startsAt: occurrence.startsAt,
      rate: null,
      extensionEnabled: false,
    };
  }

  // A paid booking whose plan carries no price is a data defect, not a policy
  // decision, and it is reported as one. A guessed price charged mid-call is
  // worse than no extension at all.
  if (planPricePaise === null || planPricePaise <= 0) {
    return {
      ok: false,
      refusal: "unpriceable",
      message:
        "This session has no priceable plan, so overtime cannot be billed.",
    };
  }

  return {
    ok: true,
    userId: args.userId,
    meetingId: meeting.id,
    streamCallId: args.callId,
    bookedEndsAt: occurrence.endsAt,
    startsAt: occurrence.startsAt,
    rate: { planPricePaise, bookedMinutes },
    extensionEnabled: true,
  };
}

/**
 * The durable side of a purchase.
 *
 * Everything here must survive the Lambda. `lib/meetings/overrun.ts` needs no
 * store for its grace state (that is derived, which is the point) but a purchase
 * is a fact about money and must be a row.
 *
 * ## Contract the adapter owes
 *
 * 1. **`create` MUST be protected by a unique index on `(meetingId,
 *    blockIndex)`** and MUST surface the violation as a catchable unique error
 *    (P2002 from Prisma). The handler re-reads the row and returns it, which is
 *    how a double tap charges once and extends once. A find-then-create without
 *    the index races, and the race charges a consultee twice for fifteen minutes.
 * 2. **`compareAndSetState` MUST put `from` inside its WHERE clause**, never in a
 *    prior read. The allowed-from map in `overrun.ts` is the same set; the
 *    database is what makes two concurrent writers agree, and a read-then-write
 *    lets them disagree silently.
 * 3. **No provider call inside any transaction**, and nothing inside a
 *    `$transaction` may read through the global Prisma client — the pool is
 *    capped at one connection per function instance (`PG_POOL_MAX=1`), so a
 *    nested read deadlocks instead of failing. The acquirer call belongs after
 *    commit, and `after()` is best-effort, so it must be re-drivable.
 * 4. **No module-scope cache of reads.** Per-instance, discarded on freeze,
 *    invisible to a concurrent invocation. Every read goes to the row.
 */
export interface OverrunPurchaseStore {
  findByBlock(args: {
    meetingId: string;
    blockIndex: number;
  }): Promise<OverrunPurchase | null>;

  listForMeeting(meetingId: string): Promise<OverrunPurchase[]>;

  /** Rejects with a unique-violation when the block already exists. */
  create(purchase: OverrunPurchase): Promise<OverrunPurchase>;

  /**
   * CAS-in-WHERE. Returns the number of rows moved — 0 means someone else got
   * there first, which is an ordinary outcome and never an error.
   */
  compareAndSetState(args: {
    id: string;
    from: readonly OverrunPurchaseState[];
    to: OverrunPurchaseState;
    patch: Partial<OverrunPurchase>;
  }): Promise<number>;
}

/**
 * Who may be shown the consultant's extension prompt.
 *
 * Exported so the route has one place to branch, and so its answer cannot drift
 * from `requireOverrunHost`'s — both read `MeetingRole` rather than each
 * re-deciding what a role means.
 */
export function mayAnswerExtensionPrompt(
  role: MeetingRole,
): role is Exclude<MeetingRole, null> {
  return role !== null;
}
