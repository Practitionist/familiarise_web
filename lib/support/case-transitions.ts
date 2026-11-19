import type { SupportCaseStatus } from "@prisma/client";

/**
 * Who asks for a move: the customer or their guided flow, an operator, a scheduled job,
 * or a new conduct removal joining its learner's unclosed removal case (that door alone).
 */
export type CaseTransitionActor = "CUSTOMER" | "STAFF" | "SYSTEM" | "REMOVAL";

interface TransitionRule {
  actors: readonly CaseTransitionActor[];
  /** Refused once the case has a recorded decision. */
  undecidedOnly?: true;
  /** Actors a recorded decision does not stop: a new removal reopens the review, not the verdict. */
  decidedActors?: readonly CaseTransitionActor[];
}

/**
 * Every status move a writer may make; a missing pair is refused. Same-status
 * writes are not moves. Callers keep their own compare-and-set.
 */
export const CASE_TRANSITIONS: Record<
  SupportCaseStatus,
  Partial<Record<SupportCaseStatus, TransitionRule>>
> = {
  OPEN: {
    IN_PROGRESS: { actors: ["CUSTOMER", "STAFF"] },
    ESCALATED: { actors: ["CUSTOMER"] },
    RESOLVED: { actors: ["CUSTOMER", "STAFF", "SYSTEM"] },
    CLOSED: { actors: ["STAFF"] },
  },
  IN_PROGRESS: {
    OPEN: { actors: ["CUSTOMER", "STAFF"] },
    ESCALATED: { actors: ["CUSTOMER"] },
    RESOLVED: { actors: ["CUSTOMER", "STAFF", "SYSTEM"] },
    CLOSED: { actors: ["STAFF"] },
  },
  ESCALATED: {
    OPEN: { actors: ["REMOVAL"] },
    IN_PROGRESS: { actors: ["STAFF"] },
    RESOLVED: { actors: ["STAFF", "SYSTEM"] },
    CLOSED: { actors: ["STAFF"] },
  },
  RESOLVED: {
    OPEN: {
      actors: ["CUSTOMER", "STAFF", "REMOVAL"],
      undecidedOnly: true,
      decidedActors: ["REMOVAL"],
    },
    IN_PROGRESS: { actors: ["CUSTOMER", "STAFF"], undecidedOnly: true },
    // A guided answer that did not help may still be handed to a person.
    ESCALATED: { actors: ["CUSTOMER"], undecidedOnly: true },
    CLOSED: { actors: ["STAFF", "SYSTEM"] },
  },
  CLOSED: {
    OPEN: { actors: ["STAFF"], undecidedOnly: true },
    IN_PROGRESS: { actors: ["STAFF"], undecidedOnly: true },
  },
};

const statusLabel = (status: SupportCaseStatus) =>
  status.toLowerCase().replace(/_/g, " ");

export type CaseTransitionRefusal = {
  status: 409;
  code: "CASE_DECIDED" | "INVALID_TRANSITION";
  error: string;
};

export function caseTransitionRefusal(
  from: SupportCaseStatus,
  to: SupportCaseStatus,
  { decided, actor }: { decided: boolean; actor: CaseTransitionActor },
): CaseTransitionRefusal | null {
  if (from === to) return null;
  const rule = CASE_TRANSITIONS[from][to];
  if (rule?.undecidedOnly && decided && !rule.decidedActors?.includes(actor))
    return {
      status: 409,
      code: "CASE_DECIDED",
      error:
        "This request has a decision, so it can't be reopened. You can appeal the decision instead.",
    };
  if (!rule?.actors.includes(actor))
    return {
      status: 409,
      code: "INVALID_TRANSITION",
      error: `A ${statusLabel(from)} request can't move to ${statusLabel(to)}. Refresh and try again.`,
    };
  return null;
}

/** A refused support write whose body the route returns as is, without a Sentry event. */
export class CaseConflictError extends Error {
  constructor(
    readonly body: { code: string; error: string } & Record<string, unknown>,
    readonly status: number = 409,
  ) {
    super(body.error);
    this.name = "CaseConflictError";
  }
}

export function assertCaseTransition(
  from: SupportCaseStatus,
  to: SupportCaseStatus,
  options: { decided: boolean; actor: CaseTransitionActor },
): void {
  const refusal = caseTransitionRefusal(from, to, options);
  if (!refusal) return;
  const { status, ...body } = refusal;
  throw new CaseConflictError(body, status);
}
