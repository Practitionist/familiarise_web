"use client";

import { useEffect, useState } from "react";

import { useViewerZone } from "@/lib/time/use-viewer-zone";
import { formatForViewer } from "@/lib/time/viewer-zone";

import { eventRefundWindowHours } from "@/lib/payments/operations/cancellation-policy";

/**
 * #1780 D-6 — "Free cancellation until <start − window>". A class under way
 * still refunds its class quote (D-4), so its ended line makes no no-refund
 * claim.
 *
 * #1863 — the zone was read straight off `Intl.DateTimeFormat()`, which is the
 * LAPTOP's zone and nothing else. On an Indian-market product a learner whose
 * profile says `Asia/Kolkata` opening the page on a New York laptop was shown
 * the deadline in New York time: a deadline they would read as ten hours later
 * than it was, with no suffix to say so. Every other viewer-facing surface
 * resolves through `useViewerZone`; this one now does too, with the browser
 * zone kept as the FALLBACK so a signed-out visitor on a New York laptop still
 * gets New York time rather than UTC — the profile zone is an improvement, not
 * a reason to make the anonymous case worse.
 *
 * Rendered after mount, as before: the browser zone is only knowable in the
 * browser, and gating on it is what keeps the server render and the first
 * hydrated render from disagreeing (#418).
 */
export function FreeCancellationLine({
  startsAt,
  windowHours,
  kind = "webinar",
  className = "text-sm text-muted-foreground",
}: Readonly<{
  startsAt: Date | string | null | undefined;
  windowHours: number | null | undefined;
  kind?: "class" | "webinar";
  className?: string;
}>) {
  const [browserZone, setBrowserZone] = useState<string | null>(null);
  useEffect(() => {
    setBrowserZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  }, []);
  const viewer = useViewerZone(browserZone);
  if (!startsAt || !browserZone) return null;
  const until = new Date(
    new Date(startsAt).getTime() -
      eventRefundWindowHours(null, windowHours) * 3_600_000,
  );
  // Labelled by `formatForViewer` whenever the zone is not the viewer's own
  // saved one, so a deadline printed in a fallback zone says which.
  const when = formatForViewer(until, viewer, "EEE d MMM, h:mm a");
  const ended =
    kind === "class"
      ? `Free cancellation ended ${when}.`
      : `Free cancellation ended ${when}; a seat can no longer be refunded.`;
  return (
    <p className={className}>
      {until.getTime() > Date.now()
        ? `Free cancellation until ${when}.`
        : ended}
    </p>
  );
}
