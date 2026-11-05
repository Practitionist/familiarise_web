/** @jest-environment node */
const mockLookup = jest.fn();
const mockUpdate = jest.fn();
const mockWelcome = jest.fn();
const mockVerify = jest.fn();
const mockWithdraw = jest.fn();
const mockTx = {
  waitlist: { updateMany: jest.fn() },
  user: { findFirst: jest.fn() },
};
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    waitlist: {
      findUnique: (...args: unknown[]) => mockLookup(...args),
      updateMany: (...args: unknown[]) => mockUpdate(...args),
    },
    $transaction: async (run: (tx: typeof mockTx) => Promise<unknown>) =>
      run(mockTx),
  },
}));
jest.mock("@/lib/email", () => ({
  sendWaitlistConfirmEmail: jest.fn(),
  sendWaitlistWelcomeEmail: (...args: unknown[]) => mockWelcome(...args),
}));
jest.mock("@/lib/compliance/marketing-consent", () => ({
  withdrawMarketingConsent: (...args: unknown[]) => mockWithdraw(...args),
}));
jest.mock("@/lib/waitlist/tokens", () => ({
  canSignLinks: () => true,
  verifyConfirmToken: (...args: unknown[]) => mockVerify(...args),
  verifyUnsubscribeToken: () => true,
}));
jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

import { confirmSubscription, unsubscribe } from "@/lib/waitlist/service";
const issuedAt = new Date("2026-11-05T00:00:00Z").getTime();
const link = { email: "reader@example.com", token: "signed", issuedAt };

beforeEach(() => {
  jest.clearAllMocks();
  mockVerify.mockReturnValue(true);
  mockLookup.mockResolvedValue({
    status: "PENDING",
    name: "Reader",
    updatedAt: new Date(issuedAt),
  });
  mockUpdate.mockResolvedValue({ count: 1 });
  mockWelcome.mockResolvedValue({ success: true });
  mockTx.waitlist.updateMany.mockResolvedValue({ count: 1 });
  mockTx.user.findFirst.mockResolvedValue({ id: "account" });
  mockWithdraw.mockResolvedValue({ withdrawnCount: 1 });
});

describe("newsletter confirmation and withdrawal", () => {
  it("confirms only the current pending subscription revision", async () => {
    await expect(confirmSubscription(link)).resolves.toEqual({
      outcome: "CONFIRMED",
    });
    expect(mockUpdate).toHaveBeenCalledWith({
      where: {
        email: link.email,
        status: "PENDING",
        updatedAt: new Date(issuedAt),
      },
      data: expect.objectContaining({ status: "SUBSCRIBED" }),
    });
    expect(mockWelcome).toHaveBeenCalledTimes(1);
  });

  it.each(["UNSUBSCRIBED", "BOUNCED"])(
    "cannot resurrect a %s address with an old confirmation link",
    async (status) => {
      mockLookup.mockResolvedValue({
        status,
        name: "Reader",
        updatedAt: new Date(issuedAt),
      });
      await expect(confirmSubscription(link)).resolves.toEqual({
        outcome: "INVALID",
      });
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockWelcome).not.toHaveBeenCalled();
    },
  );

  it("rejects an earlier link after a new signup issues another revision", async () => {
    mockLookup.mockResolvedValue({
      status: "PENDING",
      name: "Reader",
      updatedAt: new Date(issuedAt + 1),
    });
    await expect(confirmSubscription(link)).resolves.toEqual({
      outcome: "INVALID",
    });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("does not confirm or send a welcome after a concurrent withdrawal wins", async () => {
    mockUpdate.mockResolvedValue({ count: 0 });
    await expect(confirmSubscription(link)).resolves.toEqual({
      outcome: "INVALID",
    });
    expect(mockWelcome).not.toHaveBeenCalled();
  });

  it("withdraws matching account communications and enrollment through one transaction", async () => {
    await expect(unsubscribe(link)).resolves.toEqual({ ok: true });
    expect(mockTx.waitlist.updateMany).toHaveBeenCalled();
    expect(mockWithdraw).toHaveBeenCalledWith(mockTx, "account");
    expect(mockTx.user.findFirst).toHaveBeenCalledWith({
      where: {
        email: { equals: link.email, mode: "insensitive" },
        erasedAt: null,
      },
      select: { id: true },
    });
  });

  it("keeps external subscriber opt-out independent of having an account", async () => {
    mockTx.user.findFirst.mockResolvedValue(null);
    await expect(unsubscribe(link)).resolves.toEqual({ ok: true });
    expect(mockTx.waitlist.updateMany).toHaveBeenCalled();
    expect(mockWithdraw).not.toHaveBeenCalled();
  });
});
