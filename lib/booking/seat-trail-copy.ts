// What a seat's history reads as on the roster and the learner's own page; no server imports.

import { formatInViewerZone, zoneLabel } from "@/lib/time/viewer-zone";

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

/** Steps a trail line shows before it counts the earlier ones. */
const TRAIL_STEPS_SHOWN = 3;
const TRAIL_DAY = "d MMM";

/** A seat's trail as both its learner and its organiser read it: the compact line and, for a hover, every step. */
export interface SeatTrailText {
  line: string;
  full: string;
}

const capitalise = (text: string) =>
  text.charAt(0).toUpperCase() + text.slice(1);

/**
 * "Left 12 Nov · rejoined 13 Nov (IST)": every step after the first registration, each
 * day in `zone`, which the line names. A long trail keeps its last steps and counts the rest.
 */
export function seatTrailText(
  steps: readonly SeatTrailStep[],
  zone: string,
): SeatTrailText {
  const after = steps[0]?.reason === "registered" ? steps.slice(1) : steps;
  const last = after.at(-1);
  if (!last) return { line: "", full: "" };
  const zoneSuffix = ` (${zoneLabel(last.at, zone)})`;
  const words = after.map(
    (step) =>
      `${STEP_WORDS[step.reason]} ${formatInViewerZone(step.at, zone, TRAIL_DAY)}`,
  );
  const full = capitalise(words.join(" · ")) + zoneSuffix;
  const earlier = words.length - TRAIL_STEPS_SHOWN;
  if (earlier <= 0) return { line: full, full };
  const shown = words.slice(-TRAIL_STEPS_SHOWN).join(" · ");
  const count =
    earlier === 1 ? "1 earlier change" : `${earlier} earlier changes`;
  return { line: `${count}, then ${shown}${zoneSuffix}`, full };
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
