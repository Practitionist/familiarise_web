/**
 * @jest-environment node
 */

/**
 * Session tokens never reach the browser in JSON (#1856, ADR 35).
 *
 * A session token is the cookie's value — a bearer credential for the
 * whole account. BetterAuth hands it out from `/list-sessions`, the admin
 * plugin's session endpoints, the `session` object of `/get-session`, and
 * the body of sign-in, sign-up and two-factor verify. Mostly source-level
 * checks, like `audit-1132-security.test.ts`: importing `lib/auth` would
 * boot the whole BetterAuth instance. The after-hook runs on a small real
 * instance instead.
 */

import fs from "fs";
import path from "path";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createAuthMiddleware } from "better-auth/api";
import { stripSessionToken } from "@/lib/auth/strip-session-token";

const authSrc = fs.readFileSync(
  path.join(__dirname, "..", "..", "lib", "auth.ts"),
  "utf8",
);

describe("session token exposure (#1856)", () => {
  it.each([
    "/list-sessions",
    "/admin/list-user-sessions",
    "/admin/revoke-user-session",
    "/admin/revoke-user-sessions",
    "/get-access-token",
    "/account-info",
    "/refresh-token",
    "/update-session",
  ])("disables %s over HTTP", (p) => {
    const start = authSrc.indexOf("disabledPaths:");
    const block = authSrc.slice(start, authSrc.indexOf("]", start));
    expect(start).toBeGreaterThan(-1);
    expect(block).toContain(`"${p}"`);
  });

  it("grants STAFF no session permissions", () => {
    const start = authSrc.indexOf("const staffAc");
    const block = authSrc.slice(start, authSrc.indexOf("});", start));
    expect(block.length).toBeGreaterThan(0);
    expect(block).not.toMatch(/\bsession\s*:/);
  });

  it("strips the token from the customSession payload", () => {
    expect(authSrc).toMatch(/session:\s*publicSession\(session\)/);
  });

  it("keeps the cookie cache off so revocation is immediate", () => {
    expect(authSrc).toMatch(/cookieCache:\s*\{\s*enabled:\s*false\s*\}/);
  });

  it("wires the after-hook that strips sign-in/sign-up tokens", () => {
    expect(authSrc).toMatch(/return stripSessionToken\(ctx\)/);
  });
});

describe("stripSessionToken on a real BetterAuth instance", () => {
  const APP = "http://localhost:3000";
  const auth = betterAuth({
    secret: "test-secret-that-is-at-least-32-characters",
    baseURL: APP,
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
    }),
    emailAndPassword: { enabled: true },
    hooks: { after: createAuthMiddleware(stripSessionToken) },
  });
  const post = (p: string, body: unknown) =>
    auth.handler(
      new Request(`${APP}/api/auth${p}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: APP },
        body: JSON.stringify(body),
      }),
    );
  const credentials = {
    email: "asha@example.test",
    password: "correct-horse-1",
  };

  it.each([
    ["/sign-up/email", { ...credentials, name: "Asha" }],
    ["/sign-in/email", credentials],
  ])(
    "%s answers without a token but still sets the cookie",
    async (p, body) => {
      const res = await post(p, body);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).not.toHaveProperty("token");
      expect(json.user.email).toBe(credentials.email);
      expect(res.headers.get("set-cookie")).toMatch(
        /better-auth\.session_token=/,
      );
    },
  );

  it("/change-password with revokeOtherSessions answers without a token", async () => {
    const signIn = await post("/sign-in/email", credentials);
    const cookie = (signIn.headers.get("set-cookie") ?? "").split(";")[0];
    const res = await auth.handler(
      new Request(`${APP}/api/auth/change-password`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: APP, cookie },
        body: JSON.stringify({
          currentPassword: credentials.password,
          newPassword: "correct-horse-2",
          revokeOtherSessions: true,
        }),
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).not.toHaveProperty("token");
    expect(res.headers.get("set-cookie")).toMatch(
      /better-auth\.session_token=/,
    );
  });
});
