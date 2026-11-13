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

/** A voided 1:1 may be rebooked free while its booking is confirmed or completed, per kind. */
export const REBOOKABLE_PARENT_STATUSES: Readonly<
  Record<"consultation" | "trial", ReadonlySet<string>>
> = {
  consultation: new Set(["APPROVED", "COMPLETED"]),
  trial: new Set(["SCHEDULED", "COMPLETED"]),
};

/** Whether a voided booking of this kind may still take its free rebook. */
export function isRebookableParent(
  kind: "consultation" | "trial",
  status: string | null | undefined,
): boolean {
  return !!status && REBOOKABLE_PARENT_STATUSES[kind].has(status);
}
