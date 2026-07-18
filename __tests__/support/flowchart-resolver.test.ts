/**
 * @jest-environment node
 */

/**
 * #appt-support — the SELF_SERVE flowchart resolver + escalation policy. Pure
 * over the flow graph, so this needs no DB — exactly the property that makes the
 * deterministic channel cheap and safe on a money-adjacent surface.
 */

import { FlowchartResolver } from "@/lib/support/resolvers/flowchart-resolver";
import { flowForCategory, flowsForContext } from "@/lib/support/flows";
import { decideEscalation } from "@/lib/support/escalation";
import type { SupportContext } from "@/lib/support/types";

function ctx(overrides: Partial<SupportContext> = {}): SupportContext {
  return {
    threadId: "t1",
    appointmentId: "a1",
    userId: "u1",
    organizationId: null,
    appointmentType: "CONSULTATION" as SupportContext["appointmentType"],
    isOrgContext: false,
    isProvider: false,
    startsAt: new Date("2026-08-01T10:00:00Z"),
    refundPctIfCancelledNow: 100,
    paymentId: "pay1",
    paymentAmountPaise: 1000_00,
    hasRecording: false,
    ...overrides,
  };
}

describe("FlowchartResolver (SELF_SERVE)", () => {
  const cancelFlow = flowForCategory(ctx(), "CANCEL_REFUND")!;

  it("presents the entry prompt on the first turn", async () => {
    const r = new FlowchartResolver(cancelFlow);
    const turn = await r.resolveTurn(ctx(), null, {});
    expect(turn.messages[0].sender).toBe("BOT");
    expect(turn.nextNodeId).toBe("start");
    expect(turn.messages[0].metadata?.options).toEqual([
      { id: "cancel", label: "Cancel and request a refund" },
      { id: "keep", label: "Never mind, keep it" },
    ]);
  });

  it("advances to a terminal that requests the cancel-refund action", async () => {
    const r = new FlowchartResolver(cancelFlow);
    const turn = await r.resolveTurn(ctx(), "start", { chosenOptionId: "cancel" });
    expect(turn.nextNodeId).toBeNull();
    // refundPct is injected from ctx.refundPctIfCancelledNow, not the placeholder.
    expect(turn.actions).toEqual([{ kind: "OFFER_CANCEL_REFUND", refundPct: 100 }]);
  });

  it("resolves cleanly when the user keeps the session", async () => {
    const r = new FlowchartResolver(cancelFlow);
    const turn = await r.resolveTurn(ctx(), "start", { chosenOptionId: "keep" });
    expect(turn.resolved).toBe(true);
    expect(turn.escalate).toBe(false);
  });

  it("re-presents (no crash) on an unrecognized choice", async () => {
    const r = new FlowchartResolver(cancelFlow);
    const turn = await r.resolveTurn(ctx(), "start", { chosenOptionId: "bogus" });
    expect(turn.nextNodeId).toBe("start");
  });

  it("fails safe to a human on an unknown cursor", async () => {
    const r = new FlowchartResolver(cancelFlow);
    const turn = await r.resolveTurn(ctx(), "nonexistent-node", {});
    expect(turn.escalate).toBe(true);
  });
});

describe("flow availability by context", () => {
  it("offers the B2B sponsorship flow only in an org context", () => {
    expect(
      flowsForContext(ctx({ isOrgContext: false })).map((f) => f.category),
    ).not.toContain("SPONSORSHIP_BILLING");
    expect(
      flowsForContext(ctx({ isOrgContext: true })).map((f) => f.category),
    ).toContain("SPONSORSHIP_BILLING");
  });
});

describe("escalation policy", () => {
  const base = {
    messages: [],
    nextNodeId: null,
    actions: [],
    resolved: false,
    escalate: false,
  };

  it("escalates on a human keyword regardless of the flow", () => {
    const d = decideEscalation(ctx(), { ...base, escalate: false }, "I want to talk to a human");
    expect(d.escalate).toBe(true);
    expect(d.reason).toBe("keyword");
  });

  it("escalates when the flow terminal says so", () => {
    const d = decideEscalation(ctx(), { ...base, escalate: true }, "yes");
    expect(d.escalate).toBe(true);
    expect(d.reason).toBe("flow_terminal");
  });

  it("does not escalate an ordinary resolved turn", () => {
    const d = decideEscalation(ctx(), { ...base, escalate: false, resolved: true }, "ok thanks");
    expect(d.escalate).toBe(false);
  });

  it("escalates a refund whose exposure clears the threshold", () => {
    const turn = {
      ...base,
      actions: [{ kind: "OFFER_CANCEL_REFUND" as const, refundPct: 100 }],
    };
    const d = decideEscalation(
      ctx({ paymentAmountPaise: 1000_00 }),
      turn,
      "yes",
      { highValueRefundPaise: 500_00 },
    );
    expect(d.escalate).toBe(true);
    expect(d.reason).toBe("high_value_refund");
  });

  it("does not escalate a refund below the threshold", () => {
    const turn = {
      ...base,
      actions: [{ kind: "OFFER_CANCEL_REFUND" as const, refundPct: 50 }],
    };
    const d = decideEscalation(
      ctx({ paymentAmountPaise: 400_00 }),
      turn,
      "yes",
      { highValueRefundPaise: 500_00 },
    );
    expect(d.escalate).toBe(false);
  });
});
