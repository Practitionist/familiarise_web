/**
 * Breached-password rejection (BetterAuth `haveIBeenPwned`).
 *
 * Source-level for the wiring, like `session-token-exposure.test.ts`:
 * importing `lib/auth` would boot the whole BetterAuth instance, and Jest does
 * not transform BetterAuth's ESM build.
 */

import fs from "fs";
import path from "path";
import { humanizeAuthError } from "../../lib/labels/auth-errors";
const read = (...segments: string[]) =>
  fs.readFileSync(path.join(__dirname, "..", "..", ...segments), "utf8");

const authSrc = read("lib", "auth.ts");
const policySrc = read("lib", "auth", "password-policy.ts");

describe("haveIBeenPwned", () => {
  it("is registered as a BetterAuth plugin", () => {
    const plugins = authSrc.slice(authSrc.indexOf("plugins: ["));
    expect(plugins).toMatch(/^\s*breachedPasswordCheck,/m);
  });

  it("is the HIBP plugin, on every path where a user picks a password", () => {
    expect(policySrc).toMatch(
      /export const breachedPasswordCheck = haveIBeenPwned\(/,
    );
    // Admin create-user is left out: staff get a random password nobody sees.
    expect(policySrc).toMatch(
      /paths: \["\/sign-up\/email", "\/change-password", "\/reset-password"\]/,
    );
    expect(policySrc).not.toMatch(/\benabled\s*:/);
  });
});

describe("PASSWORD_COMPROMISED copy", () => {
  const error = { code: "PASSWORD_COMPROMISED", status: 400 };

  it("sits under the password field on sign-up", () => {
    const copy = humanizeAuthError("signup", error);
    expect(copy.field).toBe("password");
    expect(copy.description).toMatch(/data breach/i);
  });

  it("sits under the new-password field on reset", () => {
    expect(humanizeAuthError("reset", error).field).toBe("newPassword");
  });

  it("never echoes the server message", () => {
    const copy = humanizeAuthError("signup", {
      ...error,
      message: "The password you entered has been compromised.",
    });
    expect(copy.description).not.toMatch(/compromised/);
  });
});
