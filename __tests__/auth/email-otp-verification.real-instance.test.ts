/**
 * @jest-environment node
 */

/**
 * The credential sign-up flow on a real BetterAuth instance (memory adapter)
 * with the production policy plugins and verification options: 6-digit email
 * OTP verification, an enumeration-safe duplicate sign-up, display-name and
 * 72-byte password rules, and a breached reset password that keeps the token.
 */

import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { emailOTP } from "better-auth/plugins";
import { corePolicy } from "../../lib/auth/core-policy";
import { breachedPasswordCheck } from "../../lib/auth/password-policy";
import { stripSessionToken } from "../../lib/auth/strip-session-token";

jest.mock("../../lib/observability/throttled-capture", () => ({
  captureThrottled: jest.fn(),
}));

const APP = "http://localhost:3000";
const PASSWORD = "correct-horse-battery-1";
const BREACHED = "breached-password-1";

const db = {
  user: [] as Record<string, unknown>[],
  session: [] as Record<string, unknown>[],
  account: [] as Record<string, unknown>[],
  verification: [] as Record<string, unknown>[],
};

const otps: { email: string; otp: string }[] = [];
const existingSignUps: string[] = [];
const verified: string[] = [];
const resetTokens: string[] = [];

const auth = betterAuth({
  secret: "test-secret-that-is-at-least-32-characters",
  baseURL: APP,
  database: memoryAdapter(db),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    maxPasswordLength: 72,
    revokeSessionsOnPasswordReset: true,
    onExistingUserSignUp: async ({ user }) => {
      existingSignUps.push(user.email);
    },
    sendResetPassword: async ({ token }) => {
      resetTokens.push(token);
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    sendOnSignIn: true,
    autoSignInAfterVerification: true,
    afterEmailVerification: async (user) => {
      verified.push(user.email);
    },
  },
  verification: { storeIdentifier: "hashed" },
  hooks: { after: stripSessionToken },
  databaseHooks: {
    user: {
      create: {
        // The insert that loses the User.email unique race to a concurrent sign-up.
        before: async (user) => {
          if (user.email === "race@example.test") {
            throw new Error(
              "Unique constraint failed on the fields: (`email`)",
            );
          }
        },
      },
    },
  },
  plugins: [
    breachedPasswordCheck,
    corePolicy,
    emailOTP({
      overrideDefaultEmailVerification: true,
      sendVerificationOnSignUp: true,
      otpLength: 6,
      expiresIn: 600,
      allowedAttempts: 5,
      storeOTP: "hashed",
      disableSignUp: true,
      sendVerificationOTP: async ({ email, otp }) => {
        otps.push({ email, otp });
      },
    }),
  ],
});

const call = (path: string, body: unknown, cookie?: string) =>
  auth.handler(
    new Request(`${APP}/api/auth${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: APP,
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
  );

const sessionCookie = (res: Response) =>
  (res.headers.get("set-cookie") ?? "")
    .split(/,(?=\s*[\w.-]+=)/)
    .map((c) => c.split(";")[0].trim())
    .filter((c) => c.includes("session_token="))
    .join("; ");

const lastOtp = (email: string) =>
  [...otps].reverse().find((o) => o.email === email)?.otp ?? "";

// The HIBP range API: BREACHED's SHA-1 suffix is "in the corpus".
beforeAll(() => {
  jest.spyOn(global, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    const { createHash } = await import("node:crypto");
    const sha1 = createHash("sha1")
      .update(BREACHED)
      .digest("hex")
      .toUpperCase();
    const body = url.endsWith(sha1.slice(0, 5)) ? `${sha1.slice(5)}:42\n` : "";
    return new Response(body, { status: 200 });
  });
});
afterAll(() => jest.restoreAllMocks());

const signUp = (email: string, name = "Asha Rao", password = PASSWORD) =>
  call("/sign-up/email", { email, password, name });

describe("email OTP verification", () => {
  it("issues no session at sign-up and verifies with the emailed code", async () => {
    const email = "new@example.test";
    const res = await signUp(email);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ token: null });
    expect(sessionCookie(res)).toBe("");
    expect(lastOtp(email)).toMatch(/^\d{6}$/);

    // Sign-in before verifying is refused, and (password proven) a fresh code is sent.
    const before = otps.length;
    const signIn = await call("/sign-in/email", { email, password: PASSWORD });
    expect(signIn.status).toBe(403);
    await expect(signIn.json()).resolves.toMatchObject({
      code: "EMAIL_NOT_VERIFIED",
    });
    expect(otps.length).toBe(before + 1);

    const code = lastOtp(email);
    const wrong = code === "000000" ? "111111" : "000000";
    const bad = await call("/email-otp/verify-email", { email, otp: wrong });
    expect(bad.status).toBe(400);
    await expect(bad.json()).resolves.toMatchObject({ code: "INVALID_OTP" });

    const ok = await call("/email-otp/verify-email", { email, otp: code });
    expect(ok.status).toBe(200);
    expect(sessionCookie(ok)).not.toBe("");
    expect(await ok.json()).not.toHaveProperty("token");
    expect(verified).toEqual([email]);
    expect(db.user.find((u) => u.email === email)?.emailVerified).toBe(true);

    // The code is single-use.
    const replay = await call("/email-otp/verify-email", { email, otp: code });
    expect(replay.status).toBe(400);
  });

  it("only sends email-verification codes", async () => {
    const res = await call("/email-otp/send-verification-otp", {
      email: "new@example.test",
      type: "sign-in",
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      code: "INVALID_OTP_TYPE",
    });
  });
});

describe("enumeration-safe sign-up", () => {
  it("answers a duplicate sign-up exactly like a new one and notifies the owner", async () => {
    const fresh = await signUp("parity-new@example.test");
    await signUp("parity-owner@example.test");
    const otpsBefore = otps.length;
    const duplicate = await signUp("parity-owner@example.test");

    expect(duplicate.status).toBe(fresh.status);
    const freshBody = (await fresh.json()) as { user: object };
    const dupBody = (await duplicate.json()) as { user: object };
    expect(Object.keys(dupBody).sort()).toEqual(Object.keys(freshBody).sort());
    expect(Object.keys(dupBody.user).sort()).toEqual(
      Object.keys(freshBody.user).sort(),
    );
    expect(existingSignUps).toContain("parity-owner@example.test");
    expect(otps.length).toBe(otpsBefore);
  });

  it("answers a sign-up that loses the unique-email race generically", async () => {
    // The winner's row lands between this sign-up's lookup and its insert.
    const now = new Date();
    db.user.push({
      id: "winner",
      email: "race@example.test",
      name: "Winner",
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    });
    const ctx = await auth.$context;
    jest
      .spyOn(ctx.internalAdapter, "findUserByEmail")
      .mockResolvedValueOnce(null);

    const res = await signUp("race@example.test");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      token: null,
      user: { email: "race@example.test", emailVerified: false },
    });
  });
});

describe("display name", () => {
  it.each([
    "Visit evil.example now",
    "Call 9876543210",
    "x".repeat(81),
    "Asha\u202eRao",
    "   ",
  ])("refuses %j", async (name) => {
    const res = await signUp(`name-${otps.length}@example.test`, name);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: "NAME_INVALID" });
  });

  it("stores the trimmed name", async () => {
    await signUp("trim@example.test", "  Asha Rao  ");
    expect(db.user.find((u) => u.email === "trim@example.test")?.name).toBe(
      "Asha Rao",
    );
  });
});

describe("password rules", () => {
  it("refuses a password over 72 bytes even when under 72 characters", async () => {
    const password = "é".repeat(37); // 37 characters, 74 bytes
    const res = await signUp("bytes@example.test", "Asha Rao", password);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      code: "PASSWORD_TOO_LONG",
    });
  });

  it("keeps the reset token usable after a breached new password", async () => {
    await signUp("reset@example.test");
    await call("/request-password-reset", {
      email: "reset@example.test",
      redirectTo: "/auth/reset-password",
    });
    const token = resetTokens.at(-1) ?? "";
    expect(token).not.toBe("");

    const breached = await call("/reset-password", {
      token,
      newPassword: BREACHED,
    });
    expect(breached.status).toBe(400);
    await expect(breached.json()).resolves.toMatchObject({
      code: "PASSWORD_COMPROMISED",
    });

    const retry = await call("/reset-password", {
      token,
      newPassword: "a-fresh-unbreached-password-9",
    });
    expect(retry.status).toBe(200);
  });
});
