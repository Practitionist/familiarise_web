/**
 * Mandatory notices ring whatever the recipient's bell switches say, like a
 * required email; optional ones (an announcement included) honour them.
 */
const mockFindMany = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findMany: (...args: unknown[]) => mockFindMany(...args) },
  },
}));

import { resolveRecipientBellPolicy } from "@/lib/novu/policy";
import { NOVU_WORKFLOW_TEMPLATES } from "@/lib/novu/templates";
import { NOVU_WORKFLOWS } from "@/lib/novu/workflows";

const MUTED = {
  allNotifications: false,
  inAppEnabled: false,
  appointmentReminders: false,
  paymentNotifications: false,
  subscriptionAlerts: false,
  trialNotifications: false,
  supportUpdates: false,
  feedbackAlerts: false,
  orgBillingAlerts: false,
  orgMembershipAlerts: false,
  orgProgramAlerts: false,
};

describe("required bells", () => {
  it("only ever marks a notice with no preference category as required", () => {
    const required = NOVU_WORKFLOW_TEMPLATES.filter((t) => t.required);
    expect(required.length).toBeGreaterThan(0);
    for (const t of required) expect(t.category).toBeNull();
    expect(
      NOVU_WORKFLOW_TEMPLATES.find(
        (t) => t.workflowId === NOVU_WORKFLOWS.GENERAL_ANNOUNCEMENT,
      )?.required,
    ).toBeUndefined();
  });

  it("rings a security notice for a user who muted every bell", async () => {
    mockFindMany.mockResolvedValue([
      { id: "muted", erasedAt: null, notificationPreferences: MUTED },
      { id: "erased", erasedAt: new Date(), notificationPreferences: null },
    ]);

    const { allowedRecipients } = await resolveRecipientBellPolicy(
      NOVU_WORKFLOWS.ACCOUNT_SECURITY_NOTICE,
      ["muted", "erased"],
    );

    expect(allowedRecipients).toEqual(["muted"]);
  });

  it("keeps an announcement behind the switches", async () => {
    mockFindMany.mockResolvedValue([
      { id: "muted", erasedAt: null, notificationPreferences: MUTED },
    ]);

    const { allowedRecipients } = await resolveRecipientBellPolicy(
      NOVU_WORKFLOWS.GENERAL_ANNOUNCEMENT,
      ["muted"],
    );

    expect(allowedRecipients).toEqual([]);
  });
});
