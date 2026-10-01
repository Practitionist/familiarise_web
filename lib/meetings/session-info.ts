"use client";

/**
 * #1838 — the client half of the overrun ladder.
 *
 * `lib/meetings/overrun.ts` is pure, so the only thing this file adds is the
 * one thing a pure module cannot have: a clock. Everything else — the rungs,
 * the copy, the money, the deadlines — is the pure module's, which is what
 * makes the boundaries assertable in a node-environment test while the screens
 * consume exactly the same code.
 *
 * ## Two things it deliberately does NOT do
 *
 * **It does not extend `app/meetings/[id]/session-info.ts`.** That file's
 * `readClock` is the booked-session clock: how long until we start, how long is
 * left, how long have we been here. The ladder is a different question — what
 * happens AFTER that clock runs out — and it needs a different anchor (the
 * hard stop) and a different set of facts (what has been paid for). Folding it
 * into the existing phases would have meant every consumer of the clock
 * inherited an `overrunning` state it could not act on. The rung names are
 * therefore this module's own, and `wrapping-up` here is not the clock's.
 *
 * **It does not fetch anything.** Purchases, the plan rate, the next occurrence
 * and the hard stop are all arguments. They come from a server component today;
 * once `POST /api/meetings/[id]/extend` exists they can come from a route
 * instead. Either way there is exactly one place they are read, and it is not
 * inside a ticking interval — the issue's load requirement is that no new poller
 * is added, and server state is fetched once per transition rather than once a
 * second.
 */

import { useEffect, useMemo, useState } from "react";
import {
  OVERRUN_GRACE_MS,
  readOverrunPurchaseView,
  resolveOverrunLadder,
  type OverrunLadder,
  type OverrunPurchase,
  type OverrunPurchaseView,
  type OverrunRate,
} from "@/lib/meetings/overrun";

export interface OverrunLadderState {
  ladder: OverrunLadder;
  /** What the block in flight means to the person looking at it. */
  purchase: OverrunPurchaseView;
  /** The purchase record itself, for the route calls. */
  record: OverrunPurchase | null;
}

export interface UseOverrunLadderInput {
  /** `Meeting.occurrence.endsAt`, as read by the server. */
  bookedEndsAt: Date | null;
  startsAt?: Date | null;
  /** Durable purchases for this meeting. Only GRANTED ones extend anything. */
  purchases?: readonly OverrunPurchase[];
  /**
   * When Stream's duration cap fires, if it is known.
   *
   * The caller derives this from `resolveMaxCallDurationSeconds` once
   * `lib/meetings/sync-call-window.ts` stops being able to leave a stale cap in
   * place — see the header of `lib/meetings/overrun.ts`. Until then `null` is
   * correct and safe: the ladder falls back to its own join backstop rather than
   * announcing a deadline the server does not hold.
   */
  hardStopAt?: Date | null;
  nextOccurrenceStartsAt?: Date | null;
  rate?: OverrunRate | null;
  extensionEnabled?: boolean;
  /** How long an agreed block may sit with an acquirer before it lapses. */
  payWindowMs?: number;
  /** Injectable for tests; defaults to the system clock. */
  now?: () => Date;
}

/**
 * A ticking read of the ladder.
 *
 * One second, for the same reason `useSessionClock` ticks one second: the
 * hard-close countdown and the consultee's answer window are shown in seconds,
 * and a minute-granular tick makes a 60-second deadline look like 60 seconds for
 * a minute. It is a local interval, not a poller — no request is made from here
 * and nothing is cached across renders.
 *
 * FOLLOW-UP: `MeetingRoom` already runs a 1 s interval for `useSessionClock`,
 * so a room showing both runs two. Folding this into a single shared ticker is
 * the right shape and needs a change to `app/meetings/[id]/session-info.ts`,
 * which this change does not own.
 */
export function useOverrunLadder(
  input: UseOverrunLadderInput,
): OverrunLadderState {
  const [now, setNow] = useState(() => (input.now ?? (() => new Date()))());

  useEffect(() => {
    const id = setInterval(
      () => setNow((input.now ?? (() => new Date()))()),
      1000,
    );
    return () => clearInterval(id);
    // `input.now` is a test seam, not a dependency of the tick's meaning.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { purchases = [], payWindowMs = 10 * 60 * 1000 } = input;

  return useMemo(() => {
    const record =
      purchases.length > 0 ? purchases[purchases.length - 1] : null;
    return {
      ladder: resolveOverrunLadder({
        meetingId: "",
        startsAt: input.startsAt ?? null,
        bookedEndsAt: input.bookedEndsAt,
        now,
        hardStopAt: input.hardStopAt ?? null,
        purchases,
        nextOccurrenceStartsAt: input.nextOccurrenceStartsAt ?? null,
        rate: input.rate ?? null,
        extensionEnabled: input.extensionEnabled,
      }),
      purchase: readOverrunPurchaseView(record, now, payWindowMs),
      record,
    };
    // `now` is the point: everything else is a prop that does not change on a
    // tick, and re-deriving on every parent render is what the memo avoids.
  }, [
    now,
    input.bookedEndsAt,
    input.startsAt,
    input.hardStopAt,
    input.nextOccurrenceStartsAt,
    input.rate,
    input.extensionEnabled,
    payWindowMs,
    purchases,
  ]);
}

/**
 * When free grace ends, for a banner that wants to say so in one line.
 *
 * Exported separately because the lobby — which has no call to be warned about
 * — still wants to tell someone "your free overrun ends at HH:MM".
 */
export function graceEndsAtLabel(
  bookedEndsAt: Date | null,
  format: (d: Date) => string,
): string | null {
  if (!bookedEndsAt) return null;
  return format(new Date(bookedEndsAt.getTime() + OVERRUN_GRACE_MS));
}
