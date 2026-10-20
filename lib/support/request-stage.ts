/** Customer-facing progress for the canonical support-case lifecycle. */
export const REQUEST_STEPS = ["Open", "With the team", "Resolved"] as const;
export interface RequestStage {
  step: 0 | 1 | 2;
  settledLabel: "Resolved" | "Closed";
}
export function requestStage({
  status,
}: {
  status: string | null;
}): RequestStage {
  if (status === "CLOSED") return { step: 2, settledLabel: "Closed" };
  if (status === "RESOLVED") return { step: 2, settledLabel: "Resolved" };
  return {
    step: status === "IN_PROGRESS" || status === "ESCALATED" ? 1 : 0,
    settledLabel: "Resolved",
  };
}
