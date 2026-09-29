/**
 * @jest-environment node
 */

/**
 * `lib/auth/sign-in-attempt-hooks.ts` — the disclosure probe's two failure
 * shapes, and the one thing row 19 asks for: the swallowed one is *marked*, the
 * genuine one is not.
 *
 * The module is reached through the after hook because `describeAccount` is
 * private to it, and the after hook is the only caller — which is the point: the
 * probe cannot run on a path the lockout counter does not, and disclosure is
 * gated behind `DISCLOSURE_UNLOCK_AFTER` precisely so it is not.
 */

const recordSignInFailure = jest.fn();
const clearSignInAttempts = jest.fn();
const readSignInAttempt = jest.fn();
const classifyAccountState = jest.fn();
jest.mock("../../lib/auth/attempts", () => ({
  __esModule: true,
  recordSignInFailure: (...a: unknown[]) => recordSignInFailure(...a),
  clearSignInAttempts: (...a: unknown[]) => clearSignInAttempts(...a),
  readSignInAttempt: (...a: unknown[]) => readSignInAttempt(...a),
  classifyAccountState: (...a: unknown[]) => classifyAccountState(...a),
  DISCLOSURE_UNLOCK_AFTER: 3,
}));

const lookupEnforcedOrg = jest.fn();
jest.mock("../../lib/sso/enforce-session", () => ({
  __esModule: true,
  lookupEnforcedOrg: (...a: unknown[]) => lookupEnforcedOrg(...a),
}));

const userFindUnique = jest.fn();
const accountFindFirst = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findUnique: (...a: unknown[]) => userFindUnique(...a) },
    account: { findFirst: (...a: unknown[]) => accountFindFirst(...a) },
  },
}));

const captureThrottled = jest.fn();
jest.mock("../../lib/observability/throttled-capture", () => ({
  __esModule: true,
  captureThrottled: (...a: unknown[]) => captureThrottled(...a),
}));

/**
 * `better-auth/api` is ESM-only and this jest config does not transform
 * node_modules, so the two symbols the hook uses are stubbed: `createAuthMiddleware`
 * (pass the context straight through instead of rebuilding it) and `APIError`
 * (the hook's only interaction is `instanceof` plus a `body.code` read and a
 * throw in the lockout branch, none of which is better-auth's logic). What is
 * under test here is *our* decision about what to report and what to mark, so
 * stubbing the plumbing is honest — and a test that loaded the real module
 * would be testing better-call's context builder instead.
 */
jest.mock("better-auth/api", () => {
  class APIError extends Error {
    readonly body: unknown;
    constructor(
      public status: string,
      options?: { body?: unknown; message?: string; code?: string },
    ) {
      super(options?.message ?? status);
      this.name = "APIError";
      this.body = options?.body ?? { code: options?.code };
    }
  }
  return {
    __esModule: true,
    APIError,
    createAuthMiddleware:
      (handler: (ctx: unknown) => unknown) =>
      (ctx: unknown) =>
        handler(ctx),
  };
});

// The degradation gate reaches `better-auth/plugins` (ESM-only, untransformed
// here). It has its own suite; what matters in *this* file is that the before
// hook delegates to it — and crucially that it does so BEFORE the sign-in path's
// early return, because the endpoints it cares about are not the sign-in path.
const degradedCaptchaRefusal = jest.fn();
jest.mock("../../lib/auth/degraded-captcha", () => ({
  __esModule: true,
  degradedCaptchaRefusal: (...a: unknown[]) => degradedCaptchaRefusal(...a),
}));

import { APIError } from "better-auth/api";
import {
  signInAttemptAfterHook,
  signInAttemptBeforeHook,
} from "@/lib/auth/sign-in-attempt-hooks";
import { isExpectedError } from "@/lib/observability/expected";

const EMAIL = "probe@acme.com";

/** A failed credential sign-in, three failures deep, which is what unlocks the probe. */
async function runAfterHook() {
  const context: { returned: unknown; responseHeaders: Headers } = {
    returned: new APIError("UNAUTHORIZED", {
      body: { code: "INVALID_EMAIL_OR_PASSWORD" },
    }),
    responseHeaders: new Headers(),
  };
  await signInAttemptAfterHook({
    path: "/sign-in/email",
    body: { email: EMAIL },
    context,
  } as never);
  return context.responseHeaders;
}

beforeEach(() => {
  jest.clearAllMocks();
  degradedCaptchaRefusal.mockResolvedValue(null);
  recordSignInFailure.mockResolvedValue({
    lockedUntil: null,
    retryAfterSeconds: null,
    disclosure: { unlocked: true, attempts: 3 },
  });
  userFindUnique.mockResolvedValue({
    id: "u1",
    emailVerified: true,
    banned: false,
  });
  accountFindFirst.mockResolvedValue({ id: "a1" });
  lookupEnforcedOrg.mockResolvedValue(null);
  classifyAccountState.mockReturnValue("active");
});

describe("disclosure probe reporting (row 19)", () => {
  // BREAKS IF DELETED: the happy path loses its `x-auth-account-state` header, so
  // the sign-in page can never render the specific sentence even after the
  // server unlocked disclosure. This is the assertion that the probe still runs
  // at all — the cases below only make sense if it does.
  it("publishes the classified state on the disclosure header", async () => {
    const headers = await runAfterHook();
    expect(headers.get("x-auth-account-state")).toBe("active");
    expect(headers.get("x-auth-attempts")).toBe("3");
    expect(captureThrottled).not.toHaveBeenCalled();
  });

  // BREAKS IF DELETED: a database outage during a credential-stuffing run
  // reports nothing at all, and the answer that a signed-in admin needs — "the
  // disclosure path is degraded" — is indistinguishable from "nothing happened".
  it("reports and MARKS an infrastructure failure in the probes, and degrades to unknown", async () => {
    const boom = new Error("Timed out fetching a new connection from the pool");
    userFindUnique.mockRejectedValue(boom);

    const headers = await runAfterHook();

    expect(headers.get("x-auth-account-state")).toBe("unknown");
    expect(captureThrottled).toHaveBeenCalledTimes(1);
    const opts = captureThrottled.mock.calls[0][2] as {
      expected: boolean;
      op: string;
    };
    expect(opts.expected).toBe(true);
    // The object marker as well as the tag: the report is the visible half, the
    // marker is what survives if the same error is captured by a route that
    // takes no per-call options.
    expect(isExpectedError(boom)).toBe(true);
  });

  // BREAKS IF DELETED: a genuine defect is reported as expected and the
  // classifier that decides what a customer is told about their own account
  // loses its only alarm. It is the one branch in this file that must page.
  it("does NOT mark a classifier throw — that one is our bug, not the database's", async () => {
    const boom = new Error("classifyAccountState is not a function");
    classifyAccountState.mockImplementation(() => {
      throw boom;
    });

    const headers = await runAfterHook();

    expect(headers.get("x-auth-account-state")).toBe("unknown");
    const opts = captureThrottled.mock.calls[0][2] as {
      expected: boolean;
      op: string;
    };
    expect(opts.expected).toBe(false);
    expect(opts.op).toBe("describeAccount:classify");
    expect(isExpectedError(boom)).toBe(false);
  });
});

describe("the degradation gate is wired into the before hook", () => {
  // BREAKS IF DELETED: the gate is unreachable. `lib/auth.ts` registers this
  // before/after pair as the only auth hooks this repo owns, so a call added
  // anywhere else would need an edit to a file this change does not own — and
  // one that was added *after* the sign-in path's early return would be dead
  // code, because `/send-verification-email` is not the sign-in path.
  it("consults the gate before anything else, on a non-sign-in path", async () => {
    const refusal = new Response("no", { status: 400 });
    degradedCaptchaRefusal.mockResolvedValue(refusal);
    readSignInAttempt.mockClear();

    const out = await signInAttemptBeforeHook({
      path: "/send-verification-email",
      body: { email: EMAIL },
      headers: new Headers(),
      context: { returned: undefined },
    } as never);

    expect(out).toBe(refusal);
    expect(degradedCaptchaRefusal).toHaveBeenCalledTimes(1);
    expect(degradedCaptchaRefusal.mock.calls[0][0]).toMatchObject({
      path: "/send-verification-email",
    });
    // And it short-circuited: the lockout read never ran.
    expect(readSignInAttempt).not.toHaveBeenCalled();
  });

  // BREAKS IF DELETED: the gate starts refusing sign-in, which would lock out
  // every customer during the Redis blip the gate exists to mitigate.
  it("continues to the lockout gate when the degradation gate passes", async () => {
    readSignInAttempt.mockResolvedValue({
      lockedUntil: null,
      retryAfterSeconds: null,
      disclosure: { unlocked: false, attempts: 0 },
    });
    const headers = new Headers();

    await signInAttemptBeforeHook({
      path: "/sign-in/email",
      body: { email: EMAIL },
      headers,
      context: { returned: undefined },
    } as never);

    expect(degradedCaptchaRefusal).toHaveBeenCalledTimes(1);
    expect(readSignInAttempt).toHaveBeenCalledWith(EMAIL);
    expect(headers.get("x-auth-attempts")).toBe("0");
  });
});
