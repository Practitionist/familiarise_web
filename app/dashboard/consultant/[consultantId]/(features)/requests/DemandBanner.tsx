"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { TrendingUp, X } from "lucide-react";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import {
  demandSignals,
  dismissalHolds,
  type DemandSignal,
} from "@/lib/booking/demand-signals";
import { useZonedFormat } from "@/lib/time/zoned-format";
import type { ExpertDemand } from "@/schemas/expert-demand";

import {
  expertDemandQueryKey,
  useExpertDemand,
} from "../settings/use-expert-demand";
import { useSaveBookingRequestSettings } from "../settings/use-save-booking-request-settings";

const dismissalSchema = z.object({
  at: z.number(),
  signals: z.array(
    z.enum([
      "OPEN_REQUESTS",
      "REQUEST_EXPIRING",
      "PLANS_UNPLACED",
      "WEEKS_FULL",
      "LEARNERS_WAITING",
    ]),
  ),
});
type Dismissal = z.infer<typeof dismissalSchema>;

const dismissKey = (consultantId: string) =>
  `fw:demand-dismissed:${consultantId}`;

function readDismissal(consultantId: string): Dismissal | null {
  try {
    const raw = window.localStorage.getItem(dismissKey(consultantId));
    const parsed = dismissalSchema.safeParse(raw ? JSON.parse(raw) : null);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** One plain sentence per signal that fired. */
function signalLines(
  d: ExpertDemand,
  signals: readonly DemandSignal[],
  format: (date: Date, pattern: string) => string,
): string[] {
  const when = (iso: string | null) =>
    iso ? format(new Date(iso), "EEE d MMM, h:mm a") : "";
  const plural = (n: number, one: string, many: string) =>
    `${n} ${n === 1 ? one : many}`;
  return signals.map((s) => {
    switch (s) {
      case "OPEN_REQUESTS":
        return d.maxOpenRequests === null
          ? `${plural(d.openRequests, "request is", "requests are")} waiting for your answer.`
          : `${d.openRequests} of your ${d.maxOpenRequests} open requests are taken.`;
      case "REQUEST_EXPIRING":
        return `A request lapses at ${when(d.nearestRequestExpiry)} unless you answer it.`;
      case "PLANS_UNPLACED":
        return `${plural(d.unplacedPlans, "paid plan is", "paid plans are")} waiting for times; place the first by ${when(d.nearestPlacementDeadline)}.`;
      case "WEEKS_FULL":
        return `Your next two weeks are ${Math.round((d.bookedShare ?? 0) * 100)}% booked.`;
      case "LEARNERS_WAITING":
        return `${plural(d.learnersWaiting, "learner is", "learners are")} waiting for a time you've filled.`;
    }
  });
}

/**
 * "You're in demand": shown on the Requests page and home only when a load
 * signal fires, with the actions that fit. A paused expert sees the paused
 * notice instead; "Dismiss for 7 days" holds until a new kind of signal.
 */
export function DemandBanner({
  consultantId,
}: Readonly<{ consultantId: string }>) {
  const format = useZonedFormat();
  const router = useRouter();
  const queryClient = useQueryClient();
  const save = useSaveBookingRequestSettings(consultantId);
  const [dismissal, setDismissal] = useState<Dismissal | null>(null);
  useEffect(() => {
    setDismissal(readDismissal(consultantId));
  }, [consultantId]);

  const { data } = useExpertDemand(consultantId);

  if (!data) return null;
  const now = new Date();
  const signals = demandSignals(data, now);
  if (signals.length === 0 || dismissalHolds(dismissal, signals, now)) {
    return null;
  }

  const dismiss = () => {
    const next: Dismissal = { at: Date.now(), signals };
    window.localStorage.setItem(dismissKey(consultantId), JSON.stringify(next));
    setDismissal(next);
  };
  // The paused notice is server-rendered from the profile.
  const refresh = () => {
    void queryClient.invalidateQueries({
      queryKey: expertDemandQueryKey(consultantId),
    });
    router.refresh();
  };
  const settingsHref = `/dashboard/consultant/${consultantId}/settings/booking`;
  const loadSignals = signals.some((s) => s !== "LEARNERS_WAITING");

  return (
    <section
      aria-label="You're in demand"
      className="rounded-2xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-900/50 dark:bg-amber-950/30 sm:p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <TrendingUp className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-semibold text-foreground">
              You&apos;re in demand
            </p>
            <ul className="space-y-0.5 text-sm text-foreground">
              {signalLines(data, signals, format).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="-my-1 shrink-0"
          onClick={dismiss}
        >
          <X className="mr-1 h-4 w-4" />
          Dismiss for 7 days
        </Button>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {loadSignals && (
          <Button
            size="sm"
            variant="outline"
            disabled={save.isPending}
            onClick={() =>
              save.mutate(
                {
                  set: { acceptingRequests: false },
                  expect: { acceptingRequests: true },
                },
                { onSuccess: refresh },
              )
            }
          >
            Pause new bookings
          </Button>
        )}
        {loadSignals && data.bookingMode === "INSTANT" && (
          <Button
            size="sm"
            variant="outline"
            disabled={save.isPending}
            onClick={() =>
              save.mutate(
                {
                  set: { bookingMode: "REQUEST" },
                  expect: { bookingMode: "INSTANT" },
                },
                { onSuccess: refresh },
              )
            }
          >
            Review requests first
          </Button>
        )}
        {(signals.includes("PLANS_UNPLACED") ||
          signals.includes("WEEKS_FULL")) && (
          <Button size="sm" variant="outline" asChild>
            <Link href={`${settingsHref}#max-active-plan-clients`}>
              Limit plan clients
            </Link>
          </Button>
        )}
        {signals.includes("LEARNERS_WAITING") && (
          <Button size="sm" variant="outline" asChild>
            <Link href={`/dashboard/consultant/${consultantId}/availability`}>
              Add more hours
            </Link>
          </Button>
        )}
      </div>
    </section>
  );
}
