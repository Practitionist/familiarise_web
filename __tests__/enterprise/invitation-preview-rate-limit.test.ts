/**
 * @jest-environment node
 */

/** The public invitation preview is rate limited per IP before any read. */

const mockLimit = jest.fn();
const mockFind = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { invitation: { findUnique: (...a: unknown[]) => mockFind(...a) } },
}));
jest.mock("../../lib/rate-limit", () => ({
  applyRateLimit: (...a: unknown[]) => mockLimit(...a),
  getClientIp: () => "203.0.113.7",
  invitePreviewLimiter: { name: "invite-preview" },
}));

import { NextRequest, NextResponse } from "next/server";
import { GET } from "@/app/api/invitations/preview/route";

const preview = () =>
  GET(
    new NextRequest(
      "http://localhost/api/invitations/preview?token=ckinvitation0000000000001",
    ),
  );

beforeEach(() => jest.clearAllMocks());

it("answers 429 and reads nothing once the IP is over its budget", async () => {
  mockLimit.mockResolvedValue(
    NextResponse.json({ code: "RATE_LIMITED" }, { status: 429 }),
  );
  expect((await preview()).status).toBe(429);
  expect(mockLimit).toHaveBeenCalledWith(
    { name: "invite-preview" },
    "203.0.113.7",
    "invite-preview",
  );
  expect(mockFind).not.toHaveBeenCalled();
});

it("previews a pending invitation within the budget", async () => {
  mockLimit.mockResolvedValue(null);
  mockFind.mockResolvedValue({
    status: "PENDING",
    expiresAt: new Date(Date.now() + 60_000),
    role: "LEARNER",
    organization: { name: "Acme", brandingProfile: null },
  });
  const res = await preview();
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ orgName: "Acme" });
});
