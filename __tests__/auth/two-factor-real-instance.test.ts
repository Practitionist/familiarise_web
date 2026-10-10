/**
 * @jest-environment node
 */

/**
 * lib/auth/two-factor-policy.ts on a real BetterAuth instance (memory
 * adapter): only operators may enable TOTP, and enrolling ends every session
 * that was opened with the password alone.
 */

import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createAuthMiddleware } from "better-auth/api";
import { twoFactor } from "better-auth/plugins";
import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import {
  assertOperatorMayEnableTwoFactor,
  isTwoFactorEnrolment,
} from "../../lib/auth/two-factor-policy";

const APP = "http://localhost:3000";
const db = {
  user: [] as Record<string, unknown>[],
  session: [] as Record<string, unknown>[],
  account: [] as Record<string, unknown>[],
  verification: [] as Record<string, unknown>[],
  twoFactor: [] as Record<string, unknown>[],
};

const auth = betterAuth({
  secret: "test-secret-that-is-at-least-32-characters",
  baseURL: APP,
  database: memoryAdapter(db),
  emailAndPassword: { enabled: true },
  user: {
    additionalFields: { role: { type: "string", required: false } },
  },
  hooks: { before: createAuthMiddleware(assertOperatorMayEnableTwoFactor) },
  databaseHooks: {
    user: {
      update: {
        after: async (user, ctx) => {
          if (isTwoFactorEnrolment(user, ctx?.path)) {
            db.session = db.session.filter((s) => s.userId !== user.id);
          }
        },
      },
    },
  },
  plugins: [twoFactor({ issuer: "Familiarise" })],
});

const call = (p: string, body: unknown, cookie?: string) =>
  auth.handler(
    new Request(`${APP}/api/auth${p}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: APP,
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
const cookieOf = (res: Response) =>
  (res.headers.get("set-cookie") ?? "")
    .split(/,(?=\s*[\w.-]+=)/)
    .map((c) => c.split(";")[0].trim())
    .filter((c) => c.includes("session_token="))
    .join("; ");

async function signUp(email: string, role: string) {
  const res = await call("/sign-up/email", {
    email,
    password: "correct-horse-1",
    name: "Op",
  });
  const user = db.user.find((u) => u.email === email);
  if (user) user.role = role;
  return cookieOf(res);
}

describe("two-factor rules on a real instance", () => {
  it("refuses /two-factor/enable for a consumer", async () => {
    const cookie = await signUp("consumer@example.test", "CONSULTEE");
    const res = await call(
      "/two-factor/enable",
      { password: "correct-horse-1" },
      cookie,
    );
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      code: "TWO_FACTOR_OPERATORS_ONLY",
    });
  });

  it("ends password-only sessions when an operator enrols", async () => {
    const enrolling = await signUp("op@example.test", "STAFF");
    const other = cookieOf(
      await call("/sign-in/email", {
        email: "op@example.test",
        password: "correct-horse-1",
      }),
    );
    const userId = db.user.find((u) => u.email === "op@example.test")?.id;
    expect(db.session.filter((s) => s.userId === userId)).toHaveLength(2);

    const enable = await call(
      "/two-factor/enable",
      { password: "correct-horse-1" },
      enrolling,
    );
    expect(enable.status).toBe(200);
    const { totpURI } = (await enable.json()) as { totpURI: string };
    const secret = new TextDecoder().decode(
      base32.decode(new URL(totpURI).searchParams.get("secret") ?? ""),
    );
    const code = await createOTP(secret, { period: 30, digits: 6 }).totp();

    const verify = await call("/two-factor/verify-totp", { code }, enrolling);
    expect(verify.status).toBe(200);

    const remaining = db.session.filter((s) => s.userId === userId);
    expect(remaining).toHaveLength(1);
    const otherToken = other.split("=")[1]?.split(".")[0];
    expect(remaining[0].token).not.toBe(otherToken);
  });
});
