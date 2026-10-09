/**
 * @jest-environment node
 */

jest.mock("@sentry/nextjs", () => ({
  __esModule: true,
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  flush: jest.fn(async () => true),
}));

jest.mock("../../lib/auth-server", () => ({
  __esModule: true,
  getSession: jest.fn(async () => ({ user: { id: "u1", name: "U" } })),
}));

jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  spamLimiter: {},
  applyRateLimit: jest.fn(async () => null),
}));

jest.mock("../../lib/novu", () => ({
  __esModule: true,
  notifyFeedbackReceived: jest.fn(),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { platformFeedback: { create: jest.fn() } },
}));

import { NextRequest } from "next/server";
import { POST } from "../../app/api/user/feedbacks/route";

describe("POST /api/user/feedbacks validation", () => {
  it("answers bad input with the coded envelope and no raw issue list", async () => {
    const res = await POST(
      new NextRequest("http://localhost/api/user/feedbacks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("VALIDATION_FAILED");
    expect(json).not.toHaveProperty("details");
  });
});
