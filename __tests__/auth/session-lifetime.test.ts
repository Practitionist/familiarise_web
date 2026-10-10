/**
 * @jest-environment node
 */

/**
 * Session lifetime policy (lib/auth/session-lifetime.ts), as the session
 * create/update hooks in lib/auth.ts apply it: operators 12h absolute from
 * the original sign-in plus 2h idle, unenrolled operators 1h, SSO sessions
 * for an enforced domain 24h, consumers BetterAuth's sliding default.
 */
import {
  authenticationStart,
  cappedSessionFields,
  OPERATOR_IDLE_TIMEOUT_MS,
  OPERATOR_SESSION_MAX_AGE_MS,
  refreshSessionLifetime,
  sessionMaxAgeMs,
  SSO_SESSION_MAX_AGE_MS,
  UNENROLLED_OPERATOR_SESSION_MAX_AGE_MS,
} from "../../lib/auth/session-lifetime";

const HOUR = 60 * 60 * 1000;
const T0 = new Date("2026-10-01T00:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const thirtyDaysFrom = (d: Date) => new Date(d.getTime() + 30 * 24 * HOUR);

const enrolled = { role: "STAFF", twoFactorEnabled: true };
const unenrolled = { role: "ADMIN", twoFactorEnabled: false };
const consumer = { role: "CONSULTEE", twoFactorEnabled: false };

describe("sessionMaxAgeMs", () => {
  it("caps operators by enrolment, SSO-enforced sign-ins at 24h, nobody else", () => {
    expect(sessionMaxAgeMs(enrolled, { ssoEnforced: false })).toBe(12 * HOUR);
    expect(sessionMaxAgeMs(unenrolled, { ssoEnforced: false })).toBe(HOUR);
    expect(sessionMaxAgeMs(consumer, { ssoEnforced: true })).toBe(24 * HOUR);
    expect(sessionMaxAgeMs(consumer, { ssoEnforced: false })).toBeNull();
    expect(OPERATOR_SESSION_MAX_AGE_MS).toBe(12 * HOUR);
    expect(UNENROLLED_OPERATOR_SESSION_MAX_AGE_MS).toBe(HOUR);
    expect(SSO_SESSION_MAX_AGE_MS).toBe(24 * HOUR);
    expect(OPERATOR_IDLE_TIMEOUT_MS).toBe(2 * HOUR);
  });
});

describe("authenticationStart — the cap runs from the original sign-in", () => {
  const previous = { userId: "u1", createdAt: T0 };
  const now = at(5 * HOUR);

  it.each([
    "/change-password",
    "/two-factor/verify-totp",
    "/two-factor/verify-backup-code",
  ])("keeps the replaced session's start on %s", (path) => {
    expect(authenticationStart(path, "u1", previous, now)).toEqual(T0);
  });

  it("starts fresh on a real sign-in, for another user, or with no session", () => {
    expect(authenticationStart("/sign-in/email", "u1", previous, now)).toBe(
      now,
    );
    expect(authenticationStart("/change-password", "u2", previous, now)).toBe(
      now,
    );
    expect(
      authenticationStart("/two-factor/verify-totp", "u1", null, now),
    ).toBe(now);
  });

  it("never moves the start into the future", () => {
    const future = { userId: "u1", createdAt: at(9 * HOUR) };
    expect(authenticationStart("/change-password", "u1", future, now)).toBe(
      now,
    );
  });
});

describe("cappedSessionFields", () => {
  it("pulls a 30-day expiry back to start + cap and stamps the start", () => {
    const start = at(-3 * HOUR);
    expect(
      cappedSessionFields(
        thirtyDaysFrom(T0),
        start,
        OPERATOR_SESSION_MAX_AGE_MS,
      ),
    ).toEqual({ createdAt: start, expiresAt: at(9 * HOUR) });
  });

  it("keeps an expiry already inside the cap", () => {
    const early = at(HOUR / 2);
    expect(cappedSessionFields(early, T0, OPERATOR_SESSION_MAX_AGE_MS)).toEqual(
      { createdAt: T0, expiresAt: early },
    );
  });
});

describe("refreshSessionLifetime", () => {
  const operatorRow = (updatedAt: Date) => ({
    createdAt: T0,
    updatedAt,
    expiresAt: at(12 * HOUR),
  });

  it("clamps an operator refresh to 12h after the original sign-in", () => {
    const now = at(3 * HOUR);
    expect(
      refreshSessionLifetime(
        enrolled,
        operatorRow(at(2.5 * HOUR)),
        thirtyDaysFrom(now),
        now,
      ),
    ).toEqual({ kind: "keep", expiresAt: at(12 * HOUR) });
  });

  it("ends an operator session past its 12h cap however active", () => {
    const now = at(12 * HOUR + 1);
    expect(
      refreshSessionLifetime(
        enrolled,
        operatorRow(at(12 * HOUR)),
        thirtyDaysFrom(now),
        now,
      ),
    ).toEqual({ kind: "end" });
  });

  it("ends an operator session idle for 2h", () => {
    const now = at(4 * HOUR);
    expect(
      refreshSessionLifetime(
        enrolled,
        operatorRow(at(2 * HOUR)),
        thirtyDaysFrom(now),
        now,
      ),
    ).toEqual({ kind: "end" });
    expect(
      refreshSessionLifetime(
        enrolled,
        operatorRow(at(2 * HOUR + 1)),
        thirtyDaysFrom(now),
        now,
      ).kind,
    ).toBe("keep");
  });

  it("ends an unenrolled operator session after 1h", () => {
    const row = {
      createdAt: T0,
      updatedAt: at(50 * 60 * 1000),
      expiresAt: at(HOUR),
    };
    expect(
      refreshSessionLifetime(
        unenrolled,
        row,
        thirtyDaysFrom(at(HOUR)),
        at(HOUR),
      ),
    ).toEqual({ kind: "end" });
    expect(
      refreshSessionLifetime(
        unenrolled,
        row,
        thirtyDaysFrom(at(HOUR / 2)),
        at(HOUR / 2),
      ),
    ).toEqual({ kind: "keep", expiresAt: at(HOUR) });
  });

  it("keeps an SSO-capped row inside 24h and ends it after", () => {
    const row = { createdAt: T0, updatedAt: T0, expiresAt: at(24 * HOUR) };
    expect(
      refreshSessionLifetime(consumer, row, thirtyDaysFrom(at(HOUR)), at(HOUR)),
    ).toEqual({ kind: "keep", expiresAt: at(24 * HOUR) });
    expect(
      refreshSessionLifetime(
        consumer,
        row,
        thirtyDaysFrom(at(24 * HOUR)),
        at(24 * HOUR),
      ),
    ).toEqual({ kind: "end" });
  });

  it("leaves a consumer's 30-day sliding refresh untouched", () => {
    const row = {
      createdAt: T0,
      updatedAt: T0,
      expiresAt: thirtyDaysFrom(T0),
    };
    const now = at(48 * HOUR);
    expect(
      refreshSessionLifetime(consumer, row, thirtyDaysFrom(now), now),
    ).toEqual({ kind: "keep" });
  });

  it("writes no clamp when the refreshed expiry is already inside the cap", () => {
    const now = at(HOUR);
    expect(
      refreshSessionLifetime(enrolled, operatorRow(now), at(6 * HOUR), now),
    ).toEqual({ kind: "keep" });
  });
});
