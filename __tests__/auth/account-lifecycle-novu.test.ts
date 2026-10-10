/**
 * @jest-environment node
 */

const mockSyncSubscriber = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    cookiePreference: { upsert: jest.fn(async () => ({})) },
    notificationPreference: { upsert: jest.fn(async () => ({})) },
    consentArtifact: { create: jest.fn(async () => ({})) },
  },
}));
jest.mock("../../lib/email", () => ({ sendWelcomeEmail: jest.fn() }));
jest.mock("../../lib/api/after-safe", () => ({ scheduleAfter: jest.fn() }));
jest.mock("../../lib/compliance/dpdp", () => ({
  buildSignupConsentArtifacts: () => [],
}));
jest.mock("../../lib/rate-limit", () => ({
  existingAccountNoticeLimiter: { limit: jest.fn() },
}));
jest.mock("../../lib/novu/subscriber", () => ({
  syncSubscriber: (...args: unknown[]) => mockSyncSubscriber(...args),
}));

import {
  provisionNewUser,
  welcomeVerifiedUser,
} from "../../lib/auth/account-lifecycle";

const user = { id: "u1", email: "asha@example.com", name: "Asha Rao" };

beforeEach(() => {
  mockSyncSubscriber.mockReset();
  mockSyncSubscriber.mockResolvedValue(undefined);
});

describe("Novu subscriber sync only for verified users", () => {
  it("skips a never-verified credential sign-up", async () => {
    await provisionNewUser({ ...user, emailVerified: false }, "/sign-up/email");
    expect(mockSyncSubscriber).not.toHaveBeenCalled();
  });

  it.each(["/callback/:id", "/sso/callback/:providerId", "/admin/create-user"])(
    "syncs a user created verified via %s",
    async (path) => {
      await provisionNewUser({ ...user, emailVerified: true }, path);
      expect(mockSyncSubscriber).toHaveBeenCalledTimes(1);
      expect(mockSyncSubscriber).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "u1",
          email: "asha@example.com",
          firstName: "Asha",
          lastName: "Rao",
        }),
      );
    },
  );

  it("syncs once the address is verified by code", async () => {
    await welcomeVerifiedUser(user, { stampConsent: true });
    expect(mockSyncSubscriber).toHaveBeenCalledTimes(1);
  });
});
