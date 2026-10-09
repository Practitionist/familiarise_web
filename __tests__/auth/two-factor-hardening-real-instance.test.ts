/**
 * @jest-environment node
 */

/**
 * The 2FA, step-up and passkey `hooks.before` policies on a real BetterAuth
 * instance (memory adapter), plus the real rate-limit rules.
 */

import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createAuthMiddleware } from "better-auth/api";
import { twoFactor } from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import {
  assertOperatorMayEnableTwoFactor,
  assertTwoFactorRequestPolicy,
  generateBackupCodes,
} from "../../lib/auth/two-factor-policy";
import { assertSensitiveAuthAction } from "../../lib/auth/step-up";
import {
  assertOperatorMayRegisterPasskey,
  operatorPasskeyOptions,
} from "../../lib/auth/passkey-policy";
import { AUTH_RATE_LIMIT_RULES } from "../../lib/auth/rate-limit";

const APP = "http://localhost:3000";
const PASSWORD = "correct-horse-1";
const MINUTE = 60 * 1000;

function makeDb() {
  return {
    user: [] as Record<string, unknown>[],
    session: [] as Record<string, unknown>[],
    account: [] as Record<string, unknown>[],
    verification: [] as Record<string, unknown>[],
    twoFactor: [] as Record<string, unknown>[],
    passkey: [] as Record<string, unknown>[],
    rateLimit: [] as Record<string, unknown>[],
  };
}

const db = makeDb();
const auth = betterAuth({
  secret: "test-secret-that-is-at-least-32-characters",
  baseURL: APP,
  database: memoryAdapter(db),
  emailAndPassword: { enabled: true },
  user: {
    additionalFields: { role: { type: "string", required: false } },
  },
  session: {
    additionalFields: {
      reauthenticatedAt: { type: "date", required: false, input: false },
    },
  },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      await assertTwoFactorRequestPolicy(ctx);
      await assertOperatorMayEnableTwoFactor(ctx);
      await assertSensitiveAuthAction(ctx);
      await assertOperatorMayRegisterPasskey(ctx);
    }),
  },
  plugins: [
    twoFactor({
      issuer: "Familiarise",
      backupCodeOptions: {
        storeBackupCodes: "encrypted",
        customBackupCodesGenerate: generateBackupCodes,
      },
    }),
    passkey(operatorPasskeyOptions(APP)),
  ],
});

const request = (
  method: "GET" | "POST",
  p: string,
  body?: unknown,
  cookie?: string,
) =>
  auth.handler(
    new Request(`${APP}/api/auth${p}`, {
      method,
      headers: {
        "content-type": "application/json",
        origin: APP,
        ...(cookie ? { cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
const post = (p: string, body: unknown, cookie?: string) =>
  request("POST", p, body, cookie);

const cookieOf = (res: Response) =>
  (res.headers.get("set-cookie") ?? "")
    .split(/,(?=\s*[\w.-]+=)/)
    .map((c) => c.split(";")[0].trim())
    .filter((c) => c.includes("session_token="))
    .join("; ");
const sessionRow = (cookie: string) => {
  const token = decodeURIComponent(cookie.split("=")[1] ?? "").split(".")[0];
  return db.session.find((s) => s.token === token);
};

async function signUp(email: string, role: string) {
  const res = await post("/sign-up/email", {
    email,
    password: PASSWORD,
    name: "Person",
  });
  const user = db.user.find((u) => u.email === email);
  if (user) user.role = role;
  return cookieOf(res);
}

/** Signs up an operator and enrols TOTP; returns the fresh enrolled cookie. */
async function enrolledOperator(email: string) {
  const cookie = await signUp(email, "STAFF");
  const enable = await post(
    "/two-factor/enable",
    { password: PASSWORD },
    cookie,
  );
  const { totpURI } = (await enable.json()) as { totpURI: string };
  const secret = new TextDecoder().decode(
    base32.decode(new URL(totpURI).searchParams.get("secret") ?? ""),
  );
  const code = await createOTP(secret, { period: 30, digits: 6 }).totp();
  const verify = await post("/two-factor/verify-totp", { code }, cookie);
  expect(verify.status).toBe(200);
  return cookieOf(verify);
}

describe("two-factor hardening on a real instance", () => {
  it("refuses trustDevice on a verify endpoint", async () => {
    const res = await post("/two-factor/verify-totp", {
      code: "123456",
      trustDevice: true,
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      code: "TRUST_DEVICE_DISABLED",
    });
  });

  it("refuses /two-factor/disable for an operator", async () => {
    const cookie = await enrolledOperator("disable@example.test");
    const res = await post(
      "/two-factor/disable",
      { password: PASSWORD },
      cookie,
    );
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      code: "TWO_FACTOR_REQUIRED",
    });
  });

  it("refuses credential changes for an unenrolled operator", async () => {
    const cookie = await signUp("unenrolled@example.test", "ADMIN");
    const res = await post(
      "/change-password",
      { currentPassword: PASSWORD, newPassword: "another-horse-2" },
      cookie,
    );
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      code: "TWO_FACTOR_REQUIRED",
    });
  });

  it("requires a fresh session to regenerate backup codes", async () => {
    const cookie = await enrolledOperator("stepup@example.test");
    const row = sessionRow(cookie);
    expect(row).toBeDefined();
    if (!row) return;

    row.createdAt = new Date(Date.now() - 20 * MINUTE);
    const stale = await post(
      "/two-factor/generate-backup-codes",
      { password: PASSWORD },
      cookie,
    );
    expect(stale.status).toBe(403);
    await expect(stale.json()).resolves.toMatchObject({
      code: "REAUTH_REQUIRED",
    });

    row.reauthenticatedAt = new Date();
    const fresh = await post(
      "/two-factor/generate-backup-codes",
      { password: PASSWORD },
      cookie,
    );
    expect(fresh.status).toBe(200);
    const { backupCodes } = (await fresh.json()) as { backupCodes: string[] };
    expect(backupCodes).toHaveLength(10);
    for (const code of backupCodes) {
      expect(code).toMatch(/^[a-hjkmnp-z2-9]{5}-[a-hjkmnp-z2-9]{5}$/);
    }
  });

  it("refuses passkey registration for anyone but an enrolled operator", async () => {
    const consumer = await signUp("consumer@example.test", "CONSULTEE");
    const unenrolled = await signUp("new-staff@example.test", "STAFF");
    for (const cookie of [consumer, unenrolled]) {
      const res = await request(
        "GET",
        "/passkey/generate-register-options",
        undefined,
        cookie,
      );
      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({
        code: "PASSKEY_OPERATORS_ONLY",
      });
    }

    const operator = await enrolledOperator("passkey@example.test");
    const ok = await request(
      "GET",
      "/passkey/generate-register-options",
      undefined,
      operator,
    );
    expect(ok.status).toBe(200);
    await expect(ok.json()).resolves.toMatchObject({
      authenticatorSelection: { userVerification: "required" },
    });
  });
});

describe("auth rate-limit rules on a real instance", () => {
  it("applies /two-factor/verify-* to /two-factor/verify-totp", async () => {
    const limited = betterAuth({
      secret: "test-secret-that-is-at-least-32-characters",
      baseURL: APP,
      database: memoryAdapter(makeDb()),
      emailAndPassword: { enabled: true },
      rateLimit: {
        enabled: true,
        storage: "memory",
        window: 60,
        max: 100,
        customRules: AUTH_RATE_LIMIT_RULES,
      },
      plugins: [twoFactor({ issuer: "Familiarise" })],
    });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await limited.handler(
        new Request(`${APP}/api/auth/two-factor/verify-totp`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: APP,
            "x-forwarded-for": "203.0.113.7",
          },
          body: JSON.stringify({ code: "123456" }),
        }),
      );
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 5)).not.toContain(429);
    expect(statuses[5]).toBe(429);
  });
});
