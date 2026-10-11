/**
 * @jest-environment node
 */

const mockVerificationDeleteMany = jest.fn();
const mockUserUpdateMany = jest.fn();
const mockConsentCreate = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    verification: {
      deleteMany: (...args: unknown[]) => mockVerificationDeleteMany(...args),
    },
    user: { updateMany: (...args: unknown[]) => mockUserUpdateMany(...args) },
    consentArtifact: {
      create: (...args: unknown[]) => mockConsentCreate(...args),
    },
  },
}));
jest.mock("../../lib/email", () => ({
  sendWelcomeEmail: jest.fn(),
  sendPasswordChangedEmail: jest.fn(),
}));
jest.mock("../../lib/api/after-safe", () => ({ scheduleAfter: jest.fn() }));
jest.mock("../../lib/compliance/dpdp", () => ({
  buildSignupConsentArtifacts: () => [{ purpose: "signup" }],
}));
jest.mock("../../lib/rate-limit", () => ({
  existingAccountNoticeLimiter: { limit: jest.fn() },
}));
jest.mock("../../lib/novu/subscriber", () => ({
  syncSubscriber: jest.fn(async () => undefined),
}));

import {
  emailOtpVerificationIdentifiers,
  onPasswordChanged,
} from "../../lib/auth/account-lifecycle";

const user = { id: "u1", email: "Asha@Example.com", name: "Asha Rao" };

beforeEach(() => {
  jest.clearAllMocks();
  mockVerificationDeleteMany.mockResolvedValue({ count: 0 });
  mockUserUpdateMany.mockResolvedValue({ count: 1 });
});

describe("emailOtpVerificationIdentifiers", () => {
  it("matches BetterAuth's hashed `${type}-otp-${email}` identifiers", () => {
    // Values produced by better-auth's processIdentifier(id, "hashed").
    expect(emailOtpVerificationIdentifiers("asha@example.com")).toEqual([
      "PUG0EyXSkZE7SnuTIhmivUuHBK490QaF9jjLxv0baEE",
      "fqDnG0KPztC6RCPatBhzelUy4vrOYgH-RVp9gRHZWkg",
    ]);
    expect(emailOtpVerificationIdentifiers(user.email)).toEqual(
      emailOtpVerificationIdentifiers("asha@example.com"),
    );
  });
});

describe("onPasswordChanged", () => {
  it("deletes user-bound tokens and the user's emailed codes", async () => {
    await onPasswordChanged(user, {
      viaReset: false,
      notify: false,
      welcomeIfVerified: false,
    });
    expect(mockVerificationDeleteMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { value: "u1" },
          {
            identifier: {
              in: emailOtpVerificationIdentifiers("asha@example.com"),
            },
          },
        ],
      },
    });
    expect(mockUserUpdateMany).not.toHaveBeenCalled();
  });

  it("verifies and welcomes on reset without stamping sign-up consent", async () => {
    await onPasswordChanged(user, {
      viaReset: true,
      notify: false,
      welcomeIfVerified: true,
    });
    expect(mockUserUpdateMany).toHaveBeenCalledWith({
      where: { id: "u1", emailVerified: false },
      data: { emailVerified: true },
    });
    expect(mockConsentCreate).not.toHaveBeenCalled();
  });
});
