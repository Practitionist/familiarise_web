/**
 * @jest-environment node
 */

/**
 * The onboarding gate (invitees, SSO JIT members): an 18+ date of birth and
 * consent are validated on the server, timestamps are stamped by the server,
 * and only an org member or invitee may complete onboarding this way.
 */

jest.mock("../../lib/auth-server", () => ({ getSession: jest.fn() }));
jest.mock("../../lib/rate-limit", () => ({
  applyRateLimit: jest.fn(async () => null),
  onboardingSubmitLimiter: {},
}));
jest.mock("../../lib/compliance/dpdp", () => ({
  ensureConsentPurposes: jest.fn(),
}));

const tx = { user: { updateMany: jest.fn() } };
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(),
    membership: { findFirst: jest.fn() },
    invitation: { findFirst: jest.fn() },
  },
}));

import prisma from "../../lib/prisma";
import { getSession } from "../../lib/auth-server";
import { ensureConsentPurposes } from "../../lib/compliance/dpdp";
import { completeOnboardingGateAction } from "../../actions/onboarding-gate.action";

const mockGetSession = getSession as unknown as jest.Mock;
const mockTransaction = prisma.$transaction as unknown as jest.Mock;
const mockMembership = prisma.membership.findFirst as unknown as jest.Mock;
const mockInvitation = prisma.invitation.findFirst as unknown as jest.Mock;
const mockEnsureConsent = ensureConsentPurposes as unknown as jest.Mock;

const USER = {
  id: "user-1",
  email: "ada@example.com",
  emailVerified: true,
  role: "CONSULTEE",
  onboardingCompleted: false,
};

const validGate = (overrides: Record<string, unknown> = {}) => ({
  dateOfBirth: "1990-06-15",
  termsAccepted: true,
  privacyAccepted: true,
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSession.mockResolvedValue({ user: USER });
  mockTransaction.mockImplementation(async (fn: (t: typeof tx) => unknown) =>
    fn(tx),
  );
  tx.user.updateMany.mockResolvedValue({ count: 1 });
  mockMembership.mockResolvedValue(null);
  mockInvitation.mockResolvedValue({ id: "inv_1" });
});

describe("completeOnboardingGateAction", () => {
  it("refuses an under-18 date of birth on the server", async () => {
    const minor = new Date();
    minor.setUTCFullYear(minor.getUTCFullYear() - 16);
    const result = await completeOnboardingGateAction(
      validGate({ dateOfBirth: minor.toISOString().slice(0, 10) }),
    );
    expect(result).toMatchObject({ success: false, field: "dateOfBirth" });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("refuses missing consent", async () => {
    for (const missing of ["termsAccepted", "privacyAccepted"]) {
      const result = await completeOnboardingGateAction(
        validGate({ [missing]: false }),
      );
      expect(result).toMatchObject({ success: false, field: missing });
    }
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("refuses a user with neither a membership nor a pending invitation", async () => {
    mockInvitation.mockResolvedValue(null);
    const result = await completeOnboardingGateAction(validGate());
    expect(result).toMatchObject({ success: false, code: "GATE_NOT_ELIGIBLE" });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("an unverified email cannot ride someone else's invitation", async () => {
    mockGetSession.mockResolvedValue({
      user: { ...USER, emailVerified: false },
    });
    const result = await completeOnboardingGateAction(validGate());
    expect(result).toMatchObject({ success: false, code: "GATE_NOT_ELIGIBLE" });
    expect(mockInvitation).not.toHaveBeenCalled();
  });

  it("an invitee completes onboarding with server-stamped consent in one tx", async () => {
    const before = Date.now();
    const result = await completeOnboardingGateAction(
      validGate({
        marketingConsent: true,
        // Client-forged timestamps are stripped by the schema.
        termsAcceptedAt: "2001-01-01T00:00:00.000Z",
      }),
    );
    expect(result).toEqual({ success: true });

    const claim = tx.user.updateMany.mock.calls[0][0];
    expect(claim.where).toEqual({
      id: USER.id,
      onboardingCompleted: { not: true },
    });
    expect(claim.data.onboardingCompleted).toBe(true);
    expect(claim.data.dateOfBirth).toBeInstanceOf(Date);
    expect(claim.data.termsAcceptedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(claim.data.privacyAcceptedAt.getTime()).toBeGreaterThanOrEqual(
      before,
    );
    expect(mockEnsureConsent).toHaveBeenCalledWith(
      tx,
      USER.id,
      expect.arrayContaining([
        "PRIMARY_PROCESSING",
        "STREAM_DATA_PROCESSING",
        "SESSION_BOOKING",
        "MARKETING_COMMS",
      ]),
    );
  });

  it("an SSO JIT member (active membership) is eligible without an invitation", async () => {
    mockMembership.mockResolvedValue({ id: "m_1" });
    mockInvitation.mockResolvedValue(null);
    await expect(completeOnboardingGateAction(validGate())).resolves.toEqual({
      success: true,
    });
  });

  it("a lost claim records no consent", async () => {
    tx.user.updateMany.mockResolvedValue({ count: 0 });
    await expect(completeOnboardingGateAction(validGate())).resolves.toEqual({
      success: true,
    });
    expect(mockEnsureConsent).not.toHaveBeenCalled();
  });

  it("an already onboarded user is a no-op success", async () => {
    mockGetSession.mockResolvedValue({
      user: { ...USER, onboardingCompleted: true },
    });
    await expect(completeOnboardingGateAction(validGate())).resolves.toEqual({
      success: true,
    });
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});
