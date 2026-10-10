/**
 * @jest-environment node
 */

const mockSyncSubscriber = jest.fn();
const mockUserFindUnique = jest.fn();
const mockScheduled: Promise<void>[] = [];

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    cookiePreference: { upsert: jest.fn(async () => ({})) },
    notificationPreference: { upsert: jest.fn(async () => ({})) },
    consentArtifact: { create: jest.fn(async () => ({})) },
    user: { findUnique: (...args: unknown[]) => mockUserFindUnique(...args) },
  },
}));
jest.mock("../../lib/email", () => ({ sendWelcomeEmail: jest.fn() }));
jest.mock("../../lib/api/after-safe", () => ({
  scheduleAfter: (fn: () => Promise<void>) => mockScheduled.push(fn()),
}));
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
  mockScheduled.length = 0;
  mockSyncSubscriber.mockReset();
  mockSyncSubscriber.mockResolvedValue(undefined);
  mockUserFindUnique.mockReset();
  mockUserFindUnique.mockResolvedValue({ id: "u1" });
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
      await Promise.all(mockScheduled);
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

  it("skips an SSO user the callback discarded before the deferred welcome", async () => {
    mockUserFindUnique.mockResolvedValue(null);
    await provisionNewUser(
      { ...user, emailVerified: true },
      "/sso/callback/:providerId",
    );
    await Promise.all(mockScheduled);
    expect(mockSyncSubscriber).not.toHaveBeenCalled();
  });

  it("syncs once the address is verified by code", async () => {
    await welcomeVerifiedUser(user, { stampConsent: true });
    await Promise.all(mockScheduled);
    expect(mockSyncSubscriber).toHaveBeenCalledTimes(1);
  });
});
