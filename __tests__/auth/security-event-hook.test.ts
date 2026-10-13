/**
 * @jest-environment node
 */

/**
 * notifySecurityEvents on a real BetterAuth instance (memory adapter): which
 * endpoint results become which security notice, including the request that
 * locks two-factor sign-in. The sender and template are checked directly.
 */

const mockSendSecurityEventEmail = jest.fn();
const mockDeliver = jest.fn();
const mockFindMany = jest.fn();
const mockCaptureException = jest.fn();

jest.mock("../../lib/auth/security-email", () => ({
  sendSecurityEventEmail: (...args: unknown[]) =>
    mockSendSecurityEventEmail(...args),
}));
jest.mock("../../lib/email/deliver", () => ({
  deliver: (...args: unknown[]) => mockDeliver(...args),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findMany: (...args: unknown[]) => mockFindMany(...args) },
  },
}));
jest.mock("../../lib/email/render", () => ({
  renderEmail: jest.fn(async (element: unknown) => {
    const { renderToStaticMarkup } = jest.requireActual("react-dom/server");
    return { html: renderToStaticMarkup(element), text: "" };
  }),
}));
jest.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
} from "better-auth/api";
import { twoFactor } from "better-auth/plugins";
import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import { z } from "zod";
import SecurityEventEmail, {
  securityEventSubject,
  type SecurityEvent,
} from "@/emails/auth/SecurityEventEmail";
import { notifySecurityEvents } from "@/lib/auth/security-event-hook";
import { sendSecurityNoticeEmail } from "@/lib/email/senders/security";

const APP = "http://localhost:3000";
const PASSWORD = "correct-horse-1";
const db = {
  user: [] as Record<string, unknown>[],
  session: [] as Record<string, unknown>[],
  account: [] as Record<string, unknown>[],
  verification: [] as Record<string, unknown>[],
  twoFactor: [] as Record<string, unknown>[],
};

// Stands in for @better-auth/passkey's registration endpoint, whose real
// ceremony needs an authenticator; the hook only reads its path and result.
const fakePasskey = {
  id: "fake-passkey",
  endpoints: {
    verifyPasskeyRegistration: createAuthEndpoint(
      "/passkey/verify-registration",
      {
        method: "POST",
        body: z.object({
          userId: z.string(),
          name: z.string().optional(),
          fail: z.boolean().optional(),
        }),
      },
      async (ctx) => {
        if (ctx.body.fail) {
          throw new APIError("BAD_REQUEST", { code: "FAILED" });
        }
        return ctx.json({
          id: "pk_1",
          userId: ctx.body.userId,
          name: ctx.body.name ?? null,
        });
      },
    ),
  },
};

const auth = betterAuth({
  secret: "test-secret-that-is-at-least-32-characters",
  baseURL: APP,
  database: memoryAdapter(db),
  emailAndPassword: { enabled: true },
  hooks: { after: createAuthMiddleware(notifySecurityEvents) },
  plugins: [
    twoFactor({
      issuer: "Familiarise",
      backupCodeOptions: {
        amount: 10,
        length: 10,
        storeBackupCodes: "encrypted",
      },
      accountLockout: { maxFailedAttempts: 2, durationSeconds: 900 },
    }),
    fakePasskey,
  ],
});

const jar = new Map<string, string>();

function keep(res: Response) {
  for (const raw of res.headers.getSetCookie()) {
    const [pair] = raw.split(";");
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (value === "" || /max-age=0/i.test(raw)) jar.delete(name);
    else jar.set(name, value);
  }
  return res;
}

async function call(path: string, body: unknown) {
  const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  return keep(
    await auth.handler(
      new Request(`${APP}/api/auth${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: APP,
          ...(cookie ? { cookie } : {}),
        },
        body: JSON.stringify(body),
      }),
    ),
  );
}

const EMAIL = "op@example.test";
let userId = "";
let totpSecret = "";
let backupCodes: string[] = [];
let setupCalls = -1;

async function signInPendingTwoFactor() {
  jar.clear();
  const res = await call("/sign-in/email", {
    email: EMAIL,
    password: PASSWORD,
  });
  expect(res.status).toBe(200);
  await expect(res.json()).resolves.toMatchObject({ twoFactorRedirect: true });
}

beforeAll(async () => {
  await call("/sign-up/email", {
    email: EMAIL,
    password: PASSWORD,
    name: "Op",
  });
  userId = String(db.user.find((u) => u.email === EMAIL)?.id);
  const enable = await call("/two-factor/enable", { password: PASSWORD });
  const enabled = z
    .object({ totpURI: z.string(), backupCodes: z.array(z.string()) })
    .parse(await enable.json());
  totpSecret = new TextDecoder().decode(
    base32.decode(new URL(enabled.totpURI).searchParams.get("secret") ?? ""),
  );
  const code = await createOTP(totpSecret, { period: 30, digits: 6 }).totp();
  const verify = await call("/two-factor/verify-totp", { code });
  if (verify.status !== 200) throw new Error("TOTP enrolment failed");
  setupCalls = mockSendSecurityEventEmail.mock.calls.length;
});

beforeEach(() => {
  mockSendSecurityEventEmail.mockResolvedValue(undefined);
});

const expectedUser = () =>
  expect.objectContaining({ id: userId, email: EMAIL });

describe("notifySecurityEvents", () => {
  it("sends nothing for sign-up or authenticator enrolment", () => {
    expect(setupCalls).toBe(0);
  });

  it("passkey registration: passkey-added with the passkey name", async () => {
    const res = await call("/passkey/verify-registration", {
      userId,
      name: "YubiKey",
    });
    expect(res.status).toBe(200);
    expect(mockSendSecurityEventEmail).toHaveBeenCalledTimes(1);
    expect(mockSendSecurityEventEmail).toHaveBeenCalledWith(expectedUser(), {
      kind: "passkey-added",
      passkeyName: "YubiKey",
    });
  });

  it("failed passkey registration sends nothing", async () => {
    const res = await call("/passkey/verify-registration", {
      userId,
      fail: true,
    });
    expect(res.status).toBe(400);
    expect(mockSendSecurityEventEmail).not.toHaveBeenCalled();
  });

  it("regenerating backup codes: backup-codes-regenerated", async () => {
    const res = await call("/two-factor/generate-backup-codes", {
      password: PASSWORD,
    });
    expect(res.status).toBe(200);
    backupCodes = z
      .object({ backupCodes: z.array(z.string()) })
      .parse(await res.json()).backupCodes;
    expect(mockSendSecurityEventEmail).toHaveBeenCalledWith(expectedUser(), {
      kind: "backup-codes-regenerated",
    });
  });

  it("signing in with a backup code: backup-code-used with the count left", async () => {
    await signInPendingTwoFactor();
    const res = await call("/two-factor/verify-backup-code", {
      code: backupCodes[0],
    });
    expect(res.status).toBe(200);
    expect(mockSendSecurityEventEmail).toHaveBeenCalledTimes(1);
    expect(mockSendSecurityEventEmail).toHaveBeenCalledWith(expectedUser(), {
      kind: "backup-code-used",
      remaining: 9,
    });
  });

  it("the failure that locks two-factor sign-in sends two-factor-locked once", async () => {
    await signInPendingTwoFactor();
    const first = await call("/two-factor/verify-totp", { code: "000000" });
    expect(first.status).toBe(401);
    expect(mockSendSecurityEventEmail).not.toHaveBeenCalled();

    const second = await call("/two-factor/verify-backup-code", {
      code: "wrong-code",
    });
    expect(second.status).toBe(401);
    expect(mockSendSecurityEventEmail).toHaveBeenCalledTimes(1);
    const [user, event] = mockSendSecurityEventEmail.mock.calls[0];
    expect(user).toEqual(expectedUser());
    expect(event.kind).toBe("two-factor-locked");
    expect(event.lockedUntil.getTime()).toBeGreaterThan(Date.now());

    const whileLocked = await call("/two-factor/verify-totp", {
      code: "000000",
    });
    expect(whileLocked.status).toBe(429);
    expect(mockSendSecurityEventEmail).toHaveBeenCalledTimes(1);
  });

  it("never throws: a send failure is reported once at warning", async () => {
    mockSendSecurityEventEmail.mockRejectedValue(new Error("boom"));
    jest.spyOn(console, "error").mockImplementation(() => {});
    const res = await call("/passkey/verify-registration", { userId });
    expect(res.status).toBe(200);
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    expect(mockCaptureException.mock.calls[0][1]).toMatchObject({
      level: "warning",
      tags: { subsystem: "auth", op: "security-event-hook" },
    });
  });
});

describe("security notice email", () => {
  const events: SecurityEvent[] = [
    { kind: "authenticator-added" },
    { kind: "passkey-added", passkeyName: "Laptop" },
    { kind: "backup-codes-regenerated" },
    { kind: "backup-code-used", remaining: 2 },
    { kind: "two-factor-reset-by-admin" },
    {
      kind: "two-factor-locked",
      lockedUntil: new Date("2026-10-09T10:15:00Z"),
    },
  ];

  it.each(events)(
    "$kind: says what happened, when, and who to contact",
    (event) => {
      const html = renderToStaticMarkup(
        React.createElement(SecurityEventEmail, {
          recipientName: "Asha",
          event,
          occurredAtText: "Fri, 9 Oct 2026 at 3:30 PM IST",
          lockedUntilText: "Fri, 9 Oct 2026 at 3:45 PM IST",
          supportEmail: "support@example.test",
        }),
      );
      expect(html).toContain(securityEventSubject(event));
      expect(html).toContain("Fri, 9 Oct 2026 at 3:30 PM IST");
      expect(html).toContain("contact support at");
      expect(html).toContain("your administrator immediately");
      expect(html).toContain("This is a required account notice");
    },
  );

  it("names the passkey, urges regenerating low backup codes, gives the lock end", () => {
    const render = (event: SecurityEvent) =>
      renderToStaticMarkup(
        React.createElement(SecurityEventEmail, {
          recipientName: "Asha",
          event,
          occurredAtText: "now",
          lockedUntilText: "3:45 PM IST",
          supportEmail: "support@example.test",
        }),
      );
    expect(render(events[1])).toContain("Laptop");
    expect(render(events[3])).toContain("2 backup codes left");
    expect(render(events[3])).toContain("Generate a new set of backup codes");
    expect(render({ kind: "backup-code-used", remaining: 4 })).not.toContain(
      "Generate a new set",
    );
    expect(render(events[4])).toContain("setup link");
    expect(render(events[5])).toContain("locked until 3:45 PM IST");
  });

  it("sender: security@, required notice, delivered to the user's address", async () => {
    mockFindMany.mockResolvedValue([
      {
        id: userId,
        email: EMAIL,
        name: "Op",
        timezone: "Asia/Kolkata",
        notificationPreferences: null,
      },
    ]);
    mockDeliver.mockResolvedValue({ success: true, data: {} });
    const result = await sendSecurityNoticeEmail({
      userId,
      event: {
        kind: "two-factor-locked",
        lockedUntil: new Date("2026-10-09T10:15:00Z"),
      },
      occurredAt: new Date("2026-10-09T10:00:00Z"),
    });
    expect(result.sent).toBe(1);
    const [message, emailType, opts] = mockDeliver.mock.calls[0];
    expect(emailType).toBe("SECURITY_EVENT");
    expect(opts).toMatchObject({ entityRef: `user:${userId}` });
    expect(message).toMatchObject({
      to: EMAIL,
      subject: "Two-factor sign-in is locked on your Familiarise account",
    });
    expect(message.from).toContain("<security@");
    expect(message.html).toContain("3:45 PM");
    expect(message.html).toContain("3:30 PM");
  });

  it("wrapper never throws when the send fails", async () => {
    const { sendSecurityEventEmail } = jest.requireActual<
      typeof import("../../lib/auth/security-email")
    >("../../lib/auth/security-email");
    mockFindMany.mockRejectedValue(new Error("db down"));
    jest.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      sendSecurityEventEmail(
        { id: userId, email: EMAIL },
        { kind: "authenticator-added" },
      ),
    ).resolves.toBeUndefined();
    expect(mockDeliver).not.toHaveBeenCalled();
  });
});
