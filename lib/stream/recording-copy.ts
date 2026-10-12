import type {
  LibraryRecording,
  LibraryRemovedPart,
  LibraryRetention,
  LibraryTimeline,
} from "@/lib/library/library-query";
import { RECORDING_RETENTION_SCHEDULE } from "./recording-retention-schedule";
import type {
  RecordingBookingView,
  RecordingSlot,
  RemovedBy,
  RetentionLabelDTO,
  SlotPart,
} from "./recording-slots";

/** Copy for recording surfaces; pure and client-safe (type-only imports). */

type DayFormat = (iso: string) => string;

export function keptUntilText(
  label: RetentionLabelDTO | null,
  day: DayFormat,
): string | null {
  if (!label) return null;
  if (label.kind === "NEVER") return "Kept permanently";
  if (label.kind === "WHILE_ACTIVE") return "Kept while the booking is active";
  return `Available until ${day(label.until)}`;
}

export function whoCanWatchText(
  audience: RecordingBookingView["audience"],
): string {
  if (audience === "run") return "Private to this run's attendees";
  if (audience === "batch") return "Private to this batch's members";
  return "Only the two of you can watch";
}

export function partLabel(part: Pick<SlotPart, "partNo" | "partCount">) {
  return part.partCount > 1 ? `Part ${part.partNo} of ${part.partCount}` : null;
}

function remover(by: RemovedBy | null): string {
  return by === "support" ? "Familiarise support" : "the expert";
}

/** "Removed by the expert on 11 Oct 2026." */
function removedText(
  removed: { removedAt: string | null; removedBy: RemovedBy | null },
  day: DayFormat,
): string {
  return removed.removedAt
    ? `Removed by ${remover(removed.removedBy)} on ${day(removed.removedAt)}.`
    : `Removed by ${remover(removed.removedBy)}.`;
}

/** The one-line state of a slot, from the viewer's side. */
export function slotStateText(slot: RecordingSlot, day: DayFormat): string {
  const missing = (): string => {
    switch (slot.missingReason) {
      case "declined":
        return "No recording: a participant chose not to be recorded.";
      case "removed":
        return removedText(slot, day);
      case "expired":
        return "The recording's retention period has ended.";
      default:
        return "Not recorded.";
    }
  };
  switch (slot.state) {
    case "recorded": {
      const minutes = slot.parts.reduce((t, p) => t + p.durationInMinutes, 0);
      const parts = slot.parts.length;
      return `${parts === 1 ? "1 part" : `${parts} parts`} · ${minutes} min`;
    }
    case "catch_up":
      return `${missing()} Catch-up from ${
        slot.source?.kind === "catch_up"
          ? slot.source.batchLabel
          : "another run"
      }.`;
    case "upcoming":
      return "Upcoming";
    case "processing":
      return "Processing — the recording will appear here shortly.";
    case "before_you_joined":
      return "This session took place before you joined.";
    case "not_recorded":
    case "declined":
    case "removed":
    case "expired":
      return missing();
  }
}

/** Why a catch-up row plays another batch's or run's recording. */
export function catchUpExplainer(from: "batch" | "run"): string {
  return `Your session wasn't recorded, so you get the same session from another ${from}.`;
}

function removerName(
  by: "expert" | "support" | null,
  expertName: string | null,
): string {
  if (by === "support") return "Familiarise support";
  return expertName ?? "the expert";
}

/** The second line under a row's title; null for a plain recorded session. */
export function rowBadge(
  row: LibraryRecording,
  expertName: string | null,
  day: DayFormat,
): string | null {
  switch (row.state) {
    case "recorded":
      return null;
    case "catch_up":
      return row.catchUp
        ? `Catch-up · recorded ${day(row.catchUp.recordedAt)} with another ${row.catchUp.from}`
        : "Catch-up";
    case "removed": {
      const by = removerName(row.removed?.by ?? null, expertName);
      return row.removed?.at
        ? `Removed by ${by} on ${day(row.removed.at)}`
        : `Removed by ${by}`;
    }
    case "declined":
      return row.declinedBy
        ? `Not recorded · ${row.declinedBy} declined recording`
        : "Not recorded · recording was declined";
    case "not_recorded":
      return "Not recorded";
    case "preparing":
      return "Being prepared";
    case "expired":
      return "Expired";
    case "upcoming":
      return "Upcoming";
    case "before_you_joined":
      return "Before you joined";
  }
}

/** "Part 2 of 2 · Removed by Ananya Anderson on 11 Oct 2026". */
export function removedPartBadge(
  part: LibraryRemovedPart,
  expertName: string | null,
  day: DayFormat,
): string {
  const by = removerName(part.removedBy, expertName);
  const when = part.removedAt ? ` on ${day(part.removedAt)}` : "";
  return `Part ${part.partNo} of ${part.partCount} · Removed by ${by}${when}`;
}

const yearsOrDays = (days: number) =>
  days % 365 === 0
    ? `${days / 365} year${days === 365 ? "" : "s"}`
    : `${days} days`;

/** The header's one retention line. */
export function retentionText(
  retention: LibraryRetention,
  day: DayFormat,
): string {
  switch (retention.kind) {
    case "DATE":
      return `Available until ${day(retention.until)}`;
    case "NEVER":
      return "Never expires";
    case "WHILE_ACTIVE":
      return "Kept while the booking is active";
    case "SUBSCRIPTION_ACTIVE":
      return `Kept while your subscription is active, then ${RECORDING_RETENTION_SCHEDULE.subscriptionDays} days`;
    case "CLASS_RUNNING":
      return `Kept until ${yearsOrDays(RECORDING_RETENTION_SCHEDULE.groupDays)} after the last session`;
  }
}

/** The header's second line, by booking type. */
export function timelineSubline(
  kind: string,
  timeline: Pick<
    LibraryTimeline,
    "sessionCount" | "firstSessionAt" | "lastSessionAt"
  >,
  day: DayFormat,
  dateTime: DayFormat,
): string | null {
  const { firstSessionAt: first, lastSessionAt: last, sessionCount } = timeline;
  if (!first) return null;
  const count = `${sessionCount} session${sessionCount === 1 ? "" : "s"}`;
  if (kind === "CLASS") {
    return `Your batch ${day(first)} – ${day(last ?? first)} · ${count}`;
  }
  if (kind === "SUBSCRIPTION") return `Started ${day(first)} · ${count}`;
  return dateTime(first);
}
