// How a batch of sessions was placed, recorded as a stable machine token in
// the `reason` of the BookingStatusHistory row every allocation writes. Tokens
// are matched exactly; the words people read come from scheduleReasonWords.

export const SCHEDULE_REASON = {
  /** Placed with Auto. */
  auto: "schedule:auto",
  /** Placed by picking times, or by confirming the client's. */
  byHand: "schedule:by-hand",
  /** Released sessions re-placed, or a reschedule's times confirmed. */
  reschedule: "schedule:reschedule",
} as const;

export type ScheduleReason =
  (typeof SCHEDULE_REASON)[keyof typeof SCHEDULE_REASON];

const WORDS: Record<string, string> = {
  [SCHEDULE_REASON.auto]: "Scheduled automatically",
  [SCHEDULE_REASON.byHand]: "Scheduled by hand",
  [SCHEDULE_REASON.reschedule]: "New times confirmed",
  // No writer records these any more; stored history rows still carry them.
  "schedule:week-auto": "Scheduled automatically",
  "schedule:week-by-hand": "Scheduled by hand",
  "schedule:top-up": "Scheduled automatically",
};

/** What the booking timeline shows for a scheduling token, or null for any other reason. */
export function scheduleReasonWords(reason: string | null): string | null {
  return reason !== null && Object.hasOwn(WORDS, reason) ? WORDS[reason] : null;
}

/** The token one allocation run records, from server-side facts only. */
export function scheduleReason(args: {
  mode: "auto" | "manual" | "requested";
  /** Released sessions awaiting a new time before this run. */
  releasedBefore: number;
  confirmsReschedule?: boolean;
}): ScheduleReason {
  if (args.confirmsReschedule || args.releasedBefore > 0) {
    return SCHEDULE_REASON.reschedule;
  }
  return args.mode === "auto" ? SCHEDULE_REASON.auto : SCHEDULE_REASON.byHand;
}
