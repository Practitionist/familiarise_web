/** @jest-environment node */
import { NextRequest } from "next/server";

const mockBatchSend = jest.fn();
const mockUserRead = jest.fn();
const mockSubscriberRead = jest.fn();
const mockSuppressionRead = jest.fn();
const mockStage = jest.fn();
const mockSettle = jest.fn();
const subscribers = [
  { email: "account@example.com", name: "Account" },
  { email: "external@example.com", name: "Subscriber" },
];
const enabled = {
  marketingEmails: true,
  allNotifications: true,
  emailEnabled: true,
};

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findMany: (...args: unknown[]) => mockUserRead(...args) },
    waitlist: { findMany: (...args: unknown[]) => mockSubscriberRead(...args) },
    emailSuppression: {
      findMany: (...args: unknown[]) => mockSuppressionRead(...args),
    },
    failedEmailBatch: {
      upsert: (...args: unknown[]) => mockStage(...args),
      update: (...args: unknown[]) => mockSettle(...args),
    },
  },
}));
jest.mock("@/lib/auth-helpers", () => ({
  requireAdminAuth: jest
    .fn()
    .mockResolvedValue({ session: { user: { id: "admin" } } }),
}));
jest.mock("@/lib/email", () => ({
  getResendClient: () => ({
    batch: { send: (...args: unknown[]) => mockBatchSend(...args) },
  }),
  SENDERS: { newsletter: "newsletter@news.example.com" },
}));
jest.mock("@/lib/email/config", () => ({
  companyPostalAddress: () => "Company address",
}));
jest.mock("@/lib/email/delivery-guard", () => ({
  heldRecipientDomain: () => null,
}));
jest.mock("@/lib/waitlist/service", () => ({
  listSendableSubscribers: async () => subscribers,
}));
jest.mock("@/lib/waitlist/tokens", () => ({
  buildUnsubscribeUrl: (email: string) =>
    `https://example.com/unsubscribe?email=${email}`,
}));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

import { POST } from "@/app/api/admin/waitlist/broadcast/route";

async function broadcast() {
  return POST(
    new NextRequest("https://example.com/api/admin/waitlist/broadcast", {
      method: "POST",
      body: JSON.stringify({ subject: "News", htmlBody: "<p>Update</p>" }),
    }),
  );
}

describe("newsletter broadcasts and account opt-outs", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUserRead.mockResolvedValue([
      {
        email: "account@example.com",
        erasedAt: null,
        notificationPreferences: enabled,
      },
    ]);
    mockSubscriberRead.mockResolvedValue(subscribers);
    mockSuppressionRead.mockResolvedValue([]);
    mockStage.mockResolvedValue({ id: "batch" });
    mockSettle.mockResolvedValue({});
    mockBatchSend.mockResolvedValue({
      data: { data: [{ id: "sent" }] },
      error: null,
    });
  });

  it("filters account opt-outs without excluding confirmed external subscribers", async () => {
    mockUserRead.mockResolvedValue([
      {
        email: "account@example.com",
        erasedAt: null,
        notificationPreferences: { ...enabled, marketingEmails: false },
      },
    ]);
    const response = await broadcast();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      skippedPreferences: 1,
      total: 1,
    });
    expect(mockBatchSend).toHaveBeenCalledWith(
      [expect.objectContaining({ to: "external@example.com" })],
      expect.anything(),
    );
  });

  it.each(["preference", "unsubscribe", "complaint"])(
    "rechecks a late %s change after staging without changing the stored payload",
    async (change) => {
      mockStage.mockImplementation(async () => {
        if (change === "preference")
          mockUserRead.mockResolvedValue([
            {
              email: "account@example.com",
              erasedAt: null,
              notificationPreferences: { ...enabled, marketingEmails: false },
            },
          ]);
        if (change === "unsubscribe")
          mockSubscriberRead.mockResolvedValue([subscribers[1]]);
        if (change === "complaint")
          mockSuppressionRead.mockResolvedValue([
            { email: "account@example.com", reason: "COMPLAINT" },
          ]);
        return { id: "batch" };
      });
      const response = await broadcast();
      expect(await response.json()).toMatchObject({ failed: 2, sent: 0 });
      expect(mockBatchSend).not.toHaveBeenCalled();
      expect(mockSettle).toHaveBeenCalledWith({
        where: { id: "batch" },
        data: {
          status: "DEAD_LETTER",
          lastError:
            "batch audience changed: consent, preferences or suppression",
        },
      });
      expect(mockStage.mock.calls[0][0].create.payload).toHaveLength(2);
    },
  );

  it("keeps staged mail pending when a policy read fails", async () => {
    mockStage.mockImplementation(async () => {
      mockUserRead.mockRejectedValue(new Error("database unavailable"));
      return { id: "batch" };
    });
    const response = await broadcast();
    expect(await response.json()).toMatchObject({ failed: 2, sent: 0 });
    expect(mockBatchSend).not.toHaveBeenCalled();
    expect(mockSettle).toHaveBeenCalledWith({
      where: { id: "batch" },
      data: { lastError: "database unavailable" },
    });
  });
});
