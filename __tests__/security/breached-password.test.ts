/**
 * @jest-environment node
 */

/**
 * Breached-password rejection (lib/auth/password-policy.ts). `fetch` is
 * mocked, so no request leaves the test.
 */

import fs from "fs";
import path from "path";
import { createHash } from "node:crypto";

const mockCapture = jest.fn();
jest.mock("../../lib/observability/throttled-capture", () => ({
  captureThrottled: (...args: unknown[]) => mockCapture(...args),
}));

import {
  breachedPasswordCheck,
  CHECKED_PATHS,
  chosenPassword,
  rejectBreachedPassword,
} from "../../lib/auth/password-policy";
import { humanizeAuthError } from "../../lib/labels/auth-errors";

const PASSWORD = "correct horse battery staple";
const SHA1 = createHash("sha1").update(PASSWORD).digest("hex").toUpperCase();

const fetchMock = jest.fn();
const rangeBody = (count: number) =>
  `0000000000000000000000000000000000A:0\r\n${SHA1.slice(5)}:${count}\r\n`;

beforeAll(() => {
  global.fetch = fetchMock as unknown as typeof fetch;
});

beforeEach(() => {
  fetchMock.mockReset();
  mockCapture.mockReset();
});

const matcher = breachedPasswordCheck.hooks.before[0].matcher;

describe("breachedPasswordCheck", () => {
  it("is registered as a BetterAuth plugin", () => {
    const authSrc = fs.readFileSync(
      path.join(__dirname, "..", "..", "lib", "auth.ts"),
      "utf8",
    );
    const plugins = authSrc.slice(authSrc.indexOf("plugins: ["));
    expect(plugins).toMatch(/^\s*breachedPasswordCheck,/m);
  });

  it("does not wrap password.hash, so a reset token is never consumed first", () => {
    expect("init" in breachedPasswordCheck).toBe(false);
  });

  it("exposes PASSWORD_COMPROMISED for auth.$ERROR_CODES", () => {
    expect(breachedPasswordCheck.$ERROR_CODES.PASSWORD_COMPROMISED.code).toBe(
      "PASSWORD_COMPROMISED",
    );
  });

  it.each(["/sign-up/email", "/change-password", "/reset-password"])(
    "runs before %s",
    (endpoint) => {
      expect(matcher({ path: endpoint } as Parameters<typeof matcher>[0])).toBe(
        true,
      );
    },
  );

  it.each(["/admin/create-user", "/set-password", "/sign-in/email"])(
    "does not run on %s",
    (endpoint) => {
      expect(matcher({ path: endpoint } as Parameters<typeof matcher>[0])).toBe(
        false,
      );
      expect(CHECKED_PATHS).not.toContain(endpoint);
    },
  );

  it("reads newPassword before password", () => {
    expect(chosenPassword({ newPassword: "a", password: "b" })).toBe("a");
    expect(chosenPassword({ password: "b" })).toBe("b");
    expect(chosenPassword({ password: "" })).toBeNull();
    expect(chosenPassword(undefined)).toBeNull();
  });

  it("rejects a breached password", async () => {
    fetchMock.mockResolvedValue(new Response(rangeBody(42)));
    await expect(rejectBreachedPassword(PASSWORD)).rejects.toMatchObject({
      body: { code: "PASSWORD_COMPROMISED" },
    });
  });

  it("sends only the 5-character prefix, padded, with a timeout", async () => {
    fetchMock.mockResolvedValue(new Response(rangeBody(0)));
    await expect(rejectBreachedPassword(PASSWORD)).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      `https://api.pwnedpasswords.com/range/${SHA1.slice(0, 5)}`,
    );
    expect(init.headers).toEqual({ "Add-Padding": "true" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it("accepts a password that is not in the range", async () => {
    fetchMock.mockResolvedValue(
      new Response("0000000000000000000000000000000000B:7\n"),
    );
    await expect(rejectBreachedPassword(PASSWORD)).resolves.toBeUndefined();
  });

  it.each([
    ["a timeout", () => Promise.reject(new DOMException("t", "TimeoutError"))],
    ["a network error", () => Promise.reject(new TypeError("fetch failed"))],
    ["a 503", () => Promise.resolve(new Response("", { status: 503 }))],
  ])("fails open on %s and reports it", async (_label, impl) => {
    fetchMock.mockImplementation(impl);
    await expect(rejectBreachedPassword(PASSWORD)).resolves.toBeUndefined();
    expect(mockCapture).toHaveBeenCalledWith(
      "auth:hibp",
      expect.anything(),
      expect.objectContaining({ subsystem: "auth" }),
    );
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
