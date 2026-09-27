/**
 * #1527 — the user's request page: the status timeline reads both a ticket's
 * and a conversation's status, and a support notification links the request
 * page (the org's dashboard for an org session, else the go resolver).
 */

import { supportRequestHref } from "@/lib/novu/resolve-href";
import { requestStage } from "@/lib/support/request-stage";

describe("requestStage", () => {
  it.each([
    [{ kind: "ticket", status: "OPEN" }, 0, "Resolved"],
    [{ kind: "ticket", status: "ON_HOLD" }, 1, "Resolved"],
    [{ kind: "ticket", status: "CLOSED" }, 2, "Closed"],
    [
      { kind: "thread", status: "IN_PROGRESS", channel: "SELF_SERVE" },
      0,
      "Resolved",
    ],
    [{ kind: "thread", status: "ESCALATED", channel: "HUMAN" }, 1, "Resolved"],
    [{ kind: "thread", status: null, channel: null }, 0, "Resolved"],
    [{ kind: "thread", status: "RESOLVED", channel: "HUMAN" }, 2, "Resolved"],
  ] as const)("%j → step %s", (request, step, settledLabel) => {
    expect(requestStage(request)).toEqual({ step, settledLabel });
  });
});

describe("supportRequestHref", () => {
  it("links the request page in the right dashboard", () => {
    expect(supportRequestHref("t_1")).toMatch(
      /\/dashboard\/go\/auto\/support\/requests\/t_1$/,
    );
    expect(supportRequestHref("t_1", "org9")).toMatch(
      /\/dashboard\/organization\/org9\/support\/requests\/t_1$/,
    );
  });
});
