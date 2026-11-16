/**
 * @jest-environment node
 */

/**
 * The monthly GST outward-supplies register is written by the export job into
 * the private bucket and read back through this one ADMIN-only door. The
 * period is a single IST calendar month, and the storage path the route builds
 * must be the path the job uploaded to — a month out would hand the operator
 * somebody else's register.
 */

jest.mock("@sentry/core", () => jest.requireMock("@sentry/nextjs"));
jest.mock("@sentry/nextjs", () => ({
  __esModule: true,
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const getSession = jest.fn();
jest.mock("../../lib/auth-server", () => ({
  __esModule: true,
  getSession: (...a: unknown[]) => getSession(...a),
}));

jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  applyRateLimit: jest.fn(async () => null),
  moneyOpsLimiter: {},
  gstRegisterDownloadLimiter: {},
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {},
}));

const objectExists = jest.fn();
const signedUrl = jest.fn();
jest.mock("../../lib/storage/private-finance-object", () => ({
  privateFinanceObjectExists: (...a: unknown[]) => objectExists(...a),
  createPrivateFinanceSignedUrl: (...a: unknown[]) => signedUrl(...a),
}));

import * as Sentry from "@sentry/nextjs";
import { NextRequest } from "next/server";
import {
  applyRateLimit,
  gstRegisterDownloadLimiter,
} from "../../lib/rate-limit";
import { GET } from "../../app/api/admin/compliance/gst-register/route";

/** An operator session the ADMIN gate admits: role plus the 2FA precondition. */
const adminSession = {
  user: { id: "admin_1", role: "ADMIN", twoFactorEnabled: true },
};

const request = (query: string) =>
  new NextRequest(`http://localhost/api/admin/compliance/gst-register${query}`);

beforeEach(() => {
  jest.clearAllMocks();
  getSession.mockResolvedValue(adminSession);
  objectExists.mockResolvedValue(true);
  signedUrl.mockResolvedValue("https://storage.test/signed?token=x");
});

describe("GET /api/admin/compliance/gst-register", () => {
  it("refuses a caller with no session", async () => {
    getSession.mockResolvedValue(null);

    const res = await GET(request("?period=2026-10"));

    expect(res.status).toBe(401);
    expect(objectExists).not.toHaveBeenCalled();
  });

  it("refuses a staff session — the register is ADMIN-only", async () => {
    getSession.mockResolvedValue({
      user: { id: "staff_1", role: "STAFF", twoFactorEnabled: true },
    });

    const res = await GET(request("?period=2026-10"));

    expect(res.status).toBe(403);
    // `compliance.manage` is ADMIN-only on the permission matrix.
    await expect(res.json()).resolves.toMatchObject({ code: "FORBIDDEN" });
    expect(objectExists).not.toHaveBeenCalled();
  });

  it("redirects an admin to the signed URL for that month's register", async () => {
    const res = await GET(request("?period=2026-10"));

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://storage.test/signed?token=x",
    );
    // The path the export job uploads to for October 2026, spelled out: a
    // month of drift here hands the operator the wrong register.
    expect(objectExists).toHaveBeenCalledWith(
      "compliance/gst/2026-10-01_2026-10-31.csv",
    );
    expect(signedUrl).toHaveBeenCalledWith(
      "compliance/gst/2026-10-01_2026-10-31.csv",
      600,
    );
    expect(applyRateLimit).toHaveBeenCalledWith(
      gstRegisterDownloadLimiter,
      "admin_1",
    );
  });

  it("maps a month whose length differs to the days that month has", async () => {
    await GET(request("?period=2026-02"));

    expect(objectExists).toHaveBeenCalledWith(
      "compliance/gst/2026-02-01_2026-02-28.csv",
    );

    objectExists.mockClear();
    await GET(request("?period=2028-02"));

    expect(objectExists).toHaveBeenCalledWith(
      "compliance/gst/2028-02-01_2028-02-29.csv",
    );
  });

  it("answers 404 when the job has not produced that period yet", async () => {
    objectExists.mockResolvedValue(false);

    const res = await GET(request("?period=2026-10"));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("No outward-supplies register"),
    });
    expect(signedUrl).not.toHaveBeenCalled();
  });

  it("answers 400 for a period that is not a month", async () => {
    const res = await GET(request("?period=2026-13"));

    expect(res.status).toBe(400);
    expect(objectExists).not.toHaveBeenCalled();
    expect(signedUrl).not.toHaveBeenCalled();
  });

  it("answers 400 when no period is given at all", async () => {
    const res = await GET(request(""));

    expect(res.status).toBe(400);
    expect(objectExists).not.toHaveBeenCalled();
  });

  it("reports a storage failure to Sentry without echoing it", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    objectExists.mockRejectedValue(new Error("bucket token leaked"));

    const res = await GET(request("?period=2026-10"));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe(
      "Failed to fetch the GST outward-supplies register",
    );
    expect(JSON.stringify(body)).not.toContain("bucket token leaked");
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });
});
