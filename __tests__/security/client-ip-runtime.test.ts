/** @jest-environment node */

import {
  clientIpFrom,
  trustedClientIpHeaders,
  type RuntimeEnv,
} from "@/lib/request-ip";

const headers = (values: Record<string, string>) => new Headers(values);

const spoofed = {
  "x-nf-client-connection-ip": "6.6.6.6",
  "x-vercel-forwarded-for": "7.7.7.7",
  "fly-client-ip": "8.8.8.8",
  "x-forwarded-for": "9.9.9.9, 203.0.113.10",
};

describe("client IP trust follows the runtime", () => {
  it("trusts Netlify's header only on Netlify", () => {
    const env: RuntimeEnv = { NETLIFY: "true" };
    expect(trustedClientIpHeaders(env)).toEqual(["x-nf-client-connection-ip"]);
    expect(clientIpFrom(headers(spoofed), env)).toBe("6.6.6.6");
  });

  it("trusts Vercel's header only on Vercel", () => {
    const env: RuntimeEnv = { VERCEL: "1" };
    expect(trustedClientIpHeaders(env)).toEqual(["x-vercel-forwarded-for"]);
    expect(clientIpFrom(headers(spoofed), env)).toBe("7.7.7.7");
  });

  it("trusts Fly's header only on Fly", () => {
    const env: RuntimeEnv = { FLY_APP_NAME: "familiarise" };
    expect(clientIpFrom(headers(spoofed), env)).toBe("8.8.8.8");
  });

  it("ignores platform headers on a generic container and takes the rightmost forwarded hop", () => {
    const env: RuntimeEnv = {};
    expect(trustedClientIpHeaders(env)).toEqual(["x-forwarded-for"]);
    expect(clientIpFrom(headers(spoofed), env)).toBe("203.0.113.10");
  });

  it("does not fall back to a forgeable header when the trusted one is missing", () => {
    const env: RuntimeEnv = { NETLIFY: "true" };
    expect(clientIpFrom(headers({ "x-forwarded-for": "9.9.9.9" }), env)).toBe(
      "unknown_ip",
    );
  });
});
