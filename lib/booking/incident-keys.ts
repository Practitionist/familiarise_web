/** Every refund a declared platform incident issues carries this key prefix. */
export const INCIDENT_REFUND_KEY_PREFIX = "incident:";

/** One refund per incident, session and learner, on every rail. */
export const incidentRefundKey = (
  incidentId: string,
  occurrenceId: string,
  userId: string,
) => `${INCIDENT_REFUND_KEY_PREFIX}${incidentId}:${occurrenceId}:${userId}`;

/** Failed attempts after which a remedy is dead-lettered for an operator; matches the refund-owed retire count. */
export const MAX_REMEDY_ATTEMPTS = 3;
export const DEAD_LETTER_PREFIX = "dead-letter:";

/** A voided 1:1 may be rebooked free while its consultation or trial is in one of these statuses. */
export const REBOOKABLE_PARENT_STATUSES: ReadonlySet<string> = new Set([
  "SCHEDULED",
  "COMPLETED",
]);
