import type {
  LibraryRecording,
  LibraryRetention,
  LibraryTimeline,
  RecordingRowState,
} from "@/lib/library/library-query";
import { partLabel } from "./recording-copy";
import type {
  RecordingBookingView,
  RecordingSlot,
  RetentionLabelDTO,
  SlotState,
} from "./recording-slots";

/**
 * A booking's recordings as one timeline row per session of the viewer's own
 * booking, for the Library card and the booking's Recordings page alike.
 * Pure and client-safe (type-only imports from the slot rule).
 */

const ROW_STATE: Record<SlotState, RecordingRowState> = {
  recorded: "recorded",
  catch_up: "catch_up",
  upcoming: "upcoming",
  processing: "preparing",
  not_recorded: "not_recorded",
  declined: "declined",
  removed: "removed",
  expired: "expired",
  before_you_joined: "before_you_joined",
  cancelled: "cancelled",
};

const DAY_MS = 24 * 60 * 60 * 1000;
/** A row's own retention shows when it ends within this window. */
const RETENTION_WARNING_DAYS = 30;

/** Whether a booking has anything recorded to list: parts, a removal or a decline. */
export function slotHasMedia(slot: RecordingSlot): boolean {
  return (
    slot.parts.length > 0 ||
    slot.removedParts.length > 0 ||
    slot.state === "removed" ||
    slot.state === "declined"
  );
}

type TimelineView = Pick<
  RecordingBookingView,
  "appointmentId" | "kind" | "expertName" | "organizationName"
>;

function removerName(
  view: TimelineView,
  by: RecordingSlot["removedBy"],
): string | null {
  if (by === "org") return view.organizationName;
  return by === "expert" ? view.expertName : null;
}

function slotRow(view: TimelineView, slot: RecordingSlot): LibraryRecording {
  const parts = slot.parts.map((part) => ({
    id: part.recordingId,
    title: part.title,
    partLabel: partLabel(part),
    recordedAt: part.recordedAt,
    durationInMinutes: part.durationInMinutes,
    keptUntil: part.keptUntil,
  }));
  return {
    id: `${view.appointmentId}:slot-${slot.ordinal}`,
    title: slot.title,
    slotOrdinal: slot.ordinal,
    sessionAt: slot.startsAt,
    state: ROW_STATE[slot.state],
    durationInMinutes: parts.reduce((t, p) => t + p.durationInMinutes, 0),
    catchUp:
      slot.source?.kind === "catch_up"
        ? {
            from: view.kind === "CLASS" ? "batch" : "run",
            recordedAt: slot.source.recordedAt,
          }
        : null,
    removed:
      slot.state === "removed"
        ? {
            at: slot.removedAt,
            by: slot.removedBy,
            byName: removerName(view, slot.removedBy),
          }
        : null,
    declinedBy: slot.state === "declined" ? slot.declinedBy : null,
    keptUntil: parts[0]?.keptUntil ?? null,
    parts,
    removedParts: slot.removedParts.map((p) => ({
      partNo: p.partNo,
      partCount: p.partCount,
      removedAt: p.removedAt,
      removedBy: p.removedBy,
      removedByName: removerName(view, p.removedBy),
    })),
  };
}

/** Every session of the viewer's booking, in session order. */
export function timelineRows(
  view: TimelineView & Pick<RecordingBookingView, "slots">,
): LibraryRecording[] {
  return [...view.slots]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((slot) => slotRow(view, slot));
}

/** Every past session, then only the next upcoming one; the rest are counted. */
export function truncateUpcoming(rows: LibraryRecording[]): {
  rows: LibraryRecording[];
  moreUpcoming: number;
} {
  const upcoming = rows.filter((r) => r.state === "upcoming");
  const next = upcoming[0];
  return {
    rows: rows.filter((r) => r.state !== "upcoming" || r === next),
    moreUpcoming: Math.max(upcoming.length - 1, 0),
  };
}

function sameLabel(a: RetentionLabelDTO, b: RetentionLabelDTO): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind !== "DATE" || (b.kind === "DATE" && a.until === b.until);
}

/** The most common label across the rows, preferring the viewer's own recordings. */
function dominantLabel(rows: LibraryRecording[]): RetentionLabelDTO | null {
  const own = rows.filter((r) => r.catchUp === null);
  const pool = (own.some((r) => r.keptUntil) ? own : rows).flatMap((r) =>
    r.keptUntil ? [r.keptUntil] : [],
  );
  let best: RetentionLabelDTO | null = null;
  let bestCount = 0;
  for (const label of pool) {
    const count = pool.filter((l) => sameLabel(l, label)).length;
    if (count > bestCount) {
      best = label;
      bestCount = count;
    }
  }
  return best;
}

/** How long the booking's recordings are kept, phrased once by booking type. */
function headerRetention(
  kind: string,
  rows: LibraryRecording[],
): LibraryRetention | null {
  const running =
    rows.some((r) => r.state === "upcoming") ||
    rows.some(
      (r) => r.catchUp === null && r.keptUntil?.kind === "WHILE_ACTIVE",
    );
  if (kind === "SUBSCRIPTION" && running)
    return { kind: "SUBSCRIPTION_ACTIVE" };
  if (kind === "CLASS" && running) return { kind: "CLASS_RUNNING" };
  return dominantLabel(rows);
}

/** A row's own retention, shown only when it differs from the header or ends soon. */
export function rowRetention(
  row: LibraryRecording,
  header: LibraryRetention | null,
  now: Date,
): { label: RetentionLabelDTO; warning: boolean } | null {
  const label = row.keptUntil;
  if (!label) return null;
  const endsSoon =
    label.kind === "DATE" &&
    new Date(label.until).getTime() - now.getTime() <
      RETENTION_WARNING_DAYS * DAY_MS;
  const sameAsHeader =
    header !== null &&
    (header.kind === "DATE" ||
      header.kind === "WHILE_ACTIVE" ||
      header.kind === "NEVER") &&
    sameLabel(label, header);
  const runningHeader =
    header?.kind === "SUBSCRIPTION_ACTIVE" || header?.kind === "CLASS_RUNNING";
  if (endsSoon) return { label, warning: true };
  if (sameAsHeader || (runningHeader && label.kind === "WHILE_ACTIVE")) {
    return null;
  }
  return { label, warning: false };
}

/** The card header's facts for a booking, before upcoming sessions are cut. */
export function timelineOf(
  view: Pick<RecordingBookingView, "kind" | "slots" | "viewerRole">,
  rows: LibraryRecording[],
): Omit<LibraryTimeline, "moreUpcoming"> {
  const starts = view.slots.map((s) => s.startsAt).sort();
  return {
    viewerRole: view.viewerRole,
    sessionCount: view.slots.length,
    firstSessionAt: starts[0] ?? null,
    lastSessionAt: starts.at(-1) ?? null,
    retention: headerRetention(view.kind, rows),
  };
}
