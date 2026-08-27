/**
 * @jest-environment node
 */

/**
 * #support-hub — PLATFORM intake route wiring (stateless scope).
 *
 * Auth and catalog gating at the boundary: an anonymous caller gets the
 * UNAUTHORIZED envelope; an unknown/stale flowId 404s with refresh guidance
 * instead of silently escalating. The flowchart engine itself is covered by
 * platform-flows/flow-walk suites.
 */

jest.mock("@sentry/nextjs", () => ({
  __esModule: true,
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock("../../lib/auth-server", () => ({
  __esModule: true,
  getSession: jest.fn(),
}));

jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  spamLimiter: {},
  applyRateLimit: jest.fn(async () => null),
}));

jest.mock("../../lib/validation/limits", () => ({
  __esModule: true,
  assertBodySize: jest.fn(() => null),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    membership: { findMany: jest.fn(async () => []) },
  },
}));

import { NextRequest } from "next/server";
import { getSession } from "../../lib/auth-server";
import { GET, POST } from "../../app/api/support/platform/route";

const mockedGetSession = getSession as jest.Mock;

function postReq(body: unknown): NextRequest {
  return new NextRequest("https://x.test/api/support/platform", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/support/platform", () => {
  it("401 UNAUTHORIZED envelope without a session", async () => {
    mockedGetSession.mockResolvedValue(null);
    const res = await POST(postReq({ flowId: "anything" }));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.code).toBe("UNAUTHORIZED");
  });

  it("404 envelope with refresh guidance for an unknown flow (stale catalog)", async () => {
    mockedGetSession.mockResolvedValue({ user: { id: "u1" } });
    // Bare entry turn — exactly what PlatformSupportSheet.startFlow sends.
    const res = await POST(postReq({ flowId: "no-such-flow" }));
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.code).toBe("NOT_FOUND");
    expect(json.error).toContain("refresh");
  });

  it("REGRESSION: a bare entry turn {flowId} passes validation (the XOR refine used to 400 it)", async () => {
    mockedGetSession.mockResolvedValue({ user: { id: "u1" } });
    const res = await POST(postReq({ flowId: "PAYMENTS_BILLING", nodeId: null }));
    // Reaches the engine and answers with the entry prompt — NOT a
    // VALIDATION_FAILED 400.
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.escalated).toBe(false);
    expect(json.data.messages.length).toBeGreaterThan(0);
  });

  it("VALIDATION_FAILED envelope when a turn carries BOTH an option and a message", async () => {
    mockedGetSession.mockResolvedValue({ user: { id: "u1" } });
    const res = await POST(
      postReq({ flowId: "PAYMENTS_BILLING", chosenOptionId: "twice", userMessage: "both" }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("VALIDATION_FAILED");
    // Developer detail: the zod flatten rides along.
    expect(json.detail).toBeDefined();
  });
});

describe("GET /api/support/platform", () => {
  it("401 UNAUTHORIZED envelope without a session", async () => {
    mockedGetSession.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.code).toBe("UNAUTHORIZED");
  });
});
