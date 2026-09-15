/**
 * @jest-environment node
 */

/**
 * #1653 — one-click unsubscribe. Pins the token round-trip and tamper
 * rejection, that POST flips `emailEnabled` and mirrors it to Novu, that a bad
 * token neither writes nor reveals anything, and that GET never writes.
 */

const mockUpsert = jest.fn();
const mockUpdateSubscriberPreferences = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    notificationPreference: {
      upsert: (...args: unknown[]) => mockUpsert(...args),
    },
  },
}));

jest.mock("../../lib/novu/subscriber", () => ({
  updateSubscriberPreferences: (...args: unknown[]) =>
    mockUpdateSubscriberPreferences(...args),
}));

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

import { NextRequest } from "next/server";
import {
  buildEmailUnsubscribeUrl,
  generateEmailUnsubscribeToken,
  verifyEmailUnsubscribeToken,
} from "@/lib/email/unsubscribe";
import { GET, POST } from "@/app/api/notifications/unsubscribe/route";

const USER = "user_abc";

beforeEach(() => {
  jest.clearAllMocks();
  mockUpsert.mockResolvedValue({
    inAppEnabled: true,
    emailEnabled: false,
    pushEnabled: false,
    appointmentReminders: true,
    paymentNotifications: true,
    supportUpdates: true,
    feedbackAlerts: true,
    trialNotifications: true,
    subscriptionAlerts: true,
    marketingEmails: false,
    orgBillingAlerts: true,
    orgMembershipAlerts: true,
    orgProgramAlerts: true,
  });
});

describe("email unsubscribe token", () => {
  it("round-trips and rejects a tampered token", () => {
    const token = generateEmailUnsubscribeToken(USER);
    expect(verifyEmailUnsubscribeToken(USER, token)).toBe(true);
    expect(verifyEmailUnsubscribeToken("user_xyz", token)).toBe(false);
    const flipped = token.endsWith("0") ? "1" : "0";
    expect(
      verifyEmailUnsubscribeToken(USER, `${token.slice(0, -1)}${flipped}`),
    ).toBe(false);
  });
});

describe("POST /api/notifications/unsubscribe", () => {
  it("flips emailEnabled only and mirrors the flags to Novu", async () => {
    const res = await POST(
      new NextRequest(buildEmailUnsubscribeUrl(USER), { method: "POST" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockUpsert).toHaveBeenCalledWith({
      where: { userId: USER },
      update: { emailEnabled: false },
      create: { userId: USER, emailEnabled: false },
    });
    expect(mockUpdateSubscriberPreferences).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ email: false, inApp: true }),
    );
  });

  it("answers 400 to a bad token without touching the row", async () => {
    const res = await POST(
      new NextRequest(
        `http://localhost:3000/api/notifications/unsubscribe?u=${USER}&t=deadbeef`,
        { method: "POST" },
      ),
    );
    expect(res.status).toBe(400);
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});

describe("GET /api/notifications/unsubscribe", () => {
  it("redirects to the confirmation page and never writes", async () => {
    const res = await GET(new NextRequest(buildEmailUnsubscribeUrl(USER)));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain(
      `/email/unsubscribe?u=${USER}&t=`,
    );
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});
