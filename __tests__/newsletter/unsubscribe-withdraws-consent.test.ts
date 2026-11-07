/**
 * @jest-environment node
 */

/**
 * The newsletter unsubscribe commits on its own, then withdraws a linked
 * account's MARKETING_COMMS consent in a separate, best-effort transaction.
 */

const mockUpdateMany = jest.fn();
const mockFindUnique = jest.fn();
const mockTransaction = jest.fn();
const mockWithdrawConsent = jest.fn();
const mockCaptureException = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    newsletterSubscriber: {
      updateMany: (...args: unknown[]) => mockUpdateMany(...args),
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
    },
    $transaction: (...args: unknown[]) => mockTransaction(...args),
  },
}));
jest.mock("../../lib/compliance/dpdp", () => ({
  withdrawConsent: (...args: unknown[]) => mockWithdrawConsent(...args),
}));
jest.mock("../../lib/email", () => ({
  sendWaitlistConfirmEmail: jest.fn(),
  sendWaitlistWelcomeEmail: jest.fn(),
}));
jest.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
  captureMessage: jest.fn(),
}));
jest.mock("../../lib/newsletter/tokens", () => ({
  canSignLinks: () => true,
  verifyConfirmToken: jest.fn(),
  verifyUnsubscribeToken: () => true,
}));

import { unsubscribe } from "../../lib/newsletter/service";

const tx = { consentArtifact: {} };

describe("newsletter unsubscribe and the linked marketing consent", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "error").mockImplementation(() => {});
    mockUpdateMany.mockResolvedValue({ count: 1 });
    mockTransaction.mockImplementation((fn: (t: unknown) => unknown) => fn(tx));
    mockWithdrawConsent.mockResolvedValue({ withdrawnCount: 1 });
  });

  it("withdraws MARKETING_COMMS for a row linked to an account, after the unsubscribe", async () => {
    mockFindUnique.mockResolvedValue({ userId: "user_1" });

    await expect(
      unsubscribe({ email: " Reader@Example.com", token: "t" }),
    ).resolves.toEqual({ ok: true });

    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { email: "reader@example.com", status: { not: "UNSUBSCRIBED" } },
      data: { status: "UNSUBSCRIBED", unsubscribedAt: expect.any(Date) },
    });
    expect(mockWithdrawConsent).toHaveBeenCalledWith(
      { userId: "user_1", purposeCode: "MARKETING_COMMS" },
      tx,
    );
    expect(mockUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(
      mockWithdrawConsent.mock.invocationCallOrder[0],
    );
  });

  it("withdraws nothing for a row with no account", async () => {
    mockFindUnique.mockResolvedValue({ userId: null });

    await expect(
      unsubscribe({ email: "a@b.test", token: "t" }),
    ).resolves.toEqual({ ok: true });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("still reports the committed unsubscribe when the withdrawal fails, and logs it once", async () => {
    mockFindUnique.mockResolvedValue({ userId: "user_1" });
    mockWithdrawConsent.mockRejectedValue(new Error("pool timeout"));

    await expect(
      unsubscribe({ email: "a@b.test", token: "t" }),
    ).resolves.toEqual({ ok: true });
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  it("throws when the unsubscribe itself fails, so the route never says unsubscribed", async () => {
    mockUpdateMany.mockRejectedValue(new Error("db down"));

    await expect(
      unsubscribe({ email: "a@b.test", token: "t" }),
    ).rejects.toThrow("db down");
    expect(mockWithdrawConsent).not.toHaveBeenCalled();
  });
});
