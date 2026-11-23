/**
 * Whether a verdict that moves money against a person rests on strong evidence.
 * Pure, like `classifySessionOutcome`, and judged on the same stored snapshot.
 */
import type { OccurrenceOutcome } from "@prisma/client";

import { isNegativeMoneyOutcome } from "@/lib/booking/misses";
import {
  outageOverlapsBooking,
  VOID_LOSS_MINUTES,
  type PresenceInterval,
  type SessionOutcomeInput,
} from "@/lib/booking/session-outcome";

/** The four conditions, in the order they are reported when they fail. */
export type EvidenceCheck =
  "announced" | "accused-absent" | "counterpart-waited" | "no-outage";

export interface OutcomeEvidenceInput extends SessionOutcomeInput {
  /** Stream announced every session of the snapshot ready; false when any was read on corroboration alone. */
  everySessionAnnounced: boolean;
}

export interface OutcomeEvidence {
  strong: boolean;
  failed: EvidenceCheck[];
}

const MIN_MS = 60_000;

/** Milliseconds inside [from, to) covered by at least one real stay; no reconnect grace fills a gap. */
function roomMs(
  intervals: readonly PresenceInterval[],
  from: number,
  to: number,
): number {
  const clipped = intervals
    .map((i) => ({
      start: Math.max(i.joinedAt.getTime(), from),
      end: Math.min((i.leftAt ?? i.joinedAt).getTime(), to),
    }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);
  let total = 0;
  let reached = from;
  for (const seg of clipped) {
    const start = Math.max(seg.start, reached);
    if (seg.end > start) {
      total += seg.end - start;
      reached = seg.end;
    }
  }
  return total;
}

/**
 * Null for an outcome outside the gate. For a host or learner absence, the accused
 * side has no stay anywhere in the snapshot and the other side was in the room for
 * the void line, min(15 minutes, half the booked length); a cut-short session, where
 * both sides were present, needs only the announcements and no outage.
 */
export function judgeOutcomeEvidence(
  input: OutcomeEvidenceInput,
  outcome: OccurrenceOutcome,
): OutcomeEvidence | null {
  if (!isNegativeMoneyOutcome(outcome)) return null;
  const failed: EvidenceCheck[] = [];
  if (!input.everySessionAnnounced) failed.push("announced");
  if (outcome !== "CUT_SHORT") {
    const hosts = new Set(input.hostUserIds);
    const accusedIsHost = outcome === "HOST_ABSENT";
    const onAccusedSide = (i: PresenceInterval) =>
      hosts.has(i.userId) === accusedIsHost;
    if (input.intervals.some(onAccusedSide)) failed.push("accused-absent");
    const start = input.startsAt.getTime();
    const end = input.endsAt.getTime();
    const booked = Math.max(1, Math.round((end - start) / MIN_MS));
    const line = Math.min(VOID_LOSS_MINUTES, booked / 2) * MIN_MS;
    const counterpart = input.intervals.filter((i) => !onAccusedSide(i));
    if (roomMs(counterpart, start, end) < line) {
      failed.push("counterpart-waited");
    }
  }
  if (outageOverlapsBooking(input)) failed.push("no-outage");
  return { strong: failed.length === 0, failed };
}
