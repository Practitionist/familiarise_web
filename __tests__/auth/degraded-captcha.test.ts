/**
 * @jest-environment node
 */

/**
 * `lib/auth/degraded-captcha.ts` — failure-modes row 1: "Escalate to mandatory
 * captcha on the credential endpoints when `x-rate-limit-degraded` is present.
 * … The header and the predicate already exist for exactly this consumer;
 * nobody reads them."
 *
 * The `captcha` plugin is stubbed rather than loaded: `better-auth/plugins` is
 * ESM-only, and the plugin's *own* verification is not what is under test here
 * — what is under test is which requests this gate escalates, what it does when
 * there is no captcha to escalate to, and whether it fails toward open when the
 * verifier is down. Each of those is a decision this module makes.
 */

jest.mock("../../lib/redis-edge", () => ({ __esModule: true, default: {} }));

const onRequest = jest.fn();
type CaptchaOptions = { provider: string; secretKey: string; endpoints: string[] };
const captchaFactory = jest.fn((_options: CaptchaOptions) => ({
  id: "captcha",
  onRequest,
  options: _options,
}));
jest.mock("better-auth/plugins", () => ({
  __esModule: true,
  captcha: (options: CaptchaOptions) => captchaFactory(options),
}));

const captureThrottled = jest.fn();
jest.mock("../../lib/observability/throttled-capture", () => ({
  __esModule: true,
  captureThrottled: (...a: unknown[]) => captureThrottled(...a),
}));

jest.mock("@sentry/nextjs", () => ({
  __esModule: true,
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

import {
  degradedCaptchaRefusal,
  isDegradedRequest,
  resetDegradedCaptchaForTesting,
} from "@/lib/auth/degraded-captcha";
import { isExpectedError } from "@/lib/observability/expected";
import { RATE_LIMIT_DEGRADED_HEADER } from "@/lib/rate-limit";
import { DEGRADED_HEADER as CLIENT_HEADER } from "@/lib/auth/degraded-capture";

const VERIFY_PATH = "/send-verification-email";

/** Minimal stand-in for better-call's context; the plugin reads nothing of it. */
const authContext = {} as never;

function call(args: {
  path?: string;
  degraded?: boolean;
  token?: string;
}) {
  const headers = new Headers();
  if (args.degraded) headers.set("x-rate-limit-degraded", "1");
  if (args.token) headers.set("x-captcha-response", args.token);
  return degradedCaptchaRefusal({
    path: args.path ?? VERIFY_PATH,
    headers,
    request: undefined,
    authContext,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.TURNSTILE_SECRET_KEY;
  resetDegradedCaptchaForTesting();
  onRequest.mockResolvedValue(undefined);
});

describe("the header contract", () => {
  // BREAKS IF DELETED: three literal copies of this string exist (the gate, the
  // client reader, the domain-check echo) and nothing stops a rename in one of
  // them from silently making the gate deaf — which is precisely the bug
  // `RATE_LIMIT_DEGRADED_HEADER`'s own docblock warns about, just moved.
  it("every copy equals the exported constant in lib/rate-limit.ts", () => {
    expect(RATE_LIMIT_DEGRADED_HEADER).toBe("x-rate-limit-degraded");
    expect(CLIENT_HEADER).toBe(RATE_LIMIT_DEGRADED_HEADER);
    // The gate's own copy, read through the predicate it gates on.
    expect(isDegradedRequest(new Headers({ [RATE_LIMIT_DEGRADED_HEADER]: "1" }))).toBe(
      true,
    );
    expect(isDegradedRequest(new Headers())).toBe(false);
  });
});

describe("degradedCaptchaRefusal", () => {
  // BREAKS IF DELETED: the gate escalates on every request, so an ordinary
  // verification resend starts demanding a captcha it was never told to send.
  // The whole feature is conditional on this.
  it("does nothing when the edge did not flag degradation", async () => {
    process.env.TURNSTILE_SECRET_KEY = "sk-test";
    expect(await call({ degraded: false, token: "tok" })).toBeNull();
    expect(captchaFactory).not.toHaveBeenCalled();
    expect(captureThrottled).not.toHaveBeenCalled();
  });

  // BREAKS IF DELETED: the gate is scoped to the escalation set; widening it to
  // the sign-in endpoints would demand a captcha on a page whose widget is not
  // mounted, locking out every customer during a Redis blip.
  it("does nothing for an endpoint outside the escalation set", async () => {
    process.env.TURNSTILE_SECRET_KEY = "sk-test";
    expect(
      await call({ path: "/sign-in/email", degraded: true, token: "tok" }),
    ).toBeNull();
    expect(captchaFactory).not.toHaveBeenCalled();
  });

  // BREAKS IF DELETED: the third leg of row 1's "there is nothing to escalate
  // to" — with no Turnstile secret the gate must stay open and merely say so.
  // Making it refuse would be a self-inflicted outage, the failure the whole
  // fail-open posture exists to avoid.
  it("with no Turnstile secret: stays open and reports, marked expected", async () => {
    expect(await call({ degraded: true })).toBeNull();
    expect(captureThrottled).toHaveBeenCalledTimes(1);
    const [key, error, opts] = captureThrottled.mock.calls[0] as [
      string,
      Error,
      { expected: boolean; op: string },
    ];
    expect(key).toContain("degraded-captcha");
    expect(opts.expected).toBe(true);
    expect(opts.op).toBe("degradedCaptcha:noSecret");
    expect(isExpectedError(error)).toBe(true);
  });

  // BREAKS IF DELETED: the escalation silently stops escalating. The plugin is
  // handed a request carrying the real headers so its own presence test is what
  // refuses, and the refusal carries the degraded header back so the page can
  // explain itself.
  it("with a secret: delegates to the plugin and echoes the degraded header on the refusal", async () => {
    process.env.TURNSTILE_SECRET_KEY = "sk-test";
    onRequest.mockResolvedValue({
      response: new Response(
        JSON.stringify({ message: "Missing CAPTCHA response", code: "MISSING_RESPONSE" }),
        { status: 400 },
      ),
    });

    const refusal = await call({ degraded: true });

    expect(captchaFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "cloudflare-turnstile",
        secretKey: "sk-test",
        endpoints: ["/send-verification-email"],
      }),
    );
    expect(refusal).toBeInstanceOf(Response);
    expect(refusal!.status).toBe(400);
    expect(refusal!.headers.get(RATE_LIMIT_DEGRADED_HEADER)).toBe("1");
    await expect(refusal!.json()).resolves.toMatchObject({
      code: "MISSING_RESPONSE",
    });
  });

  // BREAKS IF DELETED: a bot gets a captcha requirement it has not satisfied,
  // i.e. the whole feature. `undefined` from the plugin is its "verdict: pass".
  it("passes when the plugin's own verification accepts the request", async () => {
    process.env.TURNSTILE_SECRET_KEY = "sk-test";
    onRequest.mockResolvedValue(undefined);
    expect(await call({ degraded: true, token: "tok" })).toBeNull();
  });

  // BREAKS IF DELETED: Cloudflare being down during a Redis incident becomes a
  // total auth outage. Fail-open here is deliberate and is the one place the
  // gate chooses the permissive direction; the report is what keeps it
  // observable.
  it("fails OPEN when the verifier is itself unavailable (plugin 500)", async () => {
    process.env.TURNSTILE_SECRET_KEY = "sk-test";
    onRequest.mockResolvedValue({
      response: new Response(JSON.stringify({ code: "UNKNOWN_ERROR" }), {
        status: 500,
      }),
    });

    expect(await call({ degraded: true })).toBeNull();
    const [, error, opts] = captureThrottled.mock.calls[0] as [
      string,
      Error,
      { expected: boolean; op: string },
    ];
    expect(opts.op).toBe("degradedCaptcha:verifierUnavailable");
    expect(opts.expected).toBe(true);
    expect(isExpectedError(error)).toBe(true);
  });
});
