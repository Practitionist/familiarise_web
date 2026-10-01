"use client";

/**
 * #1838 — the rung banner, and the hard-close notice.
 *
 * The hole the issue opens with is a session that "dies mid-sentence with no
 * warning, no billing event, no announcement", which "reads as a platform
 * crash". So this is not a cosmetic addition: it is the difference between a
 * call that ends and a call that ends.
 *
 * ## Presentation rules, all of them earned from the issue
 *
 * - **Amber, never red, until the stop is imminent.** A T+0 overrun banner is
 *   free time. Painting it as a failure teaches people to ignore it, and then
 *   the one banner that matters — "call ends in 2 min" — is the one they have
 *   learned to dismiss.
 * - **The countdown is stated as ending, not as a number.** "Call ends in 2
 *   min" is actionable; "1:58 remaining" is not.
 * - **Silence on the quiet rungs.** `banner` is null for in-progress, before
 *   start, and closed. A banner that says nothing is the noise this feature
 *   exists to replace.
 * - **The hard-close notice is rendered from a `HardCloseNotice`, not
 *   recomputed.** Whoever delivers the announcement and whoever closes the call
 *   must describe the same thing to the room; a banner that derived its own
 *   countdown from `Date.now()` could disagree with the server by a second and
 *   read as "I was told thirty seconds and I got twelve".
 *
 * ## What this does not render, and why
 *
 * **T-5 (`wrapping-up`) renders nothing here.** The issue's ladder puts T-5 on
 * the PILL — "Pill goes amber: 5 min left — start wrapping up" — not on a
 * banner, and that is the right call: five minutes out, the only person who can
 * act on it is in the room, and a full-width banner at that moment is a
 * pop-up for a message the clock already carries. The rung is exposed as
 * `ladder.rung`/`ladder.status` so the existing `SessionClockPill` styles itself
 * off it; it is the same shape the pill already keys on for `overrunning`.
 *
 * MOUNTING (deferred): the issue's ladder table lists `MeetingRoom.tsx` as the
 * mount point, and the file on this branch is
 * `app/meetings/[id]/components/MeetingRoom.tsx` — there is no
 * `components/meetings/MeetingRoom.tsx`. Rendering `<OverrunBanner>` in the
 * room's header stack is the integration step; it is left out of this change so
 * it cannot collide with the concurrent Stream work on that file.
 */

import { AlertTriangle, Hourglass, Timer } from "lucide-react";

import type { HardCloseNotice, OverrunLadder } from "@/lib/meetings/overrun";
import { cn } from "@/utils/tailwind";

export interface OverrunBannerProps {
  ladder: OverrunLadder;
  /**
   * The notice already delivered to the room, when there is one. Present only
   * on the hard-close path, and only once the server says it went out.
   */
  hardCloseNotice?: HardCloseNotice | null;
  className?: string;
}

export default function OverrunBanner({
  ladder,
  hardCloseNotice,
  className,
}: OverrunBannerProps) {
  if (hardCloseNotice) {
    return (
      <div
        role="status"
        data-testid="overrun-hard-close"
        className={cn(
          "pointer-events-auto flex items-start gap-3 rounded-lg border border-red-500/50 bg-red-950/80 px-4 py-3 backdrop-blur-sm",
          className,
        )}
      >
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-300" />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-red-100">
            {hardCloseNotice.headline}
          </p>
          <p className="mt-0.5 text-xs leading-relaxed text-red-200/80">
            {hardCloseNotice.body}
          </p>
        </div>
      </div>
    );
  }

  if (!ladder.banner) return null;

  const imminent = ladder.rung === "hard-close-warning";
  const Icon = ladder.rung === "grace" ? Hourglass : Timer;

  return (
    <div
      role="status"
      data-testid={`overrun-banner-${ladder.rung}`}
      className={cn(
        "pointer-events-auto flex items-start gap-3 rounded-lg border px-4 py-2.5 backdrop-blur-sm",
        imminent
          ? "border-red-500/50 bg-red-950/80"
          : "border-amber-500/40 bg-amber-500/10",
        className,
      )}
    >
      {ladder.rung === "grace-expired" || ladder.rung === "grace" ? (
        <Hourglass className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
      ) : imminent ? (
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-300" />
      ) : (
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
      )}
      <div className="min-w-0">
        {ladder.rung === "grace-expired" && (
          <p className="text-sm font-medium text-amber-100">
            Overtime is billable now
          </p>
        )}
        <p
          className={cn(
            "text-sm leading-relaxed",
            imminent ? "text-red-100" : "text-amber-100",
          )}
        >
          {ladder.banner}
        </p>
      </div>
    </div>
  );
}
