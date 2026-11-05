/** @jest-environment node */
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));
import { emailPolicyRefusal } from "@/lib/email/delivery-policy";

const policy = { userId: "user", category: "appointments" };
function recipient() {
  return {
    email: "reader@example.com",
    erasedAt: null,
    orgWorkspaceProfile: { notificationRoutingMode: "BELL_AND_EMAIL" },
    notificationPreferences: {
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
    },
  };
}
const findUnique = jest.fn();
const db = { user: { findUnique } };
beforeEach(() => {
  findUnique.mockReset().mockResolvedValue(recipient());
});

it.each([null, undefined])(
  "keeps direct-address and older rows without policy context (%s)",
  async (context) => {
    expect(
      await emailPolicyRefusal(context, "reader@example.com", db),
    ).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  },
);

it.each([
  { userId: "user", category: "unknown" },
  { userId: "", category: "appointments" },
  { category: "appointments" },
  { ...policy, unexpected: true },
])(
  "rejects invalid persisted context without querying the account",
  async (context) => {
    expect(await emailPolicyRefusal(context, "reader@example.com", db)).toBe(
      "invalid_policy",
    );
    expect(findUnique).not.toHaveBeenCalled();
  },
);

it.each(["allNotifications", "emailEnabled", "appointmentReminders"] as const)(
  "honours %s being disabled while queued",
  async (key) => {
    const user = recipient();
    user.notificationPreferences[key] = false;
    findUnique.mockResolvedValue(user);
    expect(await emailPolicyRefusal(policy, "reader@example.com", db)).toBe(
      "preference_changed",
    );
  },
);

it.each(["BELL_ONLY", "NEITHER"])(
  "honours workspace %s while queued",
  async (notificationRoutingMode) => {
    findUnique.mockResolvedValue({
      ...recipient(),
      orgWorkspaceProfile: { notificationRoutingMode },
    });
    expect(await emailPolicyRefusal(policy, "reader@example.com", db)).toBe(
      "preference_changed",
    );
  },
);

it("preserves required notices despite optional switches and routing", async () => {
  const user = recipient();
  user.notificationPreferences.allNotifications = false;
  findUnique.mockResolvedValue({
    ...user,
    orgWorkspaceProfile: { notificationRoutingMode: "NEITHER" },
  });
  expect(
    await emailPolicyRefusal(
      { ...policy, category: null },
      "reader@example.com",
      db,
    ),
  ).toBeNull();
});

it("allows defaults when the recipient has no preference row", async () => {
  findUnique.mockResolvedValue({
    ...recipient(),
    notificationPreferences: null,
  });
  expect(
    await emailPolicyRefusal(policy, " Reader@Example.com ", db),
  ).toBeNull();
});

it.each([
  [null, "recipient_missing"],
  [{ ...recipient(), erasedAt: new Date() }, "recipient_erased"],
  [{ ...recipient(), email: "new@example.com" }, "recipient_changed"],
  [{ ...recipient(), email: null }, "recipient_changed"],
])(
  "never sends stale account content to an invalid recipient",
  async (user, reason) => {
    findUnique.mockResolvedValue(user);
    expect(
      await emailPolicyRefusal(
        { ...policy, category: null },
        "reader@example.com",
        db,
      ),
    ).toBe(reason);
  },
);

it("propagates read failures so durable work can be retried instead of authorizing a send", async () => {
  findUnique.mockRejectedValue(new Error("pool unavailable"));
  await expect(
    emailPolicyRefusal(policy, "reader@example.com", db),
  ).rejects.toThrow("pool unavailable");
});
