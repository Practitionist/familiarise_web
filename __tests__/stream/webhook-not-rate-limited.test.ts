/**
 * @jest-environment node
 */

/**
 * #1134 P1-11 — the Stream webhook endpoint must not be edge rate-limited.
 *
 * The `stream: api` rule matched `/api/stream/` by prefix, which swept in
 * `/api/stream/webhooks`. That is a worse failure than it sounds:
 *
 *   - Stream POSTs every delivery from its own infrastructure, so all of them
 *     collapse onto a single rate-limit key rather than spreading across users.
 *   - Bursts are the NORMAL shape. A 200-attendee webinar emits 200
 *     `call.session_participant_joined` events at once.
 *   - A 429 is not a deferral here. Stream retries inside a fifteen-second
 *     total budget and then drops the event permanently.
 *
 * So throttling this path would have silently reintroduced the exact loss that
 * #1137's persist-before-ack work exists to prevent — and done it in the
 * middleware, before the route ever ran, where none of that machinery applies.
 *
 * Excluding it is safe because the endpoint is not open: it verifies an HMAC
 * signature against the API secret and 401s anything unsigned before doing any
 * work. The signature is the gate; the limiter never was.
 *
 * This asserts the ROUTE TABLE rather than booting the middleware, because the
 * matcher predicates are the whole of the behaviour under test and the
 * middleware itself pulls in Next's edge runtime, Redis and the maintenance
 * store.
 */

import { readFileSync } from "fs";
import { join } from "path";

const middleware = readFileSync(join(process.cwd(), "middleware.ts"), "utf8");

/** The `stream: api` rule's match predicate, lifted from the source. */
function streamApiMatches(pathname: string): boolean {
  return (
    pathname.startsWith("/api/stream/") &&
    !pathname.startsWith("/api/stream/webhooks")
  );
}

describe("the stream: api rate-limit rule", () => {
  it("does NOT match the webhook endpoint", () => {
    expect(streamApiMatches("/api/stream/webhooks")).toBe(false);
  });

  it("still matches the ordinary authenticated Stream routes", () => {
    for (const p of [
      "/api/stream/channels/search-appointments",
      "/api/stream/recordings/start",
      "/api/stream/search-consultees",
      "/api/stream/debug",
    ]) {
      expect(streamApiMatches(p)).toBe(true);
    }
  });

  it("is wired that way in middleware.ts, not just in this test", () => {
    // The predicate above is a copy. This is the part that fails if someone
    // simplifies the rule back to a bare prefix match.
    expect(middleware).toContain('!p.startsWith("/api/stream/webhooks")');
  });

  it("does not claim the join rule is keyed per user", () => {
    // `applyEdgeRateLimits` falls back to the client IP when a rule supplies no
    // `key`, and the join rule supplies none. The comment used to assert
    // per-user keying, which the code cannot do — this middleware is
    // cookie-presence only, with no DB hit and no JWT parsing.
    expect(middleware).not.toContain("keyed per user by the shared");
    expect(middleware).toContain("Keyed by IP, NOT by user");
  });
});

/**
 * #E7 — the OTHER half of "never throttle the Stream webhook", and the half
 * that was actually broken.
 *
 * This file above pins the RATE LIMITER's exclusion of `/api/stream/webhooks`.
 * The maintenance gate had no such exclusion working, because of a single
 * character: `EXEMPT_PREFIXES` carried `"/api/webhooks/"` — a directory prefix,
 * correct for Razorpay/Stripe/Resend/Directus — and the Stream endpoint is a
 * LEAF, at `/api/stream/webhooks`. So:
 *
 *   "/api/stream/webhooks".startsWith("/api/webhooks/") === false
 *
 * and during an OFFLINE maintenance window the middleware answered 503 to every
 * Stream delivery. That is not a deferral. Stream's total retry budget is
 * FIFTEEN SECONDS (6 s per attempt, 5 attempts, no backoff, `Retry-After`
 * ignored) and then the event is dropped forever. Every `call.recording_ready`,
 * `call.ended` and `session_participant_*` emitted inside the window was lost —
 * which is the 2026-08-12 signature (a green platform and zero `WebhookEvent`
 * rows) arriving through a completely different door.
 *
 * So this asserts the MAINTENANCE EXEMPTION, and it is asserted against
 * `lib/maintenance-edge.ts` — the module that owns the list, evaluated by
 * `middleware.ts` via `isMaintenanceExempt`. The matcher is tested directly
 * rather than through the middleware, because the middleware pulls in the edge
 * runtime and the exempt function is the whole of the behaviour under test.
 */

describe("maintenance exemption — the Stream webhook route", () => {
  const STREAM_WEBHOOK = "/api/stream/webhooks";

  it("is exempt from maintenance mode, so an OFFLINE window cannot 503 it", async () => {
    const { isMaintenanceExempt } = await import("../../lib/maintenance-edge");
    // The assertion that would have failed before #E7. It is written as the
    // literal `startsWith` comparison the old matcher performed, so a reader can
    // see exactly why a trailing slash was fatal.
    expect(STREAM_WEBHOOK.startsWith("/api/webhooks/")).toBe(false);
    expect(isMaintenanceExempt(STREAM_WEBHOOK)).toBe(true);
  });

  it("covers the whole subtree, in case a future route nests under it", async () => {
    const { isMaintenanceExempt } = await import("../../lib/maintenance-edge");
    expect(isMaintenanceExempt(`${STREAM_WEBHOOK}/ingest`)).toBe(true);
  });

  it("does not over-match a sibling whose name merely starts the same", async () => {
    // The other direction of the same bug, and the reason the matcher is
    // boundary-aware: `/api/stream/webhooksomething` is not the webhook route
    // and must not inherit its exemption.
    const { isMaintenanceExempt } = await import("../../lib/maintenance-edge");
    expect(isMaintenanceExempt(`${STREAM_WEBHOOK}-archive`)).toBe(false);
    // Nor may the webhook exemption leak out of `/api/stream/`.
    expect(isMaintenanceExempt("/api/stream/recordings/start")).toBe(false);
  });

  it("still exempts the vendor webhooks the trailing-slash entry was for", async () => {
    const { isMaintenanceExempt } = await import("../../lib/maintenance-edge");
    for (const p of [
      "/api/webhooks/razorpay",
      "/api/webhooks/stripe",
      "/api/webhooks/resend",
      "/api/webhooks/directus",
    ]) {
      expect(isMaintenanceExempt(p)).toBe(true);
    }
    // The entry is a directory, so the bare path is now exempt too. No such
    // route exists, and the boundary rule is what makes that safe rather than a
    // new hole.
    expect(isMaintenanceExempt("/api/webhooks")).toBe(true);
  });

  it("keeps every other exemption, and stops the ones that over-matched", async () => {
    const { isMaintenanceExempt } = await import("../../lib/maintenance-edge");
    for (const p of [
      "/api/health",
      "/api/health/redis",
      "/api/auth/sign-in/email",
      "/api/admin/maintenance",
      "/maintenance",
      "/_next/static/chunk.js",
      "/favicon.ico",
    ]) {
      expect(isMaintenanceExempt(p)).toBe(true);
    }
    // `/api/health` used to exempt `/api/healthcheck` and `/api/healthz` by
    // virtue of a raw `startsWith`. Nothing routes there, so this fixes a hole
    // rather than closing one.
    expect(isMaintenanceExempt("/api/healthcheck")).toBe(false);
    expect(isMaintenanceExempt("/api/healthz")).toBe(false);
    // `/api/auth/` must not exempt a hypothetical `/api/authentic-anything`.
    expect(isMaintenanceExempt("/api/authentic-anything")).toBe(false);
  });

  it("is wired through the boundary-aware matcher, not a bare startsWith", async () => {
    // Pins the SHAPE of the fix, because the shape is the durable part: a
    // future entry with a trailing slash on a leaf route is then a
    // no-op rather than a silent 503, and a directory entry keeps working.
    const source = readFileSync(
      join(process.cwd(), "lib", "maintenance-edge.ts"),
      "utf8",
    );
    expect(source).toContain(
      "pathname === base || pathname.startsWith(`${base}/`)",
    );
    expect(source).not.toContain(
      "EXEMPT_PREFIXES.some((prefix) => pathname.startsWith(prefix))",
    );
  });
});
