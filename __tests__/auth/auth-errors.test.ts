/**
 * The auth error mapper is keyed on Better Auth's codes, not its message
 * text. The regression that motivated it: a wrong password answers
 * INVALID_EMAIL_OR_PASSWORD / "Invalid email or password", which the old
 * string match read as a malformed address.
 */
import {
  humanizeAuthError,
  isPasskeyCancellation,
} from "../../lib/labels/auth-errors";

describe("humanizeAuthError", () => {
  it("a wrong password is never reported as a bad email address", () => {
    const copy = humanizeAuthError("signin", {
      code: "INVALID_EMAIL_OR_PASSWORD",
      message: "Invalid email or password",
      status: 401,
    });
    expect(copy.field).toBe("password");
    expect(copy.description).not.toMatch(/valid email address/i);
    expect(copy.title).toMatch(/don't match/);
  });

  it("an unknown address on sign-in reads the same as a wrong password", () => {
    // The server answers both with the same code on purpose; the copy must
    // not undo that by hinting the account does not exist.
    const copy = humanizeAuthError("signin", {
      code: "INVALID_EMAIL_OR_PASSWORD",
      status: 401,
    });
    expect(copy.description).not.toMatch(/no account|not found/i);
  });

  it.each([
    ["INVALID_EMAIL", "email"],
    ["PASSWORD_TOO_SHORT", "password"],
    ["PASSWORD_TOO_LONG", "password"],
    ["USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL", "email"],
  ] as const)("sign-up %s lands under the %s field", (code, field) => {
    expect(humanizeAuthError("signup", { code, status: 400 }).field).toBe(
      field,
    );
  });

  it("EMAIL_NOT_VERIFIED switches the page into its resend state", () => {
    expect(
      humanizeAuthError("signin", { code: "EMAIL_NOT_VERIFIED", status: 403 })
        .needsVerification,
    ).toBe(true);
  });

  it("a reset link's INVALID_TOKEN says the link is spent or expired", () => {
    const copy = humanizeAuthError("reset", { code: "INVALID_TOKEN" });
    expect(copy.description).toMatch(/30 minutes/);
    expect(copy.description).toMatch(/Request a new one/);
  });

  it("zod validation errors are read by field, not echoed", () => {
    const copy = humanizeAuthError("signin", {
      code: "VALIDATION_ERROR",
      message: "[body.email] Invalid email",
      status: 400,
    });
    expect(copy.field).toBe("email");
    expect(copy.description).not.toMatch(/\[body/);
  });

  it("the limiter's 429 and a dead upstream get their own sentences", () => {
    expect(
      humanizeAuthError("signin", { code: "RATE_LIMITED", status: 429 }).title,
    ).toMatch(/Too many attempts/);
    expect(humanizeAuthError("forgot", { status: 503 }).title).toMatch(
      /couldn't reach/,
    );
    expect(humanizeAuthError("forgot", { status: 0 }).title).toMatch(
      /couldn't reach/,
    );
  });

  it("an unknown URL code with no status is not a network failure", () => {
    expect(humanizeAuthError("reset", { code: "WHATEVER" }).title).not.toMatch(
      /couldn't reach/,
    );
  });

  it("an unknown 4xx never leaks the raw server message", () => {
    const copy = humanizeAuthError("signup", {
      code: "FIELD_NOT_ALLOWED",
      message: "Field not allowed to be set",
      status: 400,
    });
    expect(copy.description).not.toMatch(/Field not allowed/);
  });

  it.each([
    ["TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE", 400, "sign-in"],
    ["INVALID_TWO_FACTOR_COOKIE", 401, "sign-in"],
    ["REAUTH_REQUIRED", 403, "retry"],
    ["PASSKEY_USER_VERIFICATION_REQUIRED", 401, "retry"],
  ] as const)(
    "%s has its own copy, not the status fallback",
    (code, status, action) => {
      const copy = humanizeAuthError("signin", { code, status });
      expect(copy.action).toBe(action);
      expect(copy.title).not.toMatch(/blocked|Couldn't sign you in/);
    },
  );

  it("a passkey refused for a non-operator says so politely", () => {
    const copy = humanizeAuthError("signin", {
      code: "PASSKEY_OPERATORS_ONLY",
      status: 403,
    });
    expect(copy.title).toMatch(/staff/i);
  });
});

describe("isPasskeyCancellation", () => {
  it("treats a dismissed browser prompt as silent, and real failures as not", () => {
    expect(isPasskeyCancellation("AUTH_CANCELLED")).toBe(true);
    expect(isPasskeyCancellation("ERROR_CEREMONY_ABORTED")).toBe(true);
    expect(isPasskeyCancellation("PASSKEY_OPERATORS_ONLY")).toBe(false);
    expect(isPasskeyCancellation(undefined)).toBe(false);
  });
});
