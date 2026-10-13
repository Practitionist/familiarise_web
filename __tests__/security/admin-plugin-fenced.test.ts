/**
 * The admin plugin's HTTP surface is fenced off (lib/auth.ts `disabledPaths`).
 * Its endpoints authorize against the plugin's own role map, so an open one
 * would let an operator ban, re-role, impersonate or set a password without
 * the back-office matrix, the 2FA gate or an OpsActionLog row.
 *
 * The expected list is read from the installed plugin, so an upgrade that
 * adds an endpoint fails here until it is fenced too. Source-level, like
 * session-token-exposure.test.ts: importing lib/auth boots BetterAuth.
 */

import fs from "fs";
import path from "path";

const root = path.join(__dirname, "..", "..");
const authSrc = fs.readFileSync(path.join(root, "lib", "auth.ts"), "utf8");
const pluginDir = path.join(
  root,
  "node_modules",
  "better-auth",
  "dist",
  "plugins",
  "admin",
);

function pluginEndpoints(): string[] {
  const found = new Set<string>();
  for (const file of fs.readdirSync(pluginDir)) {
    if (!file.endsWith(".mjs")) continue;
    const src = fs.readFileSync(path.join(pluginDir, file), "utf8");
    for (const m of src.matchAll(/"(\/admin\/[a-z-]+)"/g)) found.add(m[1]);
  }
  return [...found].sort();
}

describe("admin plugin HTTP surface", () => {
  const start = authSrc.indexOf("disabledPaths:");
  const block = authSrc.slice(start, authSrc.indexOf("]", start));
  const endpoints = pluginEndpoints();

  it("finds the plugin's endpoints", () => {
    expect(start).toBeGreaterThan(-1);
    expect(endpoints).toContain("/admin/impersonate-user");
    expect(endpoints.length).toBeGreaterThanOrEqual(15);
  });

  it("disables every admin endpoint over HTTP", () => {
    const open = endpoints.filter((p) => !block.includes(`"${p}"`));
    expect(open).toEqual([]);
  });

  it("has no client binding that would call them", () => {
    const clientSrc = fs.readFileSync(
      path.join(root, "lib", "auth-client.ts"),
      "utf8",
    );
    expect(clientSrc).not.toMatch(/adminClient/);
  });
});
describe("session and TOTP secret endpoints", () => {
  const start = authSrc.indexOf("disabledPaths:");
  const block = authSrc.slice(start, authSrc.indexOf("]", start));

  it.each([
    "/list-sessions",
    "/revoke-session",
    "/revoke-sessions",
    "/revoke-other-sessions",
    "/two-factor/get-totp-uri",
  ])("%s is disabled over HTTP", (p) => {
    expect(block).toContain(`"${p}"`);
  });
});
