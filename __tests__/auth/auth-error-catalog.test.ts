/**
 * The productionisation guarantees of the error catalog, as executable claims.
 *
 * Three properties are asserted here that no amount of code review reliably
 * catches on a large union:
 *
 *   1. **Completeness.** Every `AuthErrorCode` resolves to copy. This is
 *      guaranteed by the type, and asserted again at runtime against the
 *      *serialised* set so a code that reaches the wire without matching
 *      (casing, whitespace) is still covered.
 *
 *   2. **No account enumeration.** A wrong password and an unknown address
 *      must both produce non-revealing copy. This is the assertion that stops
 *      a well-meaning future edit from turning the sign-in form into a
 *      customer-enumeration oracle.
 *
 *   3. **No raw server text.** No path may surface Better Auth's `message`.
 *      This is the regression that shipped `TypeError: Cannot read properties
 *      of undefined (reading 'metadata')` to a customer via
 *      `lib/sso/signin-with-toast.ts`.
 */

import {
  humanizeAuthError,
  formatRetryAfter,
  AUTH_ERROR_COPY,
  AUTH_ERROR_CODES,
  isAuthErrorCode,
  normalizeAuthErrorCode,
} from "../../lib/labels/auth-errors";

const ALL_FLOWS = ["signin", "signup", "forgot", "reset", "verify"] as const;

/** A representative hostile payload: every real Better Auth code, one per flow. */
const HOSTILE_MESSAGES = [
  "Invalid email or password",
  "TypeError: Cannot read properties of undefined (reading 'metadata')",
  "fetch failed",
  "[body.email] Invalid email",
  "ECONNREFUSED 10.0.0.4:5432",
  "<html><body>502 Bad Gateway</body></html>",
  "SSO provider with this providerId already exists",
];

describe("AUTH_ERROR_CODES", () => {
  it("normalises casing and whitespace", () => {
    expect(normalizeAuthErrorCode("  invalid_email_or_password ")).toBe(
      "INVALID_EMAIL_OR_PASSWORD",
    );
    expect(normalizeAuthErrorCode("INVALID_TOKEN")).toBe("INVALID_TOKEN");
  });

  it("rejects anything not in the closed set", () => {
    expect(normalizeAuthErrorCode("TOTALLY_MADE_UP")).toBeNull();
    expect(normalizeAuthErrorCode("")).toBeNull();
    expect(normalizeAuthErrorCode(null)).toBeNull();
    expect(normalizeAuthErrorCode(undefined)).toBeNull();
    // A SQL fragment must never be mistaken for a code.
    expect(normalizeAuthErrorCode("'; DROP TABLE users; --")).toBeNull();
  });

  it("isAuthErrorCode is consistent with normalize", () => {
    for (const code of Object.values(AUTH_ERROR_CODES)) {
      expect(isAuthErrorCode(code)).toBe(true);
      expect(isAuthErrorCode(code.toLowerCase())).toBe(true);
    }
    expect(isAuthErrorCode(123)).toBe(false);
    expect(isAuthErrorCode({})).toBe(false);
  });
});

describe("catalog completeness", () => {
  it("every declared code has copy", () => {
    // The type already enforces this; this catches a cast, an `any`, or a
    // future refactor that loosens `satisfies Record<...>`.
    const missing = Object.values(AUTH_ERROR_CODES).filter(
      (code) => !(AUTH_ERROR_COPY as Record<string, unknown>)[code],
    );
    expect(missing).toEqual([]);
  });

  it("every entry has non-empty copy and no leftover placeholder", () => {
    for (const [code, copy] of Object.entries(AUTH_ERROR_COPY)) {
      expect(typeof copy.title).toBe("string");
      expect(copy.title.length).toBeGreaterThan(0);
      expect(typeof copy.description).toBe("string");
      expect(copy.description.length).toBeGreaterThan(0);
      expect(`${code}${copy.title}${copy.description}`).not.toMatch(
        /TODO|FIXME|Lorem/i,
      );
    }
  });

  it("every code resolves to copy in every flow, whatever the message", () => {
    for (const flow of ALL_FLOWS) {
      for (const code of Object.values(AUTH_ERROR_CODES)) {
        for (const message of HOSTILE_MESSAGES) {
          const copy = humanizeAuthError(flow, {
            code,
            message,
            status: 400,
          });
          expect(typeof copy.title).toBe("string");
          expect(copy.title.length).toBeGreaterThan(0);
          expect(typeof copy.description).toBe("string");
          expect(copy.description.length).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe("no raw server text escapes", () => {
  it("a hostile message never reaches the copy, in any flow", () => {
    for (const flow of ALL_FLOWS) {
      for (const code of Object.values(AUTH_ERROR_CODES)) {
        for (const message of HOSTILE_MESSAGES) {
          const copy = humanizeAuthError(flow, { code, message, status: 400 });
          const rendered = `${copy.title} ${copy.description}`;
          expect(rendered).not.toMatch(/TypeError/i);
          expect(rendered).not.toMatch(/Cannot read properties/i);
          expect(rendered).not.toMatch(/fetch failed/i);
          expect(rendered).not.toMatch(/<html/i);
          expect(rendered).not.toMatch(/ECONNREFUSED/i);
          expect(rendered).not.toMatch(/\[body\./);
          expect(rendered).not.toMatch(/DROP TABLE/i);
        }
      }
    }
  });

  it("a code-less failure never renders the server message either", () => {
    for (const flow of ALL_FLOWS) {
      for (const message of HOSTILE_MESSAGES) {
        const copy = humanizeAuthError(flow, { message, status: 400 });
        expect(`${copy.title} ${copy.description}`).not.toMatch(/TypeError/i);
      }
    }
  });
});

describe("sign-in copy does not enumerate accounts", () => {
  it("the one sign-in failure code says nothing about whether the account exists", () => {
    // Better Auth answers a wrong password, an unknown address and an SSO-only
    // account with this one code; the copy must not undo that. (Its
    // CREDENTIAL_ACCOUNT_NOT_FOUND only comes from update-user, which needs a
    // session, so it is not a sign-in answer.)
    const copy = humanizeAuthError("signin", {
      code: "INVALID_EMAIL_OR_PASSWORD",
      status: 401,
    });
    expect(`${copy.title} ${copy.description}`).not.toMatch(
      /no account|not found|does not exist|no password|couldn't find/i,
    );
  });
});

describe("status fallbacks", () => {
  it("a code-less 401/403 is a policy rejection, not 'wrong password'", () => {
    // This is the deploy-preview `trustedOrigins` case that used to render
    // "Something went wrong on our side" for a correct password.
    for (const status of [401, 403]) {
      const copy = humanizeAuthError("signin", { status });
      expect(copy.action).toBe("retry");
      // Assert the two things that make this copy useful: it says the request
      // was stopped *before reaching the service* (so the customer does not go
      // hunting for a password problem that does not exist), and it names the
      // preview-deployment cause (which is what it actually is, in practice).
      expect(copy.description).toMatch(/stopped the request/i);
      expect(copy.description).toMatch(/security policy/i);
      expect(copy.description).toMatch(/preview deployment/i);
      // And it must not read as a credential problem.
      expect(`${copy.title} ${copy.description}`).not.toMatch(
        /password|sign-in failed/i,
      );
    }
  });

  it("429 carries a real wait when Retry-After is known", () => {
    const copy = humanizeAuthError(
      "signin",
      { status: 429 },
      {
        retryAfterSeconds: 731,
      },
    );
    expect(copy.description).toMatch(/13 minutes/);
  });

  it("the two-factor lockout 429 keeps its own copy", () => {
    const copy = humanizeAuthError("signin", {
      code: "ACCOUNT_TEMPORARILY_LOCKED",
      status: 429,
    });
    expect(copy.title).toBe("Too many wrong codes");
    expect(copy.description).toMatch(/15 minutes/);
  });

  it("a 5xx and a thrown fetch share the unreachable copy", () => {
    const five = humanizeAuthError("signin", { status: 503 });
    const thrown = humanizeAuthError("signin", { status: 0 });
    expect(five).toEqual(thrown);
  });
});

describe("formatRetryAfter", () => {
  it("reads as a duration, not a number of seconds", () => {
    expect(formatRetryAfter(1)).toBe("1 second");
    expect(formatRetryAfter(45)).toBe("45 seconds");
    expect(formatRetryAfter(60)).toBe("1 minute");
    expect(formatRetryAfter(731)).toBe("13 minutes");
    expect(formatRetryAfter(3600)).toBe("1 hour");
    expect(formatRetryAfter(7200)).toBe("2 hours");
    expect(formatRetryAfter(86400 * 3)).toBe("3 days");
  });

  it("rounds up so nobody is told to return before the lockout lifts", () => {
    // 9m30s must read as "10 minutes", not "9" — being told to come back
    // early is what produces the hammering a lockout exists to stop.
    expect(formatRetryAfter(570)).toBe("10 minutes");
  });

  it("degrades safely on nonsense", () => {
    expect(formatRetryAfter(0)).toBe("a moment");
    expect(formatRetryAfter(-5)).toBe("a moment");
    expect(formatRetryAfter(Number.NaN)).toBe("a moment");
    expect(formatRetryAfter(Number.POSITIVE_INFINITY)).toBe("a moment");
  });
});
