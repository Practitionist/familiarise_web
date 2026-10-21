/** Customer-facing progress for the canonical support-case lifecycle. */
export const REQUEST_STEPS = ["Open", "With the team", "Resolved"] as const;
export interface RequestStage {
  step: 0 | 1 | 2;
  settledLabel: "Resolved" | "Closed";
}
export function requestStage({
  status,
  selfServe = false,
}: {
  status: string | null;
  /** Still in the guided flow: no person is involved yet, whatever the status. */
  selfServe?: boolean;
}): RequestStage {
  if (status === "CLOSED") return { step: 2, settledLabel: "Closed" };
  if (status === "RESOLVED") return { step: 2, settledLabel: "Resolved" };
  return {
    step:
      !selfServe && (status === "IN_PROGRESS" || status === "ESCALATED")
        ? 1
        : 0,
    settledLabel: "Resolved",
  };
}
