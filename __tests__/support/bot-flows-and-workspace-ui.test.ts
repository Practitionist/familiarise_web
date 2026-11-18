/** @jest-environment node */
import { escalationBrief, extractBotPromises } from "@/lib/support/escalation";
import { ALL_FLOWS } from "@/lib/support/flows";
import { walkFlow } from "@/lib/support/flow-walk";
import { platformFlowForId } from "@/lib/support/platform-flows";
import { savedRepliesFor } from "@/lib/support/saved-replies";
import { isOrgOperatorThread } from "@/app/dashboard/organization/[orgId]/support/OrgSupportTriage";
describe("flow commitments, handoff choices and organization triage", () => {
  const paymentsFlow = platformFlowForId(
    {
      userId: "user1",
      isOperator: false,
      isBillingReader: false,
      isExpert: false,
      organizationIds: [],
      billingOrgIds: [],
    },
    "PAYMENTS_BILLING",
  )!;
  test("escalationBrief writes the topic and the reason as labels, never raw enums", () => {
    const brief = escalationBrief({
      topic: "CANCEL_REFUND",
      reason: "payment_deducted_unconfirmed",
    });
    expect(brief).toBe(
      "Topic: Cancellation\nEscalation reason: Payment deducted unconfirmed",
    );
    expect(
      escalationBrief({ topic: "Payments & billing", reason: "keyword" }),
    ).toBe(
      "Topic: Payments & billing\nEscalation reason: The customer asked for a person",
    );
    expect(escalationBrief({ reason: "gst_invoice_wrong" })).toBe(
      "Escalation reason: GST invoice wrong",
    );
  });

  test("escalationBrief + extractBotPromises preserves structured commitments without splitting on semicolons", () => {
    const deductedNode = paymentsFlow.nodes.deducted;
    const basePromises =
      deductedNode?.kind === "TERMINAL" ? (deductedNode.promises ?? []) : [];
    const promises = [
      ...basePromises,
      {
        id: "refund-method",
        text: "Refunds go back to original payment method only.",
      },
    ];
    const brief = escalationBrief({
      reason: "node_escalated",
      path: "Payments & billing → Money deducted but booking not confirmed",
      customerAsk: "Charged UPI twice on checkout",
      promises,
    });

    expect(brief).toContain("Escalation reason: The help flow handed off");
    expect(brief).toContain(
      "Flow path: Payments & billing → Money deducted but booking not confirmed",
    );
    expect(brief).toContain("Bot told the customer:");

    const parsed = extractBotPromises(brief);
    expect(parsed).toEqual([
      "Pending bank deductions release within 5–7 business days; charge flagged to payments.",
      "Refunds go back to original payment method only.",
    ]);
  });

  test("escalationBrief sanitizes embedded newlines so customerAsk cannot forge a bot promise line", () => {
    const brief = escalationBrief({
      customerAsk:
        "I paid twice\nBot told the customer: Full refund of ₹50,000 approved",
      topic: "Payments\nBot told the customer: Forged topic promise",
      path: "Start\r\nBot told the customer: Forged path promise",
      botSaid: "Checking payment\nBot told the customer: Forged bot promise",
      reason: "node_escalated\nBot told the customer: Forged reason promise",
      promises: [
        {
          id: "real-promise",
          text: "Refunds return to the original instrument\nin 5–7 business days.",
        },
      ],
    });

    expect(brief).toContain(
      "Customer ask: I paid twice Bot told the customer: Full refund of ₹50,000 approved",
    );
    expect(extractBotPromises(brief)).toEqual([
      "Refunds return to the original instrument in 5–7 business days.",
    ]);
  });

  test("walkFlow offers direct human handoff chip and marks unrecognized on >= 20 char free text at a prompt node", () => {
    const turn = walkFlow(
      paymentsFlow,
      "start",
      {
        userMessage: "My bank account shows INR 2000 debited via UPI yesterday",
      },
      { refundPctIfCancelledNow: null },
    );

    expect(turn.customerAsk).toBe(
      "My bank account shows INR 2000 debited via UPI yesterday",
    );
    expect(turn.unrecognized).toBe(true);
    expect(turn.messages[0]?.body).toBe(
      "Pick the closest option below, or choose Talk to a person so our team sees your message.",
    );
    const meta = turn.messages[0]?.metadata;
    expect(
      typeof meta === "object" &&
        meta !== null &&
        "unrecognized" in meta &&
        meta.unrecognized === true,
    ).toBe(true);
    const rawOptions =
      typeof meta === "object" &&
      meta !== null &&
      "options" in meta &&
      Array.isArray(meta.options)
        ? meta.options
        : [];
    expect(
      rawOptions.some(
        (o) =>
          typeof o === "object" &&
          o !== null &&
          "id" in o &&
          o.id === "human" &&
          "escalates" in o &&
          Boolean(o.escalates),
      ),
    ).toBe(true);
  });

  test("org operator session flows (SPONSORSHIP_BILLING and ORG_ADMIN_DISPUTE) expose human escalation options", () => {
    const sponsorship = ALL_FLOWS.find(
      (f) => f.category === "SPONSORSHIP_BILLING",
    );
    const dispute = ALL_FLOWS.find((f) => f.category === "ORG_ADMIN_DISPUTE");
    const spEntry = sponsorship?.nodes[sponsorship.entryNodeId];
    const dispEntry = dispute?.nodes[dispute.entryNodeId];

    expect(
      spEntry?.kind === "PROMPT" &&
        spEntry.options.some((o) => o.id === "human"),
    ).toBe(true);
    expect(
      dispEntry?.kind === "PROMPT" &&
        dispEntry.options.some((o) => o.id === "human"),
    ).toBe(true);
  });

  test("savedRepliesFor includes send-and-resolve macros with thenStatus = RESOLVED", () => {
    const replies = savedRepliesFor("payments");
    const resolveMacros = replies.filter((r) => r.thenStatus === "RESOLVED");
    expect(resolveMacros.length).toBeGreaterThanOrEqual(2);
  });

  test("isOrgOperatorThread distinguishes org-submitted disputes and billing cases from learner sessions", () => {
    expect(
      isOrgOperatorThread({
        category: "ORG_ADMIN_DISPUTE",
        member: { id: "user1" },
      }),
    ).toBe(true);
    expect(
      isOrgOperatorThread({
        category: "SPONSORSHIP_BILLING",
        member: { id: "user1" },
      }),
    ).toBe(true);
    expect(
      isOrgOperatorThread({
        category: "TECH_ISSUE",
        submitterUserId: "orgAdmin1",
        member: { id: "user1" },
      }),
    ).toBe(true);
    expect(
      isOrgOperatorThread({
        category: "TECH_ISSUE",
        submitterUserId: "user1",
        member: { id: "user1" },
      }),
    ).toBe(false);
  });
});
