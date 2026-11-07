/**
 * @jest-environment node
 */

/**
 * The settings page shows only the switches a viewer's role can receive, and
 * those switches are the only channel control, workspace operators included.
 */

const mockFindMany = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findMany: (...args: unknown[]) => mockFindMany(...args) },
  },
}));

import { EMAIL_CATEGORY_COLUMN, isEmailAllowed } from "@/lib/email/preferences";
import { resolveRecipientBellPolicy } from "@/lib/novu/policy";
import { NOVU_WORKFLOWS } from "@/lib/novu/workflows";
import {
  receivableSwitches,
  showsQuietHours,
} from "@/lib/notifications/receivable";

const PERSONAL = [
  "appointmentReminders",
  "paymentNotifications",
  "subscriptionAlerts",
  "trialNotifications",
  "supportUpdates",
  "feedbackAlerts",
];
const ORG = ["orgBillingAlerts", "orgMembershipAlerts", "orgProgramAlerts"];

const sorted = (set: ReadonlySet<string>) => [...set].sort();

describe("receivableSwitches", () => {
  it.each([
    ["CONSULTEE", false, PERSONAL],
    ["CONSULTANT", false, PERSONAL],
    ["CONSULTEE", true, [...PERSONAL, ...ORG]],
    ["ORG_WORKSPACE", false, ["supportUpdates", "feedbackAlerts", ...ORG]],
    ["STAFF", false, Object.values(EMAIL_CATEGORY_COLUMN)],
    ["ADMIN", false, Object.values(EMAIL_CATEGORY_COLUMN)],
    [undefined, false, PERSONAL],
  ])("%s (member: %s)", (role, hasOrgMembership, expected) => {
    expect(sorted(receivableSwitches({ role, hasOrgMembership }))).toEqual(
      [...expected].sort(),
    );
  });

  it("quiet hours are for consultant profiles only", () => {
    expect(
      showsQuietHours({ role: "CONSULTANT", hasOrgMembership: false }),
    ).toBe(true);
    expect(
      showsQuietHours({
        role: "CONSULTEE",
        consultantProfileId: "cp1",
        hasOrgMembership: false,
      }),
    ).toBe(true);
    expect(
      showsQuietHours({ role: "CONSULTEE", hasOrgMembership: false }),
    ).toBe(false);
    expect(showsQuietHours({ role: "ADMIN", hasOrgMembership: true })).toBe(
      false,
    );
  });
});

describe("a workspace operator's channels are only their personal switches", () => {
  it.each([
    [true, false],
    [false, true],
  ])("in-app %s, email %s", async (inAppEnabled, emailEnabled) => {
    mockFindMany.mockResolvedValue([
      {
        id: "op1",
        email: "op@example.test",
        name: null,
        timezone: null,
        erasedAt: null,
        notificationPreferences: {
          allNotifications: true,
          inAppEnabled,
          emailEnabled,
        },
      },
    ]);

    const { allowedRecipients } = await resolveRecipientBellPolicy(
      NOVU_WORKFLOWS.ORG_INVOICE_ISSUED,
      ["op1"],
    );
    expect(allowedRecipients).toEqual(inAppEnabled ? ["op1"] : []);
    expect(await isEmailAllowed("op1", "orgBilling")).toBe(emailEnabled);
    for (const [args] of mockFindMany.mock.calls) {
      expect(args.select).not.toHaveProperty("orgWorkspaceProfile");
    }
  });
});
