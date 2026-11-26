/**
 * Security regressions from the enterprise audit (#1132).
 *
 * These are source-level assertions where the defect was a configuration value
 * or an ordering, because that is exactly what review missed the first time.
 */

import fs from "node:fs";
import path from "node:path";

import {
  assertPublicUrl,
  SsrfBlockedError,
} from "@/lib/enterprise/outbound-webhooks/ssrf-guard";

const ROOT = path.join(__dirname, "..", "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

describe("BetterAuth plugin surface (#1132)", () => {
  const authSrc = read("lib/auth.ts");

  // The organization plugin's /api/auth/organization/create let any
  // authenticated user own a new org, bypassing the ORG_WORKSPACE/ADMIN gate,
  // ENABLE_HOST_ORGS, slug validation and BillingAccount creation that
  // POST /api/organizations performs. The plugin is no longer mounted (D11),
  // so none of its /organization/* endpoints exist.
  it("does not mount the organization plugin", () => {
    expect(authSrc).not.toMatch(/\borganization\(/);
    expect(authSrc).not.toMatch(
      /\borganization\b[^\n]*from "better-auth\/plugins"/,
    );
  });

  // /admin/set-role authorises on `user:["set-role"]` alone and never compares
  // actor rank to target rank, so granting it to STAFF let STAFF assign itself
  // ADMIN — which auth-helpers then treats as OWNER on every organization.
  it("does not grant STAFF set-role or ban", () => {
    // #1132 review — prove the anchors resolved before asserting on the slice.
    // A missing anchor yields -1, and slice(-1, -1) is "", which satisfies
    // `not.toMatch` — so a rename would have turned this security regression
    // test green instead of red.
    const start = authSrc.indexOf("const staffAc");
    const end = authSrc.indexOf("export const auth");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const staffAc = authSrc.slice(start, end);
    expect(staffAc.length).toBeGreaterThan(0);
    expect(staffAc).not.toMatch(/["']set-role["']/);
    expect(staffAc).not.toMatch(/["']ban["']/);
  });
});

describe("Razorpay webhook dedup key (#1132)", () => {
  const src = read("app/api/webhooks/razorpay/route.ts");

  // Razorpay sends `contains: ["refund","payment"]` on refund events. With
  // payment probed first, every refund on a payment collapsed to the same
  // idempotency key and the second partial refund was dropped as a duplicate —
  // after the money had already left.
  it("probes refund and dispute before payment", () => {
    const idxRefund = src.indexOf('ingress.entityId("refund")');
    const idxDispute = src.indexOf('ingress.entityId("dispute")');
    const idxPayment = src.indexOf('ingress.entityId("payment")');

    expect(idxRefund).toBeGreaterThan(-1);
    expect(idxDispute).toBeGreaterThan(-1);
    expect(idxPayment).toBeGreaterThan(-1);
    expect(idxRefund).toBeLessThan(idxPayment);
    expect(idxDispute).toBeLessThan(idxPayment);
  });
});

describe("Outbound webhook egress guard (#1132)", () => {
  it("blocks cloud metadata and loopback by literal IP", async () => {
    for (const url of [
      "https://169.254.169.254/latest/meta-data/",
      "https://127.0.0.1/hook",
      "https://[::1]/hook",
    ]) {
      await expect(assertPublicUrl(url)).rejects.toBeInstanceOf(
        SsrfBlockedError,
      );
    }
  });

  it("blocks RFC1918 and CGNAT ranges", async () => {
    for (const url of [
      "https://10.0.0.5/hook",
      "https://172.16.0.1/hook",
      "https://192.168.1.1/hook",
      "https://100.64.0.1/hook",
    ]) {
      await expect(assertPublicUrl(url)).rejects.toBeInstanceOf(
        SsrfBlockedError,
      );
    }
  });

  it("blocks IPv4-mapped and 6to4 wrappers around private space", async () => {
    for (const url of [
      "https://[::ffff:127.0.0.1]/hook",
      "https://[fc00::1]/hook",
      "https://[fe80::1]/hook",
    ]) {
      await expect(assertPublicUrl(url)).rejects.toBeInstanceOf(
        SsrfBlockedError,
      );
    }
  });

  it("blocks non-https, odd ports, credentials and localhost names", async () => {
    for (const url of [
      "http://example.com/hook",
      "https://example.com:8080/hook",
      "https://user:pass@example.com/hook",
      "https://localhost/hook",
      "https://foo.internal/hook",
    ]) {
      await expect(assertPublicUrl(url)).rejects.toBeInstanceOf(
        SsrfBlockedError,
      );
    }
  });

  // #1132 review — url.hostname keeps the brackets on an IPv6 literal, so
  // these were previously rejected only because the bracketed string failed to
  // resolve. They must be rejected as non-routable ADDRESSES, and the hex
  // spellings of loopback must be caught too.
  it("classifies IPv6 literals as addresses, including hex-embedded loopback", async () => {
    for (const url of [
      "https://[::ffff:7f00:1]/hook",
      "https://[::7f00:1]/hook",
      "https://[64:ff9b::10.0.0.1]/hook",
      "https://[2002:7f00:1::]/hook",
    ]) {
      await expect(assertPublicUrl(url)).rejects.toThrow(
        /not publicly routable|non-public address/,
      );
    }
  });

  it("allows a genuinely public IPv6 endpoint", async () => {
    // Previously impossible: every IPv6 literal died in the DNS branch.
    await expect(
      assertPublicUrl("https://[2606:4700:4700::1111]/hook"),
    ).resolves.toBeUndefined();
  });

  it("rejects an unresolvable host rather than letting it through", async () => {
    for (const url of ["https://this-host-does-not-exist-1132.invalid/hook"]) {
      await expect(assertPublicUrl(url)).rejects.toBeInstanceOf(
        SsrfBlockedError,
      );
    }
  });

  it("does not follow redirects at delivery time", () => {
    // A public host that 302s to a private one would defeat the check above,
    // so the worker must never follow redirects itself.
    expect(read("lib/enterprise/outbound-webhooks/worker.ts")).toMatch(
      /redirect:\s*["']manual["']/,
    );
  });
});

describe("Consultant payout freeze (#1132)", () => {
  const src = read("lib/payments/payouts/payout-service.ts");

  // ADR 11 claims gateway submission is held behind the flag, but it was read
  // only on the org rail — so the org go-live flip would have released every
  // APPROVED consultant payout to a real bank account.
  // Asserted structurally rather than on a byte window: the gate must sit
  // between the function opening and the lock acquisition, so it can move
  // within that region without the test going stale, but cannot drift below
  // the point where work begins.
  it("gates processApprovedPayouts on ENABLE_LIVE_PAYOUTS before it takes the lock", () => {
    const fnStart = src.indexOf("export async function processApprovedPayouts");
    expect(fnStart).toBeGreaterThan(-1);

    const lockAt = src.indexOf("acquireLock(", fnStart);
    expect(lockAt).toBeGreaterThan(fnStart);

    const preamble = src.slice(fnStart, lockAt);
    expect(preamble).toMatch(/if\s*\(!ENABLE_LIVE_PAYOUTS\)/);
  });

  // ADR 13 requires an unreachable Redis to page rather than silently freeze
  // payouts. The freeze gate must not short-circuit that.
  it("keeps the Redis fail-closed prechecks ahead of the freeze gate", () => {
    const fnStart = src.indexOf("export async function processApprovedPayouts");
    const redisAt = src.indexOf("checkRedisHealth()", fnStart);
    const gateAt = src.indexOf("!ENABLE_LIVE_PAYOUTS", fnStart);
    expect(redisAt).toBeGreaterThan(-1);
    expect(redisAt).toBeLessThan(gateAt);
  });
});
