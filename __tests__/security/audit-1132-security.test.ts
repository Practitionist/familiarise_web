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

  // The plugin defaults this to `true` when unset, which let any authenticated
  // user POST /api/auth/organization/create and own the result — bypassing the
  // ORG_WORKSPACE/ADMIN gate, ENABLE_HOST_ORGS, slug validation and
  // BillingAccount creation that POST /api/organizations performs.
  it("disables the organization plugin's own creation endpoint", () => {
    expect(authSrc).toMatch(/allowUserToCreateOrganization:\s*false/);
  });

  // /admin/set-role authorises on `user:["set-role"]` alone and never compares
  // actor rank to target rank, so granting it to STAFF let STAFF assign itself
  // ADMIN — which auth-helpers then treats as OWNER on every organization.
  it("does not grant STAFF set-role or ban", () => {
    const staffAc = authSrc.slice(
      authSrc.indexOf("const staffAc"),
      authSrc.indexOf("export const auth"),
    );
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
    const idxRefund = src.indexOf("payload?.refund?.entity?.id");
    const idxDispute = src.indexOf("payload?.dispute?.entity?.id");
    const idxPayment = src.indexOf("payload?.payment?.entity?.id");

    expect(idxRefund).toBeGreaterThan(-1);
    expect(idxPayment).toBeGreaterThan(-1);
    expect(idxRefund).toBeLessThan(idxPayment);
    expect(idxDispute).toBeLessThan(idxPayment);
  });
});

describe("Outbound webhook egress guard (#1132)", () => {
  const expectBlocked = async (url: string) =>
    expect(assertPublicUrl(url)).rejects.toBeInstanceOf(SsrfBlockedError);

  it("blocks cloud metadata and loopback by literal IP", async () => {
    await expectBlocked("https://169.254.169.254/latest/meta-data/");
    await expectBlocked("https://127.0.0.1/hook");
    await expectBlocked("https://[::1]/hook");
  });

  it("blocks RFC1918 and CGNAT ranges", async () => {
    await expectBlocked("https://10.0.0.5/hook");
    await expectBlocked("https://172.16.0.1/hook");
    await expectBlocked("https://192.168.1.1/hook");
    await expectBlocked("https://100.64.0.1/hook");
  });

  it("blocks IPv4-mapped and 6to4 wrappers around private space", async () => {
    await expectBlocked("https://[::ffff:127.0.0.1]/hook");
    await expectBlocked("https://[fc00::1]/hook");
    await expectBlocked("https://[fe80::1]/hook");
  });

  it("blocks non-https, odd ports, credentials and localhost names", async () => {
    await expectBlocked("http://example.com/hook");
    await expectBlocked("https://example.com:8080/hook");
    await expectBlocked("https://user:pass@example.com/hook");
    await expectBlocked("https://localhost/hook");
    await expectBlocked("https://foo.internal/hook");
  });

  it("rejects an unresolvable host rather than letting it through", async () => {
    await expectBlocked("https://this-host-does-not-exist-1132.invalid/hook");
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
