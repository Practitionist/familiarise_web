/**
 * Session tokens never reach the browser in JSON (#1856, ADR 35).
 *
 * A session token is the cookie's value — a bearer credential for the
 * whole account. BetterAuth hands it out from `/list-sessions`, the admin
 * plugin's session endpoints, and the `session` object of `/get-session`.
 * Source-level checks, like `audit-1132-security.test.ts`: importing
 * `lib/auth` would boot the whole BetterAuth instance.
 */

import fs from "fs";
import path from "path";

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
    expect(authSrc).toMatch(/session:\s*sessionWithoutToken\(session\)/);
  });

  it("keeps the cookie cache off so revocation is immediate", () => {
    expect(authSrc).toMatch(/cookieCache:\s*\{\s*enabled:\s*false\s*\}/);
  });
});
