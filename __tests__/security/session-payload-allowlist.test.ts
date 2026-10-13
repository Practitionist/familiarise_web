/**
 * Session payload allowlist (#1856, ADR 35).
 *
 * A session TOKEN is a bearer credential for the whole account, and
 * BetterAuth's `listSessions` returns the raw token per device (1.7.7).
 * Every session list in this app — the user's own,
 * the staff support view — reads through SESSION_PUBLIC_SELECT instead.
 * Adding `token` (or any new column) to the select or to the mapper
 * output fails this suite, the same tripwire ADR 20 sets for org
 * content fields in `org-scope-payload-allowlist.test.ts`.
 */

import {
  SESSION_PUBLIC_SELECT,
  toPublicSession,
  type SessionPublicRow,
} from "../../lib/auth/session-select";

describe("session payload allowlist (#1856)", () => {
  it("selects exactly the public fields — never token", () => {
    expect(Object.keys(SESSION_PUBLIC_SELECT).sort()).toEqual(
      [
        "createdAt",
        "expiresAt",
        "id",
        "ipAddress",
        "updatedAt",
        "userAgent",
      ].sort(),
    );
    expect(SESSION_PUBLIC_SELECT).not.toHaveProperty("token");
  });

  it("emits exactly the public shape — no token, no raw userAgent", () => {
    const row = {
      id: "sess_1",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-02T00:00:00Z"),
      expiresAt: new Date("2026-02-01T00:00:00Z"),
      ipAddress: "1.2.3.4",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    } satisfies SessionPublicRow;

    const out = toPublicSession(row, "sess_1");

    expect(Object.keys(out).sort()).toEqual(
      [
        "createdAt",
        "expiresAt",
        "id",
        "ipAddress",
        "isCurrent",
        "label",
        "lastSeenAt",
      ].sort(),
    );
    expect(out).not.toHaveProperty("token");
    expect(out).not.toHaveProperty("userAgent");
    expect(out.label).toBe("Chrome on Windows");
    expect(out.isCurrent).toBe(true);
    // "Last active" is BetterAuth's own refresh stamp.
    expect(out.lastSeenAt).toEqual(row.updatedAt);
  });

  it("marks foreign sessions", () => {
    const row = {
      id: "sess_2",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-02T00:00:00Z"),
      expiresAt: new Date("2026-02-01T00:00:00Z"),
      ipAddress: null,
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    } satisfies SessionPublicRow;

    const out = toPublicSession(row, "sess_1");

    expect(out.label).toBe("Safari on macOS");
    expect(out.isCurrent).toBe(false);
  });

  it("omits isCurrent for operator views (no caller session to compare)", () => {
    const row = {
      id: "sess_3",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-02T00:00:00Z"),
      expiresAt: new Date("2026-02-01T00:00:00Z"),
      ipAddress: null,
      userAgent: null,
    } satisfies SessionPublicRow;

    expect(toPublicSession(row).isCurrent).toBe(false);
  });
});
