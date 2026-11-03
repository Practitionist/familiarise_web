// How a plan's sessions were placed, recorded as the `reason` on the
// BookingStatusHistory row every allocation writes. The consultant's choice
// when scheduling the plan (not one later week) decides whether the hourly
// top-up may place the plan's open weeks on its own.

/** The consultant (or an operator) scheduled the plan with Auto. */
export const SCHEDULED_AUTO = "Scheduled automatically";
/** The consultant scheduled the plan by picking times, or confirmed the client's. */
export const SCHEDULED_BY_HAND = "Scheduled by hand";
/** One later week placed with the one-tap Auto: not a choice for the plan. */
export const SCHEDULED_WEEK_AUTO = "This week scheduled automatically";
/** One later week placed by hand: not a choice for the plan. */
export const SCHEDULED_WEEK_BY_HAND = "This week scheduled by hand";
/** The hourly top-up placed an open week for a plan its consultant runs on Auto. */
export const SCHEDULED_BY_TOP_UP = "Open week scheduled automatically";
/** A reschedule's new times were confirmed; not a scheduling choice. */
export const SCHEDULED_BY_RESCHEDULE = "New times confirmed";

/** The consultant's choices, never the sweep's or a reschedule's. */
export const SCHEDULING_CHOICES = [SCHEDULED_AUTO, SCHEDULED_BY_HAND] as const;

/** Whether the newest choice (rows newest first) was Auto. */
export function lastChoiceWasAuto(
  reasonsNewestFirst: ReadonlyArray<string | null>,
): boolean {
  const choice = reasonsNewestFirst.find(
    (reason): reason is string =>
      reason !== null &&
      (SCHEDULING_CHOICES as readonly string[]).includes(reason),
  );
  return choice === SCHEDULED_AUTO;
}

/** The history reason one allocation run records. */
export function scheduleReason(args: {
  mode: "auto" | "manual" | "requested";
  /** A later week appended to a plan that already holds sessions. */
  topUp?: boolean;
  bySweep?: boolean;
  confirmsReschedule?: boolean;
}): string {
  if (args.confirmsReschedule) return SCHEDULED_BY_RESCHEDULE;
  if (args.bySweep) return SCHEDULED_BY_TOP_UP;
  const auto = args.mode === "auto";
  if (args.topUp) return auto ? SCHEDULED_WEEK_AUTO : SCHEDULED_WEEK_BY_HAND;
  return auto ? SCHEDULED_AUTO : SCHEDULED_BY_HAND;
}
