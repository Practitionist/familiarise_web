/**
 * #1527 — the user's status timeline for a support request: Open → With the
 * team → Resolved/Closed, over both a ticket's and a conversation's status.
 * Pure.
 */

export const REQUEST_STEPS = ["Open", "With the team", "Resolved"] as const;

export interface RequestStage {
  /** 0 Open, 1 With the team, 2 settled. */
  step: 0 | 1 | 2;
  /** The last step's label: "Resolved", or "Closed" when it was closed. */
  settledLabel: "Resolved" | "Closed";
}

export function requestStage(
  request:
    | { kind: "ticket"; status: string }
    | { kind: "thread"; status: string | null; channel: string | null },
): RequestStage {
  const { status } = request;
  if (status === "CLOSED") return { step: 2, settledLabel: "Closed" };
  if (status === "RESOLVED") return { step: 2, settledLabel: "Resolved" };
  const withTeam =
    request.kind === "ticket"
      ? status === "IN_PROGRESS" || status === "ON_HOLD"
      : request.channel === "HUMAN" || status === "ESCALATED";
  return { step: withTeam ? 1 : 0, settledLabel: "Resolved" };
}
