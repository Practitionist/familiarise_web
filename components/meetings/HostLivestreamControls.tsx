"use client";

import { useRef, useState } from "react";
import { Loader2, Radio, Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/dashboard/ConfirmDialog";
import { cn } from "@/utils/tailwind";

/**
 * The host's broadcast switch: go live, end live, and — the part that matters —
 * tell the truth about whether the broadcast is actually reaching an audience.
 *
 * ## `isHost` is a presentation flag and nothing else
 *
 * It decides what is drawn, not what is allowed. `POST
 * /api/meetings/[meetingId]/livestream` re-derives hostness from the database
 * through `guardMeetingRoute`, and `endLive` re-derives it again from the Stream
 * call, because `goLive` is what writes the designation. A prop here is
 * therefore a rendering decision and cannot be used to take a broadcast down —
 * which is the entire shape of #1134 P0-1 and #1270, both of which were a
 * React conditional standing in for an authorization check.
 *
 * It is a prop rather than derived from `useSessionInfo` because that hook needs
 * the Stream call context, and this control is also rendered outside a call (the
 * pre-flight screen, where a host needs to be able to see that a broadcast is
 * available at all). Callers pass the same answer `EndCallButton` uses.
 *
 * ## It reports what it did, not what the call is doing
 *
 * There is no `call.live` subscription here on purpose. `endLive` also accepts
 * an ACTIVE org operator, so a second host or an org admin can stop a broadcast
 * this component believes is running, and a control that keeps claiming "live"
 * after that is worse than one that admits it only knows about its own actions.
 * `onLiveChange` is how the room re-syncs from a real source; this component
 * will not guess.
 *
 * ## The `hls: false` note is the whole point of this component
 *
 * `goLive` reports `hls` — what it ASKED the vendor to start — and HLS is a
 * per-plan opt-in that no plan currently holds, so in practice that flag is
 * false for every caller today. The naive version of this control presses
 * "Start broadcast", gets a 200, and shows a presenter who believes they are
 * streaming to an audience that is not receiving anything: `goLive` without
 * `start_hls` is not refused by Stream, it simply does not fan out. So the
 * answer is surfaced, not swallowed — as a persistent line rather than a toast,
 * because a toast disappears and leaves the host believing the opposite.
 */

export interface HostLivestreamControlsProps {
  /** The MEETING row id. Not the call id — see `LivestreamPlayer`. */
  meetingId: string;
  /** See the header. Gates rendering only. */
  isHost: boolean;
  /**
   * Fired after this control's own action commits, so the room can react.
   * `true` means live, `false` means not — as far as THIS control knows.
   */
  onLiveChange?: (live: boolean) => void;
  className?: string;
}

type Phase = "idle" | "starting" | "live" | "ending" | "ended";

/**
 * The copy when the server sends no message of its own.
 *
 * Every refusal in `lib/meetings/livestream-service.ts` carries a
 * user-facing `message` and the route returns it, so this is the fallback for
 * a 500 or an unreadable body — not the normal path. Saying something
 * different from the server's own words on the same failure would be the two
 * copies drifting apart, which is what the service's header warns about.
 */
const GENERIC_FAILURE = "That didn't go through. Please try again.";

interface ActionFailure {
  title: string;
  detail: string;
}

export function HostLivestreamControls({
  meetingId,
  isHost,
  onLiveChange,
  className,
}: Readonly<HostLivestreamControlsProps>) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [failure, setFailure] = useState<ActionFailure | null>(null);
  /**
   * Set while a broadcast is running but NOT reaching an audience. Sticky by
   * design: it is the difference between "your broadcast is on" and "your
   * broadcast is on and nobody outside this room can see it", and a host who is
   * not told will assume the second.
   */
  const [audienceNote, setAudienceNote] = useState<string | null>(null);

  // Refs, not state, for the in-flight guards. Same reason as `EndCallButton`:
  // a state guard read from a closure is advisory at best, and this gates two
  // provider writes.
  const startingRef = useRef(false);
  const endingRef = useRef(false);

  if (!isHost) return null;

  const endpoint = `/api/meetings/${encodeURIComponent(meetingId)}/livestream`;

  async function post(
    action: "go-live" | "end",
  ): Promise<Record<string, unknown> | ActionFailure> {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Bounded for the same reason `EndCallButton` bounds its own: `fetch`
        // has no default timeout, and an unbounded one leaves the button
        // disabled with no way back.
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ action }),
      });
      const body = (await response.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      if (!response.ok) {
        return {
          title: action === "go-live" ? "Could not start" : "Could not end",
          detail:
            typeof body?.error === "string" ? body.error : GENERIC_FAILURE,
        };
      }
      return body ?? {};
    } catch {
      // A thrown fetch is the network between here and the route, so it gets
      // the generic copy rather than a refusal the server never sent.
      return {
        title: action === "go-live" ? "Could not start" : "Could not end",
        detail: GENERIC_FAILURE,
      };
    }
  }

  const isFailure = (r: unknown): r is ActionFailure =>
    typeof r === "object" && r !== null && "title" in r;

  async function handleGoLive() {
    if (startingRef.current) return;
    startingRef.current = true;
    setPhase("starting");
    setFailure(null);

    const result = await post("go-live");
    startingRef.current = false;

    if (isFailure(result)) {
      setFailure(result);
      setPhase("idle");
      return;
    }

    setPhase("live");
    onLiveChange?.(true);

    // `hls` reports what was ASKED of the vendor, not what the vendor did, and
    // it is absent on every other action — so a false here is the only honest
    // signal this control has about the audience.
    setAudienceNote(
      result.hls === true
        ? null
        : "Live for everyone in the session. Broadcasting to a wider audience is an add-on, and it is not included here, so nobody outside this room can watch.",
    );
  }

  /**
   * Throws on failure so `ConfirmDialog` keeps the dialog open with the
   * message inside it — the pattern its own header describes. A toast would be
   * dismissible before it was read, and the dialog is still up.
   */
  async function handleEndLive(): Promise<void> {
    if (endingRef.current) return;
    endingRef.current = true;
    setPhase("ending");
    setFailure(null);

    const result = await post("end");
    endingRef.current = false;

    if (isFailure(result)) {
      setPhase("live");
      setFailure(result);
      throw new Error(result.detail);
    }

    setPhase("ended");
    setAudienceNote(null);
    onLiveChange?.(false);
  }

  const busy = phase === "starting" || phase === "ending";
  const live = phase === "live" || phase === "ending";

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div className="flex flex-wrap items-center gap-2">
        {live ? (
          <ConfirmDialog
            title="End the broadcast?"
            description="Everyone watching is taken off the stream. You can start it again afterwards, but anyone who joined the stream directly will need to come back through the session."
            confirmLabel="End broadcast"
            cancelLabel="Keep broadcasting"
            tone="destructive"
            onConfirm={handleEndLive}
            trigger={
              <Button
                type="button"
                variant="destructive"
                disabled={busy}
                className="h-auto px-5 py-2.5"
              >
                {phase === "ending" ? (
                  <Loader2
                    className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none"
                    aria-hidden
                  />
                ) : (
                  <Square className="mr-2 h-4 w-4" aria-hidden />
                )}
                {phase === "ending" ? "Ending…" : "End broadcast"}
              </Button>
            }
          />
        ) : (
          <Button
            type="button"
            onClick={handleGoLive}
            disabled={busy}
            className="h-auto px-5 py-2.5"
          >
            {phase === "starting" ? (
              <Loader2
                className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none"
                aria-hidden
              />
            ) : (
              <Radio className="mr-2 h-4 w-4" aria-hidden />
            )}
            {phase === "starting" ? "Starting…" : "Start broadcast"}
          </Button>
        )}

        {phase === "ended" && (
          <span className="text-sm text-zinc-500">Broadcast ended.</span>
        )}
      </div>

      {/*
        `role="status"` for the audience note and `role="alert"` for the failure
        are different on purpose. "Your broadcast is on but nobody else can see
        it" is a standing fact the host should have in front of them; a refusal
        is a response to something they just pressed.
      */}
      {audienceNote && (
        <p
          role="status"
          className="max-w-md text-xs leading-relaxed text-amber-400/90"
        >
          {audienceNote}
        </p>
      )}

      {failure && (
        <p role="alert" className="max-w-md text-sm text-destructive">
          {failure.detail}
        </p>
      )}
    </div>
  );
}

export default HostLivestreamControls;
