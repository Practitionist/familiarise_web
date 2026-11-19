/** @jest-environment node */
import type { SupportCaseStatus } from "@prisma/client";
import {
  assertCaseTransition,
  CaseConflictError,
  caseTransitionRefusal,
  type CaseTransitionActor,
} from "../../lib/support/case-transitions";

const STATUSES: SupportCaseStatus[] = [
  "OPEN",
  "IN_PROGRESS",
  "ESCALATED",
  "RESOLVED",
  "CLOSED",
];
const ACTORS: CaseTransitionActor[] = [
  "CUSTOMER",
  "STAFF",
  "SYSTEM",
  "REMOVAL",
];

/** The status matrix the lifecycle promises, written out independently of the implementation. */
const ALLOWED: Record<string, CaseTransitionActor[]> = {
  "OPEN>IN_PROGRESS": ["CUSTOMER", "STAFF"],
  "OPEN>ESCALATED": ["CUSTOMER"],
  "OPEN>RESOLVED": ["CUSTOMER", "STAFF", "SYSTEM"],
  "OPEN>CLOSED": ["STAFF"],
  "IN_PROGRESS>OPEN": ["CUSTOMER", "STAFF"],
  "IN_PROGRESS>ESCALATED": ["CUSTOMER"],
  "IN_PROGRESS>RESOLVED": ["CUSTOMER", "STAFF", "SYSTEM"],
  "IN_PROGRESS>CLOSED": ["STAFF"],
  "ESCALATED>IN_PROGRESS": ["STAFF"],
  // A second conduct removal joining its learner's case puts it back to review.
  "ESCALATED>OPEN": ["REMOVAL"],
  "ESCALATED>RESOLVED": ["STAFF", "SYSTEM"],
  "ESCALATED>CLOSED": ["STAFF"],
  "RESOLVED>OPEN": ["CUSTOMER", "STAFF", "REMOVAL"],
  "RESOLVED>IN_PROGRESS": ["CUSTOMER", "STAFF"],
  "RESOLVED>ESCALATED": ["CUSTOMER"],
  "RESOLVED>CLOSED": ["STAFF", "SYSTEM"],
  "CLOSED>OPEN": ["STAFF"],
  "CLOSED>IN_PROGRESS": ["STAFF"],
};
/** Actors a recorded decision does not stop, per move: a new removal is not a reopen of the verdict. */
const DECIDED_EXEMPT: Record<string, CaseTransitionActor[]> = {
  "RESOLVED>OPEN": ["REMOVAL"],
};
/** Moves out of a settled status that a recorded decision forbids. */
const UNDECIDED_ONLY = new Set([
  "RESOLVED>OPEN",
  "RESOLVED>IN_PROGRESS",
  "RESOLVED>ESCALATED",
  "CLOSED>OPEN",
  "CLOSED>IN_PROGRESS",
]);

const cases = STATUSES.flatMap((from) =>
  STATUSES.flatMap((to) =>
    ACTORS.flatMap((actor) =>
      [false, true].map((decided) => ({ from, to, actor, decided })),
    ),
  ),
);

function expectedCode(
  from: SupportCaseStatus,
  to: SupportCaseStatus,
  actor: CaseTransitionActor,
  decided: boolean,
): string | null {
  const key = `${from}>${to}`;
  if (from === to) return null;
  if (
    decided &&
    UNDECIDED_ONLY.has(key) &&
    !DECIDED_EXEMPT[key]?.includes(actor)
  )
    return "CASE_DECIDED";
  return ALLOWED[key]?.includes(actor) ? null : "INVALID_TRANSITION";
}

function thrown(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return null;
}

describe("case status transition table", () => {
  it.each(cases)(
    "$from → $to by $actor (decided: $decided)",
    ({ from, to, actor, decided }) => {
      const refusal = caseTransitionRefusal(from, to, { decided, actor });
      expect(refusal?.code ?? null).toBe(
        expectedCode(from, to, actor, decided),
      );
      expect([undefined, 409]).toContain(refusal?.status);
    },
  );

  it("never lets a decided case leave RESOLVED except to close, or to review a new removal", () => {
    const allowed = STATUSES.filter((s) => s !== "RESOLVED").flatMap((to) =>
      ACTORS.filter(
        (actor) =>
          caseTransitionRefusal("RESOLVED", to, { decided: true, actor }) ===
          null,
      ).map((actor) => `${to}:${actor}`),
    );
    expect(allowed).toEqual(["OPEN:REMOVAL", "CLOSED:STAFF", "CLOSED:SYSTEM"]);
  });

  it("throws a conflict whose body carries no status field", () => {
    const error = thrown(() =>
      assertCaseTransition("CLOSED", "OPEN", { decided: true, actor: "STAFF" }),
    );
    expect(error).toBeInstanceOf(CaseConflictError);
    expect(error).toMatchObject({
      status: 409,
      body: { code: "CASE_DECIDED", error: expect.any(String) },
    });
    expect(Object.keys((error as CaseConflictError).body)).toEqual([
      "code",
      "error",
    ]);
  });
});
