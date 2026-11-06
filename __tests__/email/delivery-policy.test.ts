/** @jest-environment node */
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));
import {
  deliveryColumns,
  deliveryPolicyOf,
  emailPolicyRefusal,
  type EmailDeliveryPolicy,
} from "@/lib/email/delivery-policy";

const policy: EmailDeliveryPolicy = {
  userId: "user",
  category: "appointments",
};
function recipient() {
  return {
    email: "reader@example.com",
    erasedAt: null as Date | null,
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

it("round-trips the policy through the typed columns", () => {
  expect(deliveryColumns(policy)).toEqual({
    deliveryUserId: "user",
    deliveryCategory: "appointments",
  });
  expect(deliveryColumns(undefined)).toEqual({
    deliveryUserId: null,
    deliveryCategory: null,
  });
  expect(deliveryPolicyOf(deliveryColumns(policy))).toEqual(policy);
  expect(
    deliveryPolicyOf({ deliveryUserId: "user", deliveryCategory: null }),
  ).toEqual({ userId: "user", category: null });
  expect(
    deliveryPolicyOf({ deliveryUserId: null, deliveryCategory: null }),
  ).toBeNull();
});

it("keeps direct-address mail free of account policy but refuses an erased marker", async () => {
  expect(await emailPolicyRefusal(null, "reader@example.com", db)).toBeNull();
  expect(await emailPolicyRefusal(null, "erased:0123456789abcdef", db)).toBe(
    "recipient_erased",
  );
  expect(findUnique).not.toHaveBeenCalled();
});

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

it("sends a required notice despite optional switches", async () => {
  const user = recipient();
  user.notificationPreferences.allNotifications = false;
  findUnique.mockResolvedValue(user);
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
  "never sends account content to an invalid recipient (%#)",
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

it("propagates read failures so the caller leaves the row pending", async () => {
  findUnique.mockRejectedValue(new Error("pool unavailable"));
  await expect(
    emailPolicyRefusal(policy, "reader@example.com", db),
  ).rejects.toThrow("pool unavailable");
});
