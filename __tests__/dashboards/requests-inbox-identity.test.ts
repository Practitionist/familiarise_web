/**
 * @jest-environment node
 */

/**
 * The inbox read names the account its page was rendered for. A tab left open
 * across an account switch is refused with the shared 409 IDENTITY_CHANGED
 * (never a misleading 403), and a real permission refusal carries
 * ACCESS_DENIED so the card can tell the two apart.
 */

const lookupSession = jest.fn();
jest.mock("../../lib/auth-session-lookup", () => ({
  __esModule: true,
  lookupSession: () => lookupSession(),
}));

let requestHeaders = new Headers();
jest.mock("next/headers", () => ({
  headers: async () => requestHeaders,
}));
jest.mock("../../lib/observability/identity", () => ({
  setSentryIdentityFromSession: jest.fn(),
  setSentryOrgContext: jest.fn(),
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { membership: { findMany: jest.fn() } },
}));
jest.mock("../../lib/data/requests-inbox", () => ({
  __esModule: true,
  readRequestsInbox: jest.fn().mockResolvedValue({ rows: [], meta: {} }),
}));
jest.mock("../../lib/data/needs-you", () => ({
  __esModule: true,
  countRequestsToAnswer: jest.fn().mockResolvedValue(0),
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/bookings/inbox/route";
import { EXPECTED_USER_HEADER } from "@/lib/auth/identity-header";

const call = (consultantProfileId: string) =>
  GET(
    new NextRequest(
      `http://localhost/api/bookings/inbox?consultantProfileId=${consultantProfileId}&orgScope=personal&type=consultation&sort=priority&page=1&limit=20`,
    ),
  );

beforeEach(() => {
  requestHeaders = new Headers();
  lookupSession.mockResolvedValue({
    kind: "found",
    session: {
      session: { id: "s1" },
      user: {
        id: "u-new",
        role: "CONSULTANT",
        banned: false,
        consultantProfileId: "cp-new",
      },
    },
  });
});

describe("GET /api/bookings/inbox identity", () => {
  it("answers 409 IDENTITY_CHANGED when the page belongs to another account", async () => {
    requestHeaders.set(EXPECTED_USER_HEADER, "u-old");
    const res = await call("cp-old");
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      code: "IDENTITY_CHANGED",
    });
  });

  it("answers 403 ACCESS_DENIED for another expert's id under the right account", async () => {
    requestHeaders.set(EXPECTED_USER_HEADER, "u-new");
    const res = await call("cp-someone-else");
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: "Access denied",
      code: "ACCESS_DENIED",
    });
  });

  it("serves the expert's own inbox when the account matches", async () => {
    requestHeaders.set(EXPECTED_USER_HEADER, "u-new");
    const res = await call("cp-new");
    expect(res.status).toBe(200);
  });

  it("still serves a caller that names no expected user", async () => {
    const res = await call("cp-new");
    expect(res.status).toBe(200);
  });
});
