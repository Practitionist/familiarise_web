import type { Tone } from "@/lib/ui/tone";
import type {
  LibraryDocStatus,
  LibraryVersionStatus,
} from "@/lib/library/library-query";
import type { ThreadBannerKind, ThreadStatus } from "./thread-view";
import {
  DOCUMENT_RETENTION_DAYS,
  DOCUMENT_UPLOAD_WINDOW_DAYS,
} from "./document-dates";

/**
 * Copy for document threads: status chips, the "who acts next" banner and the
 * read-only notice. Pure; dates are formatted by the caller's zone formatter.
 */

export type DayFormat = (iso: string) => string;

export const THREAD_STATUS_CHIP: Record<
  ThreadStatus,
  { learner: string; expert: string; tone: Tone }
> = {
  WAITING_FOR_EXPERT: {
    learner: "Waiting for review",
    expert: "Your turn",
    tone: "info",
  },
  IN_REVIEW: { learner: "In review", expert: "In review", tone: "info" },
  NEEDS_REVISION: {
    learner: "Your turn",
    expert: "Waiting for learner",
    tone: "caution",
  },
  APPROVED: { learner: "Approved", expert: "Approved", tone: "success" },
  NOT_ACCEPTED: {
    learner: "Not accepted",
    expert: "Not accepted",
    tone: "critical",
  },
  SHARED: { learner: "Shared", expert: "Shared by you", tone: "neutral" },
};

/** Side-neutral labels for lists that mix the viewer's roles. */
export const THREAD_STATUS_NEUTRAL: Record<ThreadStatus, string> = {
  WAITING_FOR_EXPERT: "Waiting for review",
  IN_REVIEW: "In review",
  NEEDS_REVISION: "Needs revision",
  APPROVED: "Approved",
  NOT_ACCEPTED: "Not accepted",
  SHARED: "Shared",
};

/** One version's own review state, for version lists. */
export const VERSION_STATUS_CHIP: Record<
  LibraryVersionStatus,
  { label: string; tone: Tone }
> = {
  PENDING: { label: "Waiting for review", tone: "info" },
  IN_REVIEW: { label: "In review", tone: "info" },
  NEEDS_REVISION: { label: "Changes requested", tone: "caution" },
  APPROVED: { label: "Approved", tone: "success" },
  REJECTED: { label: "Not accepted", tone: "critical" },
  SUPERSEDED: { label: "Superseded", tone: "neutral" },
};

export function threadBannerText(args: {
  kind: ThreadBannerKind;
  viewerRole: "learner" | "expert";
  learnerName: string;
  expertName: string;
  expertOrg: string | null;
  since: string;
  versionNo: number;
  day: DayFormat;
}): string {
  const { learnerName, versionNo, since, day } = args;
  const expert = args.expertOrg
    ? `${args.expertName} (${args.expertOrg})`
    : args.expertName;
  const learner = args.viewerRole === "learner";
  const v = `v${versionNo}`;
  switch (args.kind) {
    case "WAITING_FOR_EXPERT":
      return learner
        ? `Waiting for ${expert} to review ${v} (since ${day(since)}).`
        : `${learnerName} uploaded ${v} on ${day(since)}. Your turn.`;
    case "IN_REVIEW":
      return learner
        ? `${expert} is reviewing ${v}. You can upload again once they respond.`
        : `You started reviewing ${v} on ${day(since)}.`;
    case "NEEDS_REVISION":
      return learner
        ? `Your turn: ${args.expertName} asked for changes on ${day(since)}.`
        : `Waiting for ${learnerName} to upload a revision.`;
    case "APPROVED":
      return learner
        ? `Approved by ${expert} on ${day(since)}.`
        : `You approved ${v} on ${day(since)}.`;
    case "NOT_ACCEPTED":
      return learner
        ? `Not accepted by ${expert} on ${day(since)}.`
        : `You marked ${v} as not accepted on ${day(since)}.`;
    case "SHARED":
      return learner
        ? `Shared by ${expert} on ${day(since)}.`
        : `You shared this on ${day(since)}.`;
    case "REMOVAL_REQUESTED":
      return learner
        ? `Removal requested on ${day(since)}. Support will respond in your session's support chat.`
        : `${learnerName} asked support to remove this on ${day(since)}.`;
  }
}

/** Why the whole workspace is read-only, with its dates. */
export function readOnlyNotice(args: {
  reason:
    "APPOINTMENT_TERMINAL" | "BOOKING_NOT_CONFIRMED" | "UPLOAD_WINDOW_CLOSED";
  terminalAt: string | null;
  closesAt: string | null;
  keptUntil: string | null;
  day: DayFormat;
}): string {
  const kept = args.keptUntil
    ? ` Files are kept until ${args.day(args.keptUntil)}.`
    : "";
  switch (args.reason) {
    case "APPOINTMENT_TERMINAL":
      return args.terminalAt
        ? `This booking was cancelled on ${args.day(args.terminalAt)}. Its files are read-only.${kept}`
        : `This booking was cancelled. Its files are read-only.${kept}`;
    case "BOOKING_NOT_CONFIRMED":
      return "You can share files once the booking is confirmed.";
    case "UPLOAD_WINDOW_CLOSED":
      return args.closesAt
        ? `This booking's documents are read-only since ${args.day(args.closesAt)} (${DOCUMENT_UPLOAD_WINDOW_DAYS} days after the last session).${kept}`
        : `This booking's documents are read-only.${kept}`;
  }
}

/** "Uploads open until …" / "Kept until …" for an open booking. */
export function windowNotice(args: {
  closesAt: string | null;
  keptUntil: string | null;
  day: DayFormat;
}): string[] {
  return [
    args.closesAt
      ? `Uploads open until ${args.day(args.closesAt)} (${DOCUMENT_UPLOAD_WINDOW_DAYS} days after the last session).`
      : `Uploads stay open until ${DOCUMENT_UPLOAD_WINDOW_DAYS} days after the last session.`,
    args.keptUntil
      ? `Files are kept until ${args.day(args.keptUntil)} (${DOCUMENT_RETENTION_DAYS} days after the booking ends).`
      : `Files are kept until ${DOCUMENT_RETENTION_DAYS} days after the booking ends.`,
  ];
}

/** Whose Library a status filter labels: one side's chips, or both for a mixed view. */
export type LibrarySide = "learner" | "expert" | "mixed";

/** The Library status a thread falls under; its filter and its row chip both read this. */
export function libraryBucket(thread: {
  shared: boolean;
  status: ThreadStatus;
  needsYou: boolean;
}): LibraryDocStatus {
  if (thread.shared) return "shared";
  if (thread.status === "APPROVED" || thread.status === "NOT_ACCEPTED") {
    return "done";
  }
  return thread.needsYou ? "your-turn" : "waiting";
}

const WAITING_LABEL = {
  learner: THREAD_STATUS_CHIP.WAITING_FOR_EXPERT.learner,
  expert: THREAD_STATUS_CHIP.NEEDS_REVISION.expert,
};

/** The status filter's options in the same words as the row chips for that side. */
export function libraryStatusLabel(
  status: LibraryDocStatus,
  side: LibrarySide,
): string {
  switch (status) {
    case "your-turn":
      return side === "expert"
        ? THREAD_STATUS_CHIP.WAITING_FOR_EXPERT.expert
        : THREAD_STATUS_CHIP.NEEDS_REVISION.learner;
    case "waiting":
      return side === "mixed"
        ? `${WAITING_LABEL.learner} / ${WAITING_LABEL.expert}`
        : WAITING_LABEL[side];
    case "done":
      return `${THREAD_STATUS_NEUTRAL.APPROVED} / ${THREAD_STATUS_NEUTRAL.NOT_ACCEPTED}`;
    case "shared":
      return THREAD_STATUS_NEUTRAL.SHARED;
  }
}

/** A Library row's chip: the filter's own words while open, the outcome once done. */
export function libraryChip(
  thread: { shared: boolean; status: ThreadStatus; needsYou: boolean },
  side: "learner" | "expert",
): { label: string; tone: Tone } {
  const bucket = libraryBucket(thread);
  if (bucket === "your-turn") {
    return { label: libraryStatusLabel(bucket, side), tone: "caution" };
  }
  if (bucket === "waiting") {
    return { label: libraryStatusLabel(bucket, side), tone: "info" };
  }
  return {
    label: THREAD_STATUS_NEUTRAL[thread.status],
    tone: THREAD_STATUS_CHIP[thread.status].tone,
  };
}
