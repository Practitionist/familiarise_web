/**
 * @jest-environment node
 */

/**
 * One-click unsubscribe and its undo. Pins the token round-trip and tamper
 * rejection, that POST flips `emailEnabled` in Postgres only, that a bad
 * token neither writes nor reveals anything, that GET never writes, and that
 * resubscribe is a same-origin POST through the same signed link.
 */

const mockUpsert = jest.fn();
const mockGetNovuClient = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    notificationPreference: {
      upsert: (...args: unknown[]) => mockUpsert(...args),
    },
  },
}));

jest.mock("../../lib/novu/client", () => ({
  isNovuConfigured: () => true,
  getNovuClient: (...args: unknown[]) => mockGetNovuClient(...args),
}));

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

import { NextRequest } from "next/server";
import {
  buildEmailUnsubscribeUrl,
  generateEmailUnsubscribeToken,
  verifyEmailUnsubscribeToken,
} from "@/lib/email/unsubscribe";
import { GET, POST } from "@/app/api/notifications/unsubscribe/route";
import * as resubscribe from "@/app/api/notifications/resubscribe/route";

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
  it("flips emailEnabled only, in Postgres, without calling Novu", async () => {
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
    expect(mockGetNovuClient).not.toHaveBeenCalled();
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

describe("resubscribe", () => {
  const resubscribeUrl = (url: string) =>
    url.replace("/unsubscribe?", "/resubscribe?");
  const post = (url: string, origin?: string) =>
    resubscribe.POST(
      new NextRequest(url, {
        method: "POST",
        headers: origin ? { origin } : {},
      }),
    );

  it("the unsubscribe form lands on the done page with the signed pair", async () => {
    const res = await POST(
      new NextRequest(buildEmailUnsubscribeUrl(USER), {
        method: "POST",
        headers: { accept: "text/html" },
      }),
    );
    expect(res.status).toBe(303);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.searchParams.get("done")).toBe("1");
    expect(location.searchParams.get("u")).toBe(USER);
    expect(location.searchParams.get("t")).toBe(
      generateEmailUnsubscribeToken(USER),
    );
  });

  it("a valid same-origin POST turns email back on", async () => {
    const url = resubscribeUrl(buildEmailUnsubscribeUrl(USER));
    const res = await post(url, new URL(url).origin);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("resubscribed=1");
    expect(mockUpsert).toHaveBeenCalledWith({
      where: { userId: USER },
      update: { emailEnabled: true },
      create: { userId: USER, emailEnabled: true },
    });
  });

  it("refuses a bad token, a cross-site origin and a missing origin", async () => {
    const good = resubscribeUrl(buildEmailUnsubscribeUrl(USER));
    const origin = new URL(good).origin;
    const badToken = await post(
      `${origin}/api/notifications/resubscribe?u=${USER}&t=${"0".repeat(64)}`,
      origin,
    );
    expect(badToken.headers.get("location")).toContain("error=1");
    expect((await post(good, "https://evil.example")).status).toBe(403);
    expect((await post(good)).status).toBe(403);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("has no GET, so a prefetch can never flip it", () => {
    expect(resubscribe).not.toHaveProperty("GET");
  });
});
