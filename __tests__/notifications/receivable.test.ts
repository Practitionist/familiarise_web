/**
 * @jest-environment node
 */

/**
 * The settings page shows only the switches a viewer's role can receive, and
 * its routing message matches what the bell and email gates actually block.
 */

const mockFindMany = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findMany: (...args: unknown[]) => mockFindMany(...args) },
  },
}));

import type { NotificationRoutingMode } from "@prisma/client";
import {
  EMAIL_CATEGORY_COLUMN,
  isEmailAllowedForUser,
} from "@/lib/email/preferences";
import { resolveRecipientBellPolicy } from "@/lib/novu/policy";
import { NOVU_WORKFLOWS } from "@/lib/novu/workflows";
import {
  receivableSwitches,
  routingBlocks,
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

describe("routingBlocks matches the server gates", () => {
  const MODES: NotificationRoutingMode[] = [
    "BELL_AND_EMAIL",
    "BELL_ONLY",
    "EMAIL_ONLY",
    "NEITHER",
  ];

  it.each(MODES)("%s", async (mode) => {
    const orgWorkspaceProfile = { notificationRoutingMode: mode };
    mockFindMany.mockResolvedValue([
      {
        id: "u1",
        erasedAt: null,
        orgWorkspaceProfile,
        notificationPreferences: null,
      },
    ]);
    const { allowedRecipients } = await resolveRecipientBellPolicy(
      NOVU_WORKFLOWS.APPOINTMENT_BOOKED,
      ["u1"],
    );
    expect(mockFindMany).toHaveBeenCalled();
    const emailAllowed = isEmailAllowedForUser(
      { orgWorkspaceProfile, notificationPreferences: null },
      "appointments",
    );

    expect(routingBlocks(mode)).toEqual({
      inApp: allowedRecipients.length === 0,
      email: !emailAllowed,
    });
  });
});
