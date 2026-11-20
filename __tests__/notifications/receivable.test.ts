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
import { NOVU_WORKFLOW_TEMPLATES } from "@/lib/novu/templates";
import { NOVU_WORKFLOWS } from "@/lib/novu/workflows";
import {
  alwaysSentNotices,
  receivableSwitches,
  showsQuietHours,
} from "@/lib/notifications/receivable";
import {
  REQUIRED_NOTICE_KINDS,
  REQUIRED_NOTICE_LABEL,
  REQUIRED_WORKFLOW_NOTICES,
} from "@/lib/notifications/required-notices";

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

describe("alwaysSentNotices", () => {
  const text = (viewer: Parameters<typeof alwaysSentNotices>[0]) =>
    alwaysSentNotices(viewer).join("\n");

  it("names exactly the workflows the bell gate forces", () => {
    const forced = NOVU_WORKFLOW_TEMPLATES.filter((t) => t.required).map(
      (t) => t.workflowId,
    );
    expect(Object.keys(REQUIRED_WORKFLOW_NOTICES).sort()).toEqual(
      [...forced].sort(),
    );
  });

  it("a learner sees no expert, reviewer or co-hosting notices", () => {
    const list = text({ role: "CONSULTEE", hasOrgMembership: false });
    expect(list).toContain("Account and security notices");
    expect(list).toContain("moderation decisions");
    expect(list).toContain("Changes someone else makes to your booking:");
    expect(list).toContain(REQUIRED_NOTICE_LABEL.COHOST_CHANGED);
    for (const absent of [
      "verification",
      "expert applications",
      "compliance",
      "co-hosting",
    ]) {
      expect(list).not.toContain(absent);
    }
  });

  it("an expert sees verification and every booking and co-hosting kind once", () => {
    const list = text({ role: "CONSULTANT", hasOrgMembership: false });
    expect(list).toContain("profile verification updates");
    expect(list).toContain("your booking or your co-hosting");
    for (const kind of REQUIRED_NOTICE_KINDS) {
      expect(list.split(REQUIRED_NOTICE_LABEL[kind])).toHaveLength(2);
    }
    expect(list).not.toContain("compliance");
  });

  it("staff see expert applications; admins also see compliance alerts", () => {
    const staff = text({ role: "STAFF", hasOrgMembership: false });
    expect(staff).toContain("new expert applications");
    expect(staff).not.toContain("compliance");
    expect(text({ role: "ADMIN", hasOrgMembership: false })).toContain(
      "new expert applications and compliance deadline alerts",
    );
  });

  it("a workspace operator, who books nothing, has no booking line", () => {
    const list = alwaysSentNotices({
      role: "ORG_WORKSPACE",
      hasOrgMembership: true,
    });
    expect(list).toEqual([
      "Account and security notices and moderation decisions",
      "Payment receipts and invitations you must answer, by email",
    ]);
  });
});
