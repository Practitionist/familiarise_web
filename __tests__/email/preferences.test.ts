/**
 * @jest-environment node
 */

/**
 * #1653 — the email preference gate. Pins that a missing row means defaults,
 * that the channel switch and the category switch each gate on their own,
 * that a required notice ignores both and carries no unsubscribe link, and
 * that a recipient without a saved zone renders in the platform's zone.
 */

const mockFindMany = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findMany: (...args: unknown[]) => mockFindMany(...args) },
  },
}));

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

import { loadEmailRecipients } from "@/lib/email/preferences";

type Pref = Partial<{
  allNotifications: boolean;
  emailEnabled: boolean;
  appointmentReminders: boolean;
  paymentNotifications: boolean;
}>;

function user(pref: Pref | null, timezone: string | null = "Europe/Berlin") {
  return {
    id: "user_1",
    email: "one@example.com",
    name: "One",
    timezone,
    notificationPreferences:
      pref === null
        ? null
        : {
            allNotifications: true,
            emailEnabled: true,
            appointmentReminders: true,
            paymentNotifications: true,
            subscriptionAlerts: true,
            trialNotifications: true,
            supportUpdates: true,
            feedbackAlerts: true,
            orgBillingAlerts: true,
            orgMembershipAlerts: true,
            orgProgramAlerts: true,
            ...pref,
          },
  };
}

beforeEach(() => jest.clearAllMocks());

describe("loadEmailRecipients", () => {
  it("allows a user with no preference row and signs an unsubscribe link", async () => {
    mockFindMany.mockResolvedValue([user(null)]);
    const [r] = await loadEmailRecipients(["user_1"], "appointments");
    expect(r.allowed).toBe(true);
    expect(r.unsubscribeUrl).toMatch(
      /\/api\/notifications\/unsubscribe\?u=user_1&t=[0-9a-f]{64}$/,
    );
    expect(r.zone).toBe("Europe/Berlin");
  });

  it("blocks every category once email is turned off", async () => {
    mockFindMany.mockResolvedValue([user({ emailEnabled: false })]);
    const [r] = await loadEmailRecipients(["user_1"], "payments");
    expect(r.allowed).toBe(false);
  });

  it("gates on the category's own column only", async () => {
    mockFindMany.mockResolvedValue([user({ appointmentReminders: false })]);
    const [blocked] = await loadEmailRecipients(["user_1"], "appointments");
    const [allowed] = await loadEmailRecipients(["user_1"], "payments");
    expect(blocked.allowed).toBe(false);
    expect(allowed.allowed).toBe(true);
  });

  it("treats a null category as a required notice: always allowed, no unsubscribe link", async () => {
    mockFindMany.mockResolvedValue([user({ emailEnabled: false })]);
    const [r] = await loadEmailRecipients(["user_1"], null);
    expect(r.allowed).toBe(true);
    expect(r.unsubscribeUrl).toBeNull();
  });

  it("falls back to Asia/Kolkata when the user has no timezone", async () => {
    mockFindMany.mockResolvedValue([user(null, null)]);
    const [r] = await loadEmailRecipients(["user_1", "user_1"], "support");
    expect(r.zone).toBe("Asia/Kolkata");
    expect(mockFindMany).toHaveBeenCalledTimes(1);
    expect(mockFindMany.mock.calls[0][0].where.id.in).toEqual(["user_1"]);
  });
});
