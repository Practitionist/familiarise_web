/**
 * @jest-environment node
 */

/**
 * The link key is derived from BETTER_AUTH_SECRET: tokens round-trip, bind
 * their purpose, fail under another secret, and a missing secret makes the
 * confirmation sender fail softly instead of throwing.
 */

import { createHmac } from "node:crypto";

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { failedEmail: { create: jest.fn() } },
}));

const SECRET = "test-auth-secret-at-least-32-chars";

describe("link signing under the derived auth key", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv, BETTER_AUTH_SECRET: SECRET };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("round-trips, separates purposes and fails under another secret", async () => {
    const tokens = await import("../../lib/newsletter/tokens");
    const confirm = tokens.generateConfirmToken("a@b.test", 1_000);
    const unsubscribe = tokens.generateUnsubscribeToken("A@B.test");

    expect(tokens.verifyConfirmToken("a@b.test", confirm, 1_000, 2_000)).toBe(
      true,
    );
    expect(tokens.verifyUnsubscribeToken("a@b.test", unsubscribe)).toBe(true);
    expect(tokens.verifyUnsubscribeToken("a@b.test", confirm)).toBe(false);

    process.env.BETTER_AUTH_SECRET = "another-auth-secret-of-enough-length";
    expect(tokens.verifyUnsubscribeToken("a@b.test", unsubscribe)).toBe(false);
  });

  it("signs with a derived key, never the raw secret", async () => {
    const { deriveAuthKey, signToken } =
      await import("../../lib/auth/link-signing");
    const raw = createHmac("sha256", SECRET)
      .update("unsubscribe|a@b.test|0")
      .digest("hex");

    expect(
      deriveAuthKey("familiarise/link-signing/v1")?.toString("hex"),
    ).not.toBe(Buffer.from(SECRET).toString("hex"));
    expect(signToken("unsubscribe", "a@b.test", 0)).not.toBe(raw);
  });

  it("cannot sign without a usable secret, and the sender fails softly", async () => {
    delete process.env.BETTER_AUTH_SECRET;
    process.env.RESEND_API_KEY = "re_test_key";
    const log = jest.spyOn(console, "error").mockImplementation(() => {});

    const { canSignLinks } = await import("../../lib/auth/link-signing");
    const { sendNewsletterConfirmEmail } = await import("../../lib/email");

    expect(canSignLinks()).toBe(false);
    await expect(
      sendNewsletterConfirmEmail({
        email: "reader@example.com",
        issuedAt: Date.now(),
      }),
    ).resolves.toMatchObject({ success: false });
    log.mockRestore();
  });

  it("never prints a live confirmation link outside development", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    delete process.env.RESEND_API_KEY;
    const log = jest.spyOn(console, "log").mockImplementation(() => {});
    const { sendNewsletterConfirmEmail } = await import("../../lib/email");

    await sendNewsletterConfirmEmail({
      email: "reader@example.com",
      issuedAt: Date.now(),
    });

    // The link is a bearer token: printing it would let anyone with log access confirm the address.
    const printed = log.mock.calls.flat().join(" ");
    expect(printed).not.toContain("token=");
    log.mockRestore();
  });
});
