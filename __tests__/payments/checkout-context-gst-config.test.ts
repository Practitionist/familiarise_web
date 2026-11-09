/**
 * @jest-environment node
 */

// Invariant: a malformed PLATFORM_GSTIN answers the checkout context read with the
// typed 503 GST_CONFIG_INVALID and never reaches Sentry.

const mockCapture = jest.fn();
jest.mock("@sentry/nextjs", () => ({
  captureException: (...a: unknown[]) => mockCapture(...a),
}));
jest.mock("@/lib/auth-server", () => ({
  getSession: async () => ({ user: { id: "user_1" } }),
}));
jest.mock("@/lib/rate-limit", () => ({
  applyRateLimit: async () => null,
  checkoutContextLimiter: {},
}));
jest.mock("@/lib/referrals/service", () => ({
  getUserCredits: async () => ({ totalAvailable: 0 }),
}));
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: {} }));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/checkout/context/route";

afterEach(() => {
  delete process.env.PLATFORM_GSTIN;
});

it("answers 503 GST_CONFIG_INVALID on a wrong-state GSTIN, with no Sentry event", async () => {
  process.env.PLATFORM_GSTIN = "29ABCDE1234F1Z5";
  const response = await GET(
    new NextRequest("https://app.test/api/checkout/context"),
  );
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: "GST_CONFIG_INVALID" });
  expect(mockCapture).not.toHaveBeenCalled();
});
