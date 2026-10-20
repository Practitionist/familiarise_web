/**
 * #1527 — the user's request page: the status timeline reads both a ticket's
 * and a conversation's status, and a support notification links the request
 * page (the org's dashboard for an org session, else the go resolver).
 */

import { supportRequestHref } from "@/lib/novu/resolve-href";
import { requestStage } from "@/lib/support/request-stage";

describe("requestStage", () => {
  it.each([
    [{ status: "OPEN" }, 0, "Resolved"],
    [{ status: "IN_PROGRESS" }, 1, "Resolved"],
    [{ status: "CLOSED" }, 2, "Closed"],
    [{ status: "IN_PROGRESS" }, 1, "Resolved"],
    [{ status: "ESCALATED" }, 1, "Resolved"],
    [{ status: null }, 0, "Resolved"],
    [{ status: "RESOLVED" }, 2, "Resolved"],
  ] as const)("%j → step %s", (request, step, settledLabel) => {
    expect(requestStage(request)).toEqual({ step, settledLabel });
  });
});

describe("supportRequestHref", () => {
  it("links the request page in the right dashboard", () => {
    expect(supportRequestHref("c_1")).toMatch(
      /\/dashboard\/go\/auto\/support\/requests\/c_1$/,
    );
    expect(supportRequestHref("c_1", "org9")).toMatch(
      /\/dashboard\/organization\/org9\/support\/requests\/c_1$/,
    );
  });
});
