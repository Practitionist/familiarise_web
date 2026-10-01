"use client";

/**
 * #1838 — the T+10 decision. One modal, two audiences, one honest answer.
 *
 * The ladder's whole value is that nobody is ever billed for a minute they did
 * not agree to. That makes this component less a dialog than the enforcement
 * point of the feature, and every branch below is a refusal to guess:
 *
 * - **The host sees the price before they ask.** `₹X` is rendered from the same
 *   `proRataBasePaiseForBlock` the server charges, so the figure in the modal
 *   is the figure on the receipt. The issue's competitor sweep found surprise
 *   charges are the complaint that gets consultants actioned against them; a
 *   modal whose price can differ from the bill is that complaint, one render
 *   earlier.
 * - **The consultee sees the prompt with a visible deadline.** Sixty seconds,
 *   counting down, and the copy says an unanswered prompt is a no — because
 *   `settleOverrunPurchase` makes it one, and a person who believes they can
 *   walk away will walk away.
 * - **Nobody sees "extend" but the host.** A participant gets Accept/Decline or
 *   nothing; a host-only decision is the rule the end-call control already uses,
 *   and the server re-checks it regardless (`requireOverrunHost`).
 * - **Accepted is not extended.** The "taking payment now" state says the extra
 *   minutes have NOT started, because they have not. A UI implying otherwise
 *   would be telling a consultant they have fifteen paid minutes while the money
 *   is in flight.
 *
 * **Dismissal is not a charge.** Closing this decides nothing, and nothing on
 * the server reads a close as consent — so the X is safe, unlike a modal whose
 * "OK" meant "yes, bill me".
 *
 * **No route and no fetch.** `onRequestBlock` / `onRespond` are injected. The
 * consent state machine and its deadlines live in `lib/meetings/overrun.ts` and
 * are pure; this renders a view of them and nothing else. Wiring the handlers to
 * `POST /api/meetings/[id]/extend` is the deferred integration — see
 * `lib/meetings/overrun-server.ts` for what that route is owed.
 */

import { useEffect, useState } from "react";
import { AlertTriangle, Clock, Hourglass, Wallet } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  EXTEND_BLOCK_MIN,
  type OverrunLadder,
  type OverrunPurchaseView,
} from "@/lib/meetings/overrun";
import { formatCurrencyAmount } from "@/utils/formatting";

export type ExtendModalViewer = "host" | "consultee";

export interface ExtendModalProps {
  /** Whether the Radix dialog is mounted at all. */
  open: boolean;
  ladder: OverrunLadder;
  purchase: OverrunPurchaseView;
  viewer: ExtendModalViewer;
  /**
   * Host asks for blocks. The count passed back is the LADDER's cap, never the
   * caller's own number: the back-to-back guard and the hard stop have already
   * been applied, and a client that could ask for ten would defeat both.
   */
  onRequestBlock?: (blocks: number) => void;
  /** Consultee answers, inside the window. */
  onRespond?: (decision: "accept" | "decline") => void;
  /** Host gives up and ends the session through the existing end flow. */
  onEndNow?: () => void;
  onOpenChange?: (open: boolean) => void;
}

/**
 * The displayed price, in rupees.
 *
 * `blockPricePaise` is the PRE-TAX base. GST is added by the platform's tax
 * engine on the way out, which is where ADR 26 says it belongs — so this reads
 * like the pre-GST line of a tax invoice, and the modal never invents a tax
 * figure the server would then contradict.
 */
function rupees(paise: number): string {
  return formatCurrencyAmount(paise, "INR");
}

const TITLES: Record<OverrunPurchaseView["stage"], string> = {
  none: "This session has run over",
  "awaiting-consultee": "This session has run over",
  "accepted-awaiting-payment": "Taking payment",
  granted: "Session extended",
  declined: "No extra charge",
  expired: "No extra charge",
  "payment-failed": "Payment failed",
};

export default function ExtendModal({
  open,
  ladder,
  purchase,
  viewer,
  onRequestBlock,
  onRespond,
  onEndNow,
  onOpenChange,
}: ExtendModalProps) {
  const [, forceTick] = useState(0);

  // The 60-second deadline is shown in seconds, so it needs a tick. Local and
  // never a request: the deadline itself is enforced server-side by
  // `settleOverrunPurchase`, so a throttled background tab still expires.
  useEffect(() => {
    if (purchase.stage !== "awaiting-consultee") return;
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [purchase.stage]);

  const isHost = viewer === "host";
  // The offer is `stage === "none"` (nothing in flight) AND `ladder
  // .canRequestBlock` — the ladder's own gates, so the button cannot appear for
  // a block the server would refuse to sell.
  const showHostDecision =
    isHost && purchase.stage === "none" && ladder.canRequestBlock;
  // "End now" is offered whenever no answer is outstanding. During the 60-second
  // wait the session is still in free wrap-up, so there is nothing to end; at
  // every other stage the host may close it — which is the alternative to every
  // unpaid state the ladder can reach.
  const showEndNow = isHost && purchase.stage !== "awaiting-consultee";
  const showConsulteePrompt =
    viewer === "consultee" && purchase.stage === "awaiting-consultee";
  const secondsLeft =
    purchase.stage === "awaiting-consultee"
      ? (purchase.secondsToAnswer ?? 0)
      : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="extend-modal">
        <div className="flex items-start gap-3">
          {purchase.stage === "awaiting-consultee" ? (
            <Hourglass className="mt-1 h-5 w-5 shrink-0 text-amber-400" />
          ) : (
            <Clock className="mt-1 h-5 w-5 shrink-0 text-amber-400" />
          )}
          <div className="min-w-0 flex-1">
            <DialogTitle>{TITLES[purchase.stage]}</DialogTitle>
            <DialogDescription className="mt-1 text-sm leading-relaxed text-zinc-300">
              {purchase.prompt ?? purchase.outcome ?? ladder.banner ?? ""}
            </DialogDescription>
          </div>
        </div>

        {ladder.offer.warning && (
          <p
            className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200"
            data-testid="back-to-back-warning"
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {ladder.offer.warning}
          </p>
        )}

        {showHostDecision && (
          <div className="rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-3">
            <p className="flex items-center gap-2 text-sm text-zinc-200">
              <Wallet className="h-4 w-4 shrink-0 text-zinc-400" />
              <span>
                Extend by {EXTEND_BLOCK_MIN} min —{" "}
                <span
                  className="font-semibold text-white"
                  data-testid="block-price"
                >
                  {rupees(ladder.blockPricePaise)}
                </span>
              </span>
            </p>
            <p className="mt-1 text-xs text-zinc-400">
              At this session&apos;s own per-minute rate. Overtime is only ever
              charged after the other side agrees.
            </p>
          </div>
        )}

        {purchase.stage === "awaiting-consultee" && secondsLeft !== null && (
          <p className="text-xs text-zinc-400" data-testid="answer-deadline">
            {isHost
              ? `Waiting — they have ${secondsLeft}s to answer.`
              : `Answering in ${secondsLeft}s — an unanswered prompt is a no, and the session wraps up for free.`}
          </p>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          {showHostDecision && (
            <>
              <Button
                variant="outline"
                onClick={onEndNow}
                data-testid="end-now"
              >
                End now
              </Button>
              <Button
                onClick={() => onRequestBlock?.(ladder.offer.blocks)}
                data-testid="request-block"
              >
                Extend {EXTEND_BLOCK_MIN} min ({rupees(ladder.blockPricePaise)})
              </Button>
            </>
          )}

          {showConsulteePrompt && (
            <>
              <Button
                variant="outline"
                onClick={() => onRespond?.("decline")}
                data-testid="decline"
              >
                No, wrap up
              </Button>
              <Button
                onClick={() => onRespond?.("accept")}
                data-testid="accept"
              >
                Yes, extend {EXTEND_BLOCK_MIN} min
              </Button>
            </>
          )}

          {showEndNow && !showHostDecision && (
            <Button variant="outline" onClick={onEndNow} data-testid="end-now">
              End now
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
