/**
 * @jest-environment node
 */

/**
 * POST /api/user/reauthenticate: password for everyone, password plus TOTP for
 * operators, and a CAS stamp of `reauthenticatedAt` on the caller's session.
 */

import { APIError } from "better-auth/api";
import { NextRequest } from "next/server";
import { isFreshSession, requireFreshSession } from "@/lib/auth/step-up";

const mockDb = {
  account: { findFirst: jest.fn() },
  session: { updateMany: jest.fn() },
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  get default() {
    return mockDb;
  },
}));

const mockVerifyPassword = jest.fn();
const mockVerifyTOTP = jest.fn();
jest.mock("../../lib/auth", () => ({
  __esModule: true,
  auth: {
    api: {
      verifyPassword: (...a: unknown[]) => mockVerifyPassword(...a),
      verifyTOTP: (...a: unknown[]) => mockVerifyTOTP(...a),
    },
  },
}));

const mockRequireApiAuth = jest.fn();
jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requireApiAuth: () => mockRequireApiAuth(),
}));
jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  reauthLimiter: {},
  applyRateLimit: jest.fn().mockResolvedValue(null),
}));
jest.mock("next/headers", () => ({
  headers: jest.fn().mockResolvedValue(new Headers()),
}));

import { POST } from "@/app/api/user/reauthenticate/route";

const call = (body: unknown) =>
  POST(
    new NextRequest("http://localhost/api/user/reauthenticate", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );

function signedIn(role: string) {
  mockRequireApiAuth.mockResolvedValue({
    session: {
      user: { id: "u1", role },
      session: { id: "s1", createdAt: new Date() },
    },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.account.findFirst.mockResolvedValue({ id: "acc" });
  mockDb.session.updateMany.mockResolvedValue({ count: 1 });
  mockVerifyPassword.mockResolvedValue({ status: true });
  mockVerifyTOTP.mockResolvedValue({});
});

describe("POST /api/user/reauthenticate", () => {
  it("stamps the current session after a correct password", async () => {
    signedIn("CONSULTEE");
    const res = await call({ password: "pw" });
    expect(res.status).toBe(200);
    expect(mockDb.session.updateMany).toHaveBeenCalledWith({
      where: { id: "s1", userId: "u1" },
      data: { reauthenticatedAt: expect.any(Date) },
    });
    expect(mockVerifyTOTP).not.toHaveBeenCalled();
  });

  it("refuses a wrong password without stamping", async () => {
    signedIn("CONSULTEE");
    mockVerifyPassword.mockRejectedValue(new APIError("BAD_REQUEST"));
    const res = await call({ password: "nope" });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      code: "INVALID_PASSWORD",
    });
    expect(mockDb.session.updateMany).not.toHaveBeenCalled();
  });

  it("tells a social-only user to sign in again", async () => {
    signedIn("CONSULTEE");
    mockDb.account.findFirst.mockResolvedValue(null);
    const res = await call({ password: "pw" });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ code: "NO_PASSWORD" });
  });

  it("requires a TOTP code from an operator and checks it", async () => {
    signedIn("ADMIN");
    const missing = await call({ password: "pw" });
    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toMatchObject({
      code: "TOTP_REQUIRED",
    });

    mockVerifyTOTP.mockRejectedValueOnce(new APIError("UNAUTHORIZED"));
    const wrong = await call({ password: "pw", totpCode: "000000" });
    expect(wrong.status).toBe(400);
    await expect(wrong.json()).resolves.toMatchObject({ code: "INVALID_CODE" });
    expect(mockDb.session.updateMany).not.toHaveBeenCalled();

    const ok = await call({ password: "pw", totpCode: "123456" });
    expect(ok.status).toBe(200);
    expect(mockVerifyTOTP).toHaveBeenLastCalledWith(
      expect.objectContaining({ body: { code: "123456" } }),
    );
  });

  it("answers 401 when the session row is gone", async () => {
    signedIn("CONSULTEE");
    mockDb.session.updateMany.mockResolvedValue({ count: 0 });
    const res = await call({ password: "pw" });
    expect(res.status).toBe(401);
  });
});

describe("step-up freshness", () => {
  const now = Date.now();
  it("uses the later of creation and re-authentication", () => {
    const old = new Date(now - 20 * 60 * 1000);
    expect(isFreshSession({ createdAt: old })).toBe(false);
    expect(
      isFreshSession({ createdAt: old, reauthenticatedAt: new Date() }),
    ).toBe(true);
  });

  it("answers a typed 403 when stale", async () => {
    const res = requireFreshSession({
      session: { createdAt: new Date(now - 16 * 60 * 1000) },
    });
    expect(res?.status).toBe(403);
    await expect(res?.json()).resolves.toMatchObject({
      code: "REAUTH_REQUIRED",
    });
    expect(
      requireFreshSession({ session: { createdAt: new Date() } }),
    ).toBeNull();
  });
});
