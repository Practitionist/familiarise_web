/**
 * @jest-environment node
 */

/**
 * A safety concern (threat, harassment, scam or a request to pay outside
 * Familiarise) is offered on every booking, always reaches a person at URGENT,
 * files under the session topic and is withheld from organization views.
 */

jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

import { FlowchartResolver } from "@/lib/support/resolvers/flowchart-resolver";
import { flowForCategory, flowsForContext } from "@/lib/support/flows";
import { ORG_PARTY_CATEGORIES } from "@/lib/support/service";
import {
  escalationPriority,
  issueTypeForReason,
  priorityForReason,
} from "@/lib/support/priority";
import { threadTopic, ticketTopic } from "@/lib/support/case-topic";
import { ORG_SENSITIVE_PERSONAL_CATEGORIES } from "@/lib/support/case-access";
import { SupportThreadCategoryEnum } from "@/schemas/enums";
import type { SupportContext, SupportStage } from "@/lib/support/types";

function ctx(overrides: Partial<SupportContext> = {}): SupportContext {
  return {
    threadId: "t1",
    appointmentId: "a1",
    userId: "u1",
    organizationId: null,
    appointmentType: "CONSULTATION" as SupportContext["appointmentType"],
    isOrgContext: false,
    isProvider: false,
    isOrgOperator: false,
    stage: "UPCOMING",
    startsAt: new Date("2026-08-01T10:00:00Z"),
    endsAt: new Date("2026-08-01T11:00:00Z"),
    reportSessions: [],
    reportOccurrenceId: null,
    refundPctIfCancelledNow: 100,
    paymentId: "pay1",
    paymentAmountPaise: 1000_00,
    hasRecording: false,
    planTitle: null,
    ...overrides,
  };
}

const REASONS = {
  threat: "safety_threat",
  scam: "fraud_scam",
  other: "safety_other",
} as const;

describe("SAFETY_CONCERN intake", () => {
  it("is a real thread category", () => {
    expect(SupportThreadCategoryEnum.safeParse("SAFETY_CONCERN").success).toBe(
      true,
    );
  });

  it.each(["UPCOMING", "LIVE", "COMPLETED"] as SupportStage[])(
    "is offered to both sides at stage %s",
    (stage) => {
      for (const isProvider of [false, true]) {
        const offered = flowsForContext(ctx({ stage, isProvider })).map(
          (f) => f.category,
        );
        expect(offered).toContain("SAFETY_CONCERN");
      }
    },
  );

  it("is not an org-party intent", () => {
    expect(ORG_PARTY_CATEGORIES.has("SAFETY_CONCERN")).toBe(false);
  });

  it("presents three options, each of which escalates", async () => {
    const flow = flowForCategory(ctx(), "SAFETY_CONCERN")!;
    expect(flow.title).toBe("Safety concern or scam");
    const turn = await new FlowchartResolver(flow).resolveTurn(ctx(), null, {});
    expect(turn.messages[0].body).toMatch(/pay outside Familiarise/);
    expect(turn.messages[0].metadata?.options).toEqual([
      {
        id: "threat",
        label: "Someone threatened or harassed me",
        escalates: true,
      },
      {
        id: "scam",
        label:
          "A scam, fake payment link or a request to pay outside Familiarise",
        escalates: true,
      },
      { id: "other", label: "Another safety risk", escalates: true },
    ]);
  });

  it.each(Object.entries(REASONS))(
    "routes %s to a person with reason %s",
    async (option, reason) => {
      const flow = flowForCategory(ctx(), "SAFETY_CONCERN")!;
      const turn = await new FlowchartResolver(flow).resolveTurn(
        ctx(),
        "start",
        { chosenOptionId: option },
      );
      expect(turn.escalate).toBe(true);
      expect(turn.resolved).toBe(false);
      expect(turn.actions).toEqual([]);
      expect(turn.reason).toBe(reason);
    },
  );

  it.each(Object.values(REASONS))(
    "%s burns URGENT and the urgent flag never lowers it",
    (reason) => {
      expect(priorityForReason(reason)).toBe("URGENT");
      expect(escalationPriority(reason, true)).toBe("URGENT");
      expect(escalationPriority(reason, false)).toBe("URGENT");
    },
  );

  it("keeps the urgent flag raising ordinary reasons to HIGH", () => {
    expect(escalationPriority("quality_poor", true)).toBe("HIGH");
    expect(escalationPriority("quality_poor", undefined)).toBe("MEDIUM");
  });

  it.each(Object.values(REASONS))("types %s as GENERAL_INQUIRY", (reason) => {
    expect(issueTypeForReason(reason)).toBe("GENERAL_INQUIRY");
  });

  it("files under the session topic", () => {
    expect(threadTopic("SAFETY_CONCERN")).toBe("session");
    expect(
      ticketTopic({ category: "SAFETY_CONCERN", issueType: "GENERAL_INQUIRY" }),
    ).toBe("session");
  });

  it("is counted but never listed in organization views", () => {
    expect(ORG_SENSITIVE_PERSONAL_CATEGORIES).toContain("SAFETY_CONCERN");
  });
});
