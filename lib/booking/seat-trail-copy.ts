// What a seat's history reads as on the roster and the learner's own page; no server imports.

import type { SeatHistoryReason, SeatTrailStep } from "./seat-history";

const STEP_WORDS: Record<SeatHistoryReason, string> = {
  registered: "registered",
  self_leave: "left",
  organiser_removal: "removed by the organiser",
  conduct_removal: "removed for conduct",
  block_lifted: "allowed back",
  rejoined: "rejoined",
  refunded: "refunded",
};

/**
 * "Left 12 Nov · rejoined 13 Nov": every step after the first registration, in
 * order, each day formatted by the caller in the reader's zone. Empty when the
 * seat only ever registered.
 */
export function seatTrailLine(
  steps: readonly SeatTrailStep[],
  formatDay: (iso: string) => string,
): string {
  const after = steps[0]?.reason === "registered" ? steps.slice(1) : steps;
  const line = after
    .map((step) => `${STEP_WORDS[step.reason]} ${formatDay(step.at)}`)
    .join(" · ");
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/** How the seat was last removed, read off its trail; an untraced removal reads as the organiser's. */
export function lastRemovalKind(
  steps: readonly SeatTrailStep[],
): "ORGANISER" | "CONDUCT" {
  const last = steps.findLast(
    (step) =>
      step.reason === "organiser_removal" || step.reason === "conduct_removal",
  );
  return last?.reason === "conduct_removal" ? "CONDUCT" : "ORGANISER";
}
