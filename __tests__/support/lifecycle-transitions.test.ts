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
const ACTORS: CaseTransitionActor[] = ["CUSTOMER", "STAFF", "SYSTEM"];

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
  "ESCALATED>RESOLVED": ["STAFF", "SYSTEM"],
  "ESCALATED>CLOSED": ["STAFF"],
  "RESOLVED>OPEN": ["CUSTOMER", "STAFF"],
  "RESOLVED>IN_PROGRESS": ["CUSTOMER", "STAFF"],
  "RESOLVED>ESCALATED": ["CUSTOMER"],
  "RESOLVED>CLOSED": ["STAFF", "SYSTEM"],
  "CLOSED>OPEN": ["STAFF"],
  "CLOSED>IN_PROGRESS": ["STAFF"],
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

describe("case status transition table", () => {
  it.each(cases)(
    "$from → $to by $actor (decided: $decided)",
    ({ from, to, actor, decided }) => {
      const key = `${from}>${to}`;
      const refusal = caseTransitionRefusal(from, to, { decided, actor });
      if (from === to) {
        expect(refusal).toBeNull();
        return;
      }
      if (decided && UNDECIDED_ONLY.has(key)) {
        expect(refusal).toMatchObject({ status: 409, code: "CASE_DECIDED" });
        return;
      }
      if (ALLOWED[key]?.includes(actor)) expect(refusal).toBeNull();
      else
        expect(refusal).toMatchObject({
          status: 409,
          code: "INVALID_TRANSITION",
        });
    },
  );

  it("never lets a decided case leave RESOLVED except to close", () => {
    for (const to of STATUSES.filter((s) => s !== "RESOLVED"))
      for (const actor of ACTORS) {
        const refusal = caseTransitionRefusal("RESOLVED", to, {
          decided: true,
          actor,
        });
        if (to === "CLOSED" && actor !== "CUSTOMER") expect(refusal).toBeNull();
        else expect(refusal).not.toBeNull();
      }
  });

  it("throws a conflict whose body carries no status field", () => {
    expect.assertions(3);
    try {
      assertCaseTransition("CLOSED", "OPEN", { decided: true, actor: "STAFF" });
    } catch (error) {
      expect(error).toBeInstanceOf(CaseConflictError);
      expect((error as CaseConflictError).status).toBe(409);
      expect((error as CaseConflictError).body).toEqual({
        code: "CASE_DECIDED",
        error: expect.any(String),
      });
    }
  });
});
