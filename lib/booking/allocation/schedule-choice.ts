// How a plan's sessions were placed, recorded as a stable machine token in
// the `reason` of the BookingStatusHistory row every allocation writes. The
// plan-level choice (made when the plan is first scheduled) decides whether
// the hourly top-up may place the plan's open weeks on its own. Tokens are
// parsed strictly; the words people read come from SCHEDULE_REASON_COPY.

export const SCHEDULE_REASON = {
  /** The plan's first scheduling, with Auto. */
  planAuto: "schedule:auto",
  /** The plan's first scheduling, by picking times (or confirming the client's). */
  planByHand: "schedule:by-hand",
  /** One later week placed with Auto (the one-tap): not a plan-level choice. */
  weekAuto: "schedule:week-auto",
  /** One later week placed by hand: not a plan-level choice. */
  weekByHand: "schedule:week-by-hand",
  /** The hourly top-up placed an open week. */
  topUp: "schedule:top-up",
  /** Released sessions re-placed, or a reschedule's times confirmed. */
  reschedule: "schedule:reschedule",
  /** The Regular time placed a session at its exact time: not a plan-level choice. */
  regular: "schedule:regular",
} as const;

export type ScheduleReason =
  (typeof SCHEDULE_REASON)[keyof typeof SCHEDULE_REASON];

const TOKENS = new Set<string>(Object.values(SCHEDULE_REASON));

/** The token a history `reason` holds, or null for any other reason. */
export function parseScheduleReason(
  reason: string | null,
): ScheduleReason | null {
  return reason !== null && TOKENS.has(reason)
    ? (reason as ScheduleReason)
    : null;
}

/** What the booking timeline shows for each token. */
export const SCHEDULE_REASON_COPY: Record<ScheduleReason, string> = {
  "schedule:auto": "Scheduled automatically",
  "schedule:by-hand": "Scheduled by hand",
  "schedule:week-auto": "This week scheduled automatically",
  "schedule:week-by-hand": "This week scheduled by hand",
  "schedule:top-up": "Open week scheduled automatically",
  "schedule:reschedule": "New times confirmed",
  "schedule:regular": "Placed at the regular time",
};

/** The plan-level choices, never a week's, the sweep's or a reschedule's. */
export const PLAN_CHOICES: readonly ScheduleReason[] = [
  SCHEDULE_REASON.planAuto,
  SCHEDULE_REASON.planByHand,
];

/**
 * Whether the plan's newest plan-level choice (rows newest first) was Auto.
 * A plan with no choice recorded (scheduled before tokens existed) is by hand.
 */
export function lastChoiceWasAuto(
  reasonsNewestFirst: ReadonlyArray<string | null>,
): boolean {
  const choice = reasonsNewestFirst
    .map(parseScheduleReason)
    .find((token) => token !== null && PLAN_CHOICES.includes(token));
  return choice === SCHEDULE_REASON.planAuto;
}

/**
 * The token one allocation run records, from server-side facts only: whether
 * the plan was ever placed before (never a client flag), the mode, and who
 * ran it. Only the consultant's own first placement is a plan-level choice;
 * a caller that does not say it is the consultant never records one.
 */
export function scheduleReason(args: {
  mode: "auto" | "manual" | "requested";
  /** The plan had a confirmed session at any time before this run, live or not. */
  placedBefore: boolean;
  /** Released sessions awaiting a new time before this run. */
  releasedBefore: number;
  bySweep?: boolean;
  byRegularTime?: boolean;
  byConsultant?: boolean;
  confirmsReschedule?: boolean;
}): ScheduleReason {
  if (args.byRegularTime) return SCHEDULE_REASON.regular;
  if (args.bySweep) return SCHEDULE_REASON.topUp;
  if (args.confirmsReschedule || args.releasedBefore > 0) {
    return SCHEDULE_REASON.reschedule;
  }
  const auto = args.mode === "auto";
  if (args.placedBefore || !args.byConsultant) {
    return auto ? SCHEDULE_REASON.weekAuto : SCHEDULE_REASON.weekByHand;
  }
  return auto ? SCHEDULE_REASON.planAuto : SCHEDULE_REASON.planByHand;
}
