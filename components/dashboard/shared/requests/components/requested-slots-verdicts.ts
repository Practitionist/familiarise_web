/**
 * The pure half of the requested-times dialog (#1703 F5): per-slot verdicts,
 * the one-sentence summary, the pinned allocate link and the primary's title.
 * No React here so the copy can be pinned without mounting Radix.
 */
import type { SlotConflictResult } from "@/utils/scheduling-engine/types";
import { CONFLICT_WITH } from "@/lib/booking/validate-conflict-view";

export interface ValidationVerdictSource extends SlotConflictResult {
  outsidePeriod?: Array<{ slot: string }>;
}

/** One requested slot's verdict, as the list and the summary read it. */
export type SlotVerdict =
  | { kind: "checking" }
  | { kind: "free" }
  /** `appointmentId` is set only for the viewing consultant's own booking. */
  | { kind: "conflict"; existing: string; appointmentId?: string }
  | { kind: "outsideAvailability" }
  | { kind: "tooSoon" }
  | { kind: "outsidePeriod" };

/**
 * The validate routes hand back a slot as a zone-less ISO prefix
 * ("2026-09-24T14:00:00"), which `new Date` would read as LOCAL time. It was
 * cut from a UTC string, so it is UTC — match on the instant, never the text.
 */
export function parseSlotInstant(value: string): number {
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value);
  return new Date(hasZone ? value : `${value}Z`).getTime();
}

const sameInstant = (a: string, b: string) =>
  parseSlotInstant(a) === parseSlotInstant(b);

/** Where each requested slot stands once validation has answered. */
export function verdictFor(
  slot: string,
  result: ValidationVerdictSource | null,
): SlotVerdict {
  if (!result) return { kind: "checking" };
  const conflict = result.conflicts.find((c) => sameInstant(c.slot, slot));
  if (conflict) {
    const {
      type,
      with: withWhom,
      appointmentId,
    } = conflict.existingAppointment;
    // A time, never a party: the event's consultant gets a link to their own
    // booking, or hears that their client is busy; anyone else hears only
    // that the time is booked.
    if (appointmentId) {
      return {
        kind: "conflict",
        existing: `your ${type.toLowerCase()} at this time`,
        appointmentId,
      };
    }
    if (withWhom === CONFLICT_WITH.client) {
      return { kind: "conflict", existing: "your client's other session" };
    }
    return { kind: "conflict", existing: "an existing booking" };
  }
  if ((result.tooSoon ?? []).some((o) => sameInstant(o.slot, slot))) {
    return { kind: "tooSoon" };
  }
  if ((result.outsidePeriod ?? []).some((o) => sameInstant(o.slot, slot))) {
    return { kind: "outsidePeriod" };
  }
  if (result.outsideAvailability.some((o) => sameInstant(o.slot, slot))) {
    return { kind: "outsideAvailability" };
  }
  return { kind: "free" };
}

/**
 * The one-sentence summary ("3 slots requested · 1 conflicts with an
 * existing booking · 1 outside availability"): the request count always,
 * then only the parts that are non-zero, so a clean result reads clean.
 */
export function summarizeVerdicts(verdicts: readonly SlotVerdict[]): string {
  const total = verdicts.length;
  const parts = [`${total} slot${total === 1 ? "" : "s"} requested`];
  const count = (kind: SlotVerdict["kind"]) =>
    verdicts.filter((v) => v.kind === kind).length;
  if (verdicts.some((v) => v.kind === "checking")) {
    parts.push("checking…");
    return parts.join(" · ");
  }
  const conflicts = count("conflict");
  const outsideHours = count("outsideAvailability");
  const outsidePeriod = count("outsidePeriod");
  const tooSoon = count("tooSoon");
  if (conflicts > 0) {
    // "conflicts" is the verb: "1 conflicts with…" / "2 conflict with…".
    parts.push(
      `${conflicts} conflict${conflicts === 1 ? "s" : ""} with an existing booking`,
    );
  }
  if (outsideHours > 0) parts.push(`${outsideHours} outside availability`);
  if (tooSoon > 0) parts.push(`${tooSoon} too soon to book`);
  if (outsidePeriod > 0) {
    parts.push(`${outsidePeriod} outside the scheduling period`);
  }
  if (parts.length === 1) parts.push(total === 1 ? "free" : "all free");
  return parts.join(" · ");
}

/** The allocate page pinned on one slot (`?at=`), whatever the base already carries. */
export function allocateHrefAt(base: string, slot: string): string {
  const joiner = base.includes("?") ? "&" : "?";
  return `${base}${joiner}at=${encodeURIComponent(new Date(parseSlotInstant(slot)).toISOString())}`;
}

/** Un-nests the primary's title so every state names its own reason. */
export function resolvePrimaryTitle(state: {
  blocked: boolean;
  outsideHours: number;
}): string {
  if (state.blocked) {
    return "These times cannot be booked as requested — pick another time.";
  }
  if (state.outsideHours > 0) {
    return `${state.outsideHours} slot${state.outsideHours === 1 ? " is" : "s are"} outside your published hours. Allocating still books them.`;
  }
  return "Book every requested time.";
}
