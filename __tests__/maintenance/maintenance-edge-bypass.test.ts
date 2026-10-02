/**
 * @jest-environment node
 */

/**
 * #1487 — Maintenance bypass cookie must use a short-lived HMAC-SHA256 signed
 * token (`<expiryTimestamp>.<hmac>`) verified via Web Crypto `crypto.subtle`,
 * never the raw `MAINTENANCE_BYPASS_SECRET`.
 */

import { NextRequest } from "next/server";
import {
  signMaintenanceBypassCookie,
  verifyMaintenanceBypassCookie,
  validateBypass,
  validateBypassAsync,
} from "../../lib/maintenance-edge";

describe("maintenance bypass signed cookie (#1487)", () => {
  const SECRET = "super-secret-maintenance-key-2026";
  const NOW = 1_760_000_000_000;
  const FUTURE = NOW + 60 * 60 * 1000;
  const PAST = NOW - 1_000;

  const originalEnv = process.env.MAINTENANCE_BYPASS_SECRET;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.MAINTENANCE_BYPASS_SECRET;
    } else {
      process.env.MAINTENANCE_BYPASS_SECRET = originalEnv;
    }
  });

  it("signs a token in <expiryTimestamp>.<hmac> format using Web Crypto and verifies it", async () => {
    const token = await signMaintenanceBypassCookie(SECRET, FUTURE);
    expect(token).toMatch(/^\d+\.[0-9a-f]{64}$/);
    expect(token).not.toContain(SECRET);

    await expect(
      verifyMaintenanceBypassCookie(token, SECRET, NOW),
    ).resolves.toBe(true);
  });

  it("rejects the raw static secret when supplied in the maintenance_bypass cookie", async () => {
    process.env.MAINTENANCE_BYPASS_SECRET = SECRET;

    await expect(
      verifyMaintenanceBypassCookie(SECRET, SECRET, NOW),
    ).resolves.toBe(false);

    const req = new NextRequest("https://familiarise.com/dashboard", {
      headers: {
        cookie: `maintenance_bypass=${SECRET}`,
      },
    });
    expect(validateBypass(req, null, NOW)).toBe(false);
    expect(validateBypass(req, SECRET, NOW)).toBe(false);
    await expect(validateBypassAsync(req, SECRET, NOW)).resolves.toBe(false);
  });

  it("accepts a valid unexpired signed cookie token in both sync and async validateBypass", async () => {
    const token = await signMaintenanceBypassCookie(SECRET, FUTURE + 5_000);
    const req = new NextRequest("https://familiarise.com/dashboard", {
      headers: {
        cookie: `maintenance_bypass=${token}`,
      },
    });

    expect(validateBypass(req, SECRET, NOW)).toBe(true);
    await expect(validateBypassAsync(req, SECRET, NOW)).resolves.toBe(true);
  });

  it("rejects an expired signed cookie token", async () => {
    const expiredToken = await signMaintenanceBypassCookie(SECRET, PAST);
    await expect(
      verifyMaintenanceBypassCookie(expiredToken, SECRET, NOW),
    ).resolves.toBe(false);

    const req = new NextRequest("https://familiarise.com/dashboard", {
      headers: {
        cookie: `maintenance_bypass=${expiredToken}`,
      },
    });
    expect(validateBypass(req, SECRET, NOW)).toBe(false);
  });

  it("rejects a signed cookie token when the timestamp or HMAC is tampered with", async () => {
    const token = await signMaintenanceBypassCookie(SECRET, FUTURE);
    const [, hmac] = token.split(".");
    const tamperedExpiry = `${FUTURE + 10_000}.${hmac}`;
    const tamperedHmac = `${FUTURE}.${"0".repeat(64)}`;

    await expect(
      verifyMaintenanceBypassCookie(tamperedExpiry, SECRET, NOW),
    ).resolves.toBe(false);
    await expect(
      verifyMaintenanceBypassCookie(tamperedHmac, SECRET, NOW),
    ).resolves.toBe(false);

    const req = new NextRequest("https://familiarise.com/dashboard", {
      headers: {
        cookie: `maintenance_bypass=${tamperedExpiry}`,
      },
    });
    expect(validateBypass(req, SECRET, NOW)).toBe(false);
  });

  it("still allows the x-maintenance-bypass request header for API/operator callers", async () => {
    const req = new NextRequest("https://familiarise.com/api/bookings", {
      headers: {
        "x-maintenance-bypass": SECRET,
      },
    });
    expect(validateBypass(req, SECRET, NOW)).toBe(true);
    await expect(validateBypassAsync(req, SECRET, NOW)).resolves.toBe(true);
  });
});
