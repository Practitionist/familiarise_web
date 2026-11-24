/** @jest-environment node */

// Invariant: every terminal reason of the appointment flows is a member of the
// enum `SupportCase.flowReason` is checked against, and each no-show flow
// offers "I was there" only for its own side's reason.

import { ALL_FLOWS, flowForCategory } from "@/lib/support/flows";
import type { SupportContext } from "@/lib/support/types";
import { SupportFlowReasonEnum } from "@/schemas/enums";

const terminalReasons = ALL_FLOWS.flatMap((flow) =>
  Object.values(flow.nodes).flatMap((node) =>
    node.kind === "TERMINAL" && node.reason ? [node.reason] : [],
  ),
);

it("the reason enum lists exactly the flows' terminal reasons", () => {
  expect(new Set(terminalReasons)).toEqual(
    new Set(SupportFlowReasonEnum.options),
  );
});

function noShowReasons(isProvider: boolean): string[] {
  const ctx: SupportContext = {
    threadId: "t1",
    appointmentId: "a1",
    userId: "u1",
    organizationId: null,
    appointmentType: "CONSULTATION",
    isOrgContext: false,
    isProvider,
    isOrgOperator: false,
    stage: "COMPLETED",
    startsAt: null,
    endsAt: null,
    reportSessions: [
      {
        id: "occ-ended",
        startsAt: new Date("2026-11-23T10:00:00Z"),
        endsAt: new Date("2026-11-23T11:00:00Z"),
      },
    ],
    reportOccurrenceId: "occ-ended",
    refundPctIfCancelledNow: null,
    paymentId: null,
    paymentAmountPaise: null,
    hasRecording: false,
    planTitle: null,
  };
  const flow = flowForCategory(ctx, "NO_SHOW");
  const start = flow?.nodes[flow.entryNodeId];
  // The reasons the first question's options lead to.
  return (start?.kind === "PROMPT" ? start.options : []).flatMap((option) => {
    const node = flow?.nodes[option.next ?? ""];
    return node?.kind === "TERMINAL" && node.reason ? [node.reason] : [];
  });
}

it("offers the learner's 'I was there' to a learner and the expert's to an expert", () => {
  expect(noShowReasons(false)).toContain("attendee_attended");
  expect(noShowReasons(false)).not.toContain("provider_attended");
  expect(noShowReasons(true)).toContain("provider_attended");
  expect(noShowReasons(true)).not.toContain("attendee_attended");
});
