/** The numbers the collaborator rules turn on; Postgres enforces the two caps as well. */
export const MAX_COLLABORATORS_PER_PLAN = 3;
export const MAX_TEAM_SHARE_BPS = 9000;

/** An invitation lapses this long after it was sent or its terms last changed. */
export const INVITE_TTL_DAYS = 14;
export const INVITE_REMINDER_DAYS_BEFORE = 3;

/** After a decline or a departure, the same plan waits this long before inviting that expert again. */
export const REINVITE_COOLDOWN_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

export const percentToBps = (percent: number): number => percent * 100;
export const bpsToPercent = (bps: number): number => bps / 100;

/** When a pending invitation lapses, from the time it was last sent or changed. */
export function inviteExpiresAt(lastChangedAt: Date): Date {
  return new Date(lastChangedAt.getTime() + INVITE_TTL_DAYS * DAY_MS);
}

/** The earliest time a plan may invite again an expert who declined or left at `endedAt`. */
export function reinviteAllowedAt(endedAt: Date): Date {
  return new Date(endedAt.getTime() + REINVITE_COOLDOWN_DAYS * DAY_MS);
}

/** An invitation last sent or changed before this time has lapsed at `now`. */
export function inviteLapsedBefore(now: Date): Date {
  return new Date(now.getTime() - INVITE_TTL_DAYS * DAY_MS);
}
