/**
 * @jest-environment node
 */

/**
 * #support-hub — the platform flow registry + the shared reason→priority map.
 * Pure registry logic: availability gates (operator-only flows), the
 * reason→issueType taxonomy mapping, and priority policy. No DB.
 */

import {
  platformFlowsForContext,
  platformFlowForId,
  issueTypeForFlow,
  platformOwnershipScope,
  type PlatformSupportContext,
} from "@/lib/support/platform-flows";
import { walkFlow } from "@/lib/support/flow-walk";
import { priorityForReason } from "@/lib/support/priority";

function ctx(
  overrides: Partial<PlatformSupportContext> = {},
): PlatformSupportContext {
  return {
    userId: "u1",
    isOperator: false,
    isExpert: false,
    organizationIds: [],
    billingOrgIds: [],
    ...overrides,
  };
}

describe("platform flow availability", () => {
  it("hides the operator billing flow from non-operators", () => {
    const ids = platformFlowsForContext(ctx()).map((f) => f.id);
    expect(ids).not.toContain("ORG_OPERATOR_BILLING");
    expect(ids).toContain("PAYMENTS_BILLING");
    expect(ids).toContain("ACCOUNT_ACCESS");
    expect(ids).toContain("GENERAL");
  });

  it("offers the operator billing flow to operators", () => {
    const ids = platformFlowsForContext(ctx({ isOperator: true })).map(
      (f) => f.id,
    );
    expect(ids).toContain("ORG_OPERATOR_BILLING");
  });

  it("looks up a flow only when its gate passes", () => {
    expect(platformFlowForId(ctx(), "GENERAL")).toBeDefined();
    expect(platformFlowForId(ctx(), "ORG_OPERATOR_BILLING")).toBeUndefined();
    expect(
      platformFlowForId(ctx({ isOperator: true }), "ORG_OPERATOR_BILLING"),
    ).toBeDefined();
  });

  it("offers the expert tax flow only to experts", () => {
    expect(platformFlowForId(ctx(), "EXPERT_TAX")).toBeUndefined();
    expect(
      platformFlowForId(ctx({ isOperator: true }), "EXPERT_TAX"),
    ).toBeUndefined();
    expect(
      platformFlowForId(ctx({ isExpert: true }), "EXPERT_TAX"),
    ).toBeDefined();
  });
});

const walk = (
  flow: Parameters<typeof walkFlow>[0],
  nodeId: string | null,
  chosenOptionId?: string,
) =>
  walkFlow(flow, nodeId, { chosenOptionId }, { refundPctIfCancelledNow: null });

describe("tax routes", () => {
  it("keeps invoice download self-serve and escalates a wrong GST invoice as TAX_GST", () => {
    const payments = platformFlowForId(ctx(), "PAYMENTS_BILLING")!;
    const download = walk(payments, "invoice", "download");
    expect(download.resolved).toBe(true);
    expect(download.escalate).toBe(false);
    expect(download.actions).toEqual([{ kind: "SHOW_INVOICES" }]);

    const wrong = walk(payments, "invoice", "gstwrong");
    expect(wrong.escalate).toBe(true);
    expect(wrong.reason).toBe("gst_invoice_wrong");
    expect(issueTypeForFlow(payments, wrong.reason)).toBe("TAX_GST");
  });

  it.each([
    ["tds", "missing", "tds_certificate", "TDS_CERTIFICATE"],
    ["pan", "stuck", "pan_mismatch", "PAN_CARD_MISMATCH"],
  ])(
    "points an expert to self-serve before escalating %s as %s",
    (branch, giveUp, reason, issueType) => {
      const tax = platformFlowForId(ctx({ isExpert: true }), "EXPERT_TAX")!;
      const pointer = walk(tax, "start", branch);
      expect(pointer.escalate).toBe(false);
      expect(pointer.nextNodeId).toBe(branch);

      const escalated = walk(tax, branch, giveUp);
      expect(escalated.escalate).toBe(true);
      expect(escalated.reason).toBe(reason);
      expect(issueTypeForFlow(tax, escalated.reason)).toBe(issueType);
    },
  );

  it("names the real Earnings and Get paid locations in the expert pointers", () => {
    const tax = platformFlowForId(ctx({ isExpert: true }), "EXPERT_TAX")!;
    const tds = tax.nodes.tds;
    const pan = tax.nodes.pan;
    expect(tds.body).toContain("Earnings & payouts");
    expect(tds.body).toContain("Tax & TDS");
    expect(pan.body).toContain("Settings → Get paid → Tax details");
  });
});

describe("operator billing invoice route", () => {
  const operator = () =>
    platformFlowForId(ctx({ isOperator: true }), "ORG_OPERATOR_BILLING")!;

  it("no longer dead-ends on the read-only disputes panel", () => {
    for (const node of Object.values(operator().nodes)) {
      expect(node.body).not.toMatch(/Billing → Disputes/);
    }
  });

  it("escalates a disputed charge and a wrong GST invoice to the billing queue", () => {
    const dispute = walk(operator(), "invoice", "dispute");
    expect(dispute.escalate).toBe(true);
    expect(issueTypeForFlow(operator(), dispute.reason)).toBe(
      "BILLING_QUESTION",
    );
    const gst = walk(operator(), "invoice", "gstwrong");
    expect(gst.escalate).toBe(true);
    expect(issueTypeForFlow(operator(), gst.reason)).toBe("TAX_GST");
    const download = walk(operator(), "invoice", "download");
    expect(download.resolved).toBe(true);
  });
});

describe("platformOwnershipScope", () => {
  it("files operator billing into ORG_BILLING for a billing correspondent of the attributed org", () => {
    expect(
      platformOwnershipScope({
        flowId: "ORG_OPERATOR_BILLING",
        organizationId: "org-a",
        billingOrgIds: ["org-a"],
      }),
    ).toBe("ORG_BILLING");
  });

  it.each([
    ["a filer without the billing grant", "ORG_OPERATOR_BILLING", "org-a", []],
    ["a grant on a different org", "ORG_OPERATOR_BILLING", "org-a", ["org-b"]],
    ["no attributed org", "ORG_OPERATOR_BILLING", null, ["org-a"]],
    ["a B2C flow", "PAYMENTS_BILLING", "org-a", ["org-a"]],
  ])(
    "keeps PERSONAL for %s",
    (_label, flowId, organizationId, billingOrgIds) => {
      expect(
        platformOwnershipScope({ flowId, organizationId, billingOrgIds }),
      ).toBe("PERSONAL");
    },
  );
});

describe("escalation taxonomy", () => {
  it("maps per-reason issue types over the flow default", () => {
    const payments = platformFlowForId(ctx(), "PAYMENTS_BILLING")!;
    expect(issueTypeForFlow(payments, "double_charge")).toBe("CHARGED_TWICE");
    expect(issueTypeForFlow(payments, "refund_missing")).toBe("REFUND_REQUEST");
    expect(issueTypeForFlow(payments, undefined)).toBe("BILLING_QUESTION");
    // An unknown reason falls back to the default, never throws.
    expect(issueTypeForFlow(payments, "something_new")).toBe(
      "BILLING_QUESTION",
    );
  });
});

describe("priorityForReason", () => {
  it("burns HIGH for money-integrity and no-show reasons", () => {
    expect(priorityForReason("provider_no_show")).toBe("HIGH");
    expect(priorityForReason("double_charge")).toBe("HIGH");
    expect(priorityForReason("high_value_refund")).toBe("HIGH");
  });

  it("defaults everything else to MEDIUM", () => {
    expect(priorityForReason("quality_poor")).toBe("MEDIUM");
    expect(priorityForReason("recording_missing")).toBe("MEDIUM");
    expect(priorityForReason(undefined)).toBe("MEDIUM");
  });
});
