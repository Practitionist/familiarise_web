/**
 * @jest-environment node
 */

/**
 * The join route limits per user after authentication. The edge limiter is an
 * IP backstop only: a cohort behind one NAT retries the lobby gate in the same
 * second the room opens, and an IP key would throttle all of them together.
 */

import { readFileSync } from "fs";
import { join } from "path";

const mockRequireApiAuth = jest.fn();
const mockApplyRateLimit = jest.fn();
const mockResolveMeetingAccess = jest.fn();

jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requireApiAuth: () => mockRequireApiAuth(),
}));
jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  meetingJoinLimiter: { name: "meetingJoinLimiter" },
  applyRateLimit: (...args: unknown[]) => mockApplyRateLimit(...args),
}));
jest.mock("../../lib/meetings/access", () => ({
  __esModule: true,
  resolveMeetingAccess: (...args: unknown[]) =>
    mockResolveMeetingAccess(...args),
}));
jest.mock("../../lib/stream-client", () => ({
  __esModule: true,
  isStreamConfigured: () => true,
}));
jest.mock("../../lib/stream-logger", () => ({
  streamLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { NextResponse } from "next/server";
import { guardMeetingRoute } from "@/lib/meetings/route-guard";
import { meetingJoinLimiter } from "@/lib/rate-limit";

const params = Promise.resolve({ meetingId: "m-1" });
const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireApiAuth.mockResolvedValue({ session: { user: { id: "u-1" } } });
  mockApplyRateLimit.mockResolvedValue(null);
  mockResolveMeetingAccess.mockResolvedValue({
    hasAccess: true,
    streamCallId: "call-1",
  });
});

describe("guardMeetingRoute with the join limiter", () => {
  it("limits by the signed-in user's id, not by IP", async () => {
    await guardMeetingRoute(
      params,
      "admit to",
      meetingJoinLimiter as unknown as Parameters<typeof guardMeetingRoute>[2],
    );
    expect(mockApplyRateLimit).toHaveBeenCalledWith(
      meetingJoinLimiter,
      "user:u-1",
      "meetings",
    );
  });

  it("answers the limiter's 429 before it resolves any meeting access", async () => {
    const limited = NextResponse.json(
      { code: "RATE_LIMITED" },
      { status: 429 },
    );
    mockApplyRateLimit.mockResolvedValue(limited);
    const guard = await guardMeetingRoute(
      params,
      "admit to",
      meetingJoinLimiter as unknown as Parameters<typeof guardMeetingRoute>[2],
    );
    expect(guard).toEqual({ ok: false, response: limited });
    expect(mockResolveMeetingAccess).not.toHaveBeenCalled();
  });

  it("never limits an unauthenticated caller by user id", async () => {
    const refusal = NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 },
    );
    mockRequireApiAuth.mockResolvedValue({ error: refusal });
    const guard = await guardMeetingRoute(
      params,
      "admit to",
      meetingJoinLimiter as unknown as Parameters<typeof guardMeetingRoute>[2],
    );
    expect(guard).toEqual({ ok: false, response: refusal });
    expect(mockApplyRateLimit).not.toHaveBeenCalled();
  });
});

describe("where the join limits live", () => {
  it("the join route hands the per-user limiter to the guard", () => {
    const src = read("app/api/meetings/[meetingId]/join/route.ts");
    expect(src).toMatch(
      /guardMeetingRoute\(\s*params,\s*"admit to",\s*meetingJoinLimiter,?\s*\)/,
    );
  });

  it("the edge rule stays an IP backstop sized for a whole cohort on one NAT", () => {
    const limits = read("lib/rate-limit.ts");
    expect(limits).toMatch(/streamJoinLimiter = makeLimiter\(1500, "1 m"/);
    expect(limits).toMatch(/meetingJoinLimiter = makeLimiter\(10, "1 m"/);
    const edge = read("middleware.ts");
    expect(edge).toContain("limiter: streamJoinLimiter");
    // The edge keys by IP only; a per-user key there would trust an unvalidated cookie.
    const rule = edge.slice(
      edge.indexOf('label: "stream: meeting join"'),
      edge.indexOf('label: "stream: api"'),
    );
    expect(rule).not.toMatch(/key:/);
  });
});
