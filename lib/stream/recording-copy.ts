import type {
  RecordingBookingView,
  RecordingSlot,
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

/** The one-line state of a slot, from the viewer's side. */
export function slotStateText(slot: RecordingSlot, day: DayFormat): string {
  const missing = (): string => {
    switch (slot.missingReason) {
      case "declined":
        return "No recording: a participant chose not to be recorded.";
      case "removed":
        return slot.removedAt
          ? `Removed by the expert on ${day(slot.removedAt)}.`
          : "Removed by the expert.";
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
