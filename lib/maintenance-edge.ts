/**
 * Maintenance Mode — Edge-compatible reader
 *
 * This module is safe for Next.js middleware (Edge Runtime).
 * Uses direct fetch to Upstash Redis REST API (no SDK import needed).
 * No Prisma, no Node.js-only APIs.
 *
 * For write operations (setMaintenanceState), use lib/maintenance.ts instead.
 */

import { NextRequest } from "next/server";

import { REDIS_KEYS } from "./maintenance-keys";

// REDIS_KEYS is platform-scoped (single phase/config read per request, 30s-cached
// below). Per-org windows ("maintenance:phase:org:<orgId>") are NOT implemented —
// prior orgMaintenanceKeys()/platformMaintenanceKeys() scaffolding was removed
// (#776) as dead code. If they ship, add the org-scoped read here (org key first,
// fall back to platform) and a matching writer in the admin maintenance route.

// Routes exempt from maintenance mode
const EXEMPT_PREFIXES = [
  "/api/webhooks/",
  "/api/health",
  "/api/auth/",
  "/api/admin/maintenance",
  "/maintenance",
  "/_next/",
  "/favicon",
];

export interface MaintenanceState {
  phase: "OFF" | "DEGRADED" | "OFFLINE";
  reason: string | null;
  estimatedEnd: string | null;
  bypassSecret: string | null;
}

const OFF_STATE: MaintenanceState = {
  phase: "OFF",
  reason: null,
  estimatedEnd: null,
  bypassSecret: null,
};

// In-memory cache to avoid Redis round-trips on every request.
// Edge isolates share module scope within an instance lifetime.
let cachedState: MaintenanceState | null = null;
let cacheTimestamp = 0;
// #1822 Q-6 — was 30s; the read fails open, so the only cost of a longer
// window is slower enforcement of a newly-set maintenance phase.
const CACHE_TTL_MS = 180_000; // 3 minutes
// A failed read keeps the old 30s window, so one blip can't unblock DEGRADED writes for 3 min.
const FAILURE_CACHE_MS = 30_000;

// Per-request fail-open budget for the edge Upstash read. Document loads + /api/*
// pay this (RSC/prefetch sub-navigations use getMaintenanceStateCachedOnly and
// never read live), and it falls back to OFF on timeout — so a slow Upstash gives
// up fast rather than adding latency to live traffic. 200ms: well under a frame.
const REDIS_FETCH_TIMEOUT_MS = (() => {
  const v = Number(process.env.REDIS_FETCH_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 200;
})();

/**
 * Direct Upstash REST call — edge-safe, no SDK needed.
 */
async function redisGet(key: string): Promise<string | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  const res = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(REDIS_FETCH_TIMEOUT_MS),
  });

  // Non-OK (e.g. quota exceeded) is a failed read, not an unset phase.
  if (!res.ok) throw new Error(`Upstash GET ${res.status}`);
  const data = await res.json();
  return data.result ?? null;
}

/**
 * Read current maintenance state from Redis (edge-safe).
 * Fail-open: returns OFF if Redis is unreachable or not configured.
 */
export async function getMaintenanceState(): Promise<MaintenanceState> {
  const now = Date.now();
  if (cachedState && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedState;
  }

  try {
    const [phase, configRaw] = await Promise.all([
      redisGet(REDIS_KEYS.PHASE),
      redisGet(REDIS_KEYS.CONFIG),
    ]);

    if (!phase || phase === "OFF") {
      cachedState = OFF_STATE;
      cacheTimestamp = now;
      return OFF_STATE;
    }

    let config: Partial<MaintenanceState> = {};
    if (configRaw) {
      try {
        config = JSON.parse(configRaw);
      } catch {
        // Malformed config — treat as no config
      }
    }

    const state: MaintenanceState = {
      phase: phase as MaintenanceState["phase"],
      reason: config.reason ?? null,
      estimatedEnd: config.estimatedEnd ?? null,
      bypassSecret: config.bypassSecret ?? null,
    };
    cachedState = state;
    cacheTimestamp = now;
    return state;
  } catch {
    // Fail-open: cache OFF to avoid repeated failing calls
    cachedState = OFF_STATE;
    cacheTimestamp = now - CACHE_TTL_MS + FAILURE_CACHE_MS;
    return OFF_STATE;
  }
}

/**
 * Non-blocking maintenance read for the hot sub-navigation path (Next RSC +
 * prefetch fetches). Returns the in-memory cached state if fresh, else OFF —
 * NEVER a live Upstash round-trip. Without this, the blocking read in
 * getMaintenanceState() runs before the RSC response can stream, so a soft
 * navigation sits blank until it resolves (the gap before loading.tsx appears).
 * A full document load still does the live read, so a maintenance window is
 * always enforced within one document navigation / the 3-min cache window.
 *
 * When the cache is stale we kick off a refresh (so the NEXT sub-navigation sees
 * fresh state) and return the last-known state rather than OFF — otherwise a
 * session that only soft-navigates would bypass an active window indefinitely
 * once the TTL lapses (#927). Two edge-runtime caveats (#929 review):
 *  - an unawaited promise is not guaranteed to run after the response is sent, so
 *    the caller passes `event.waitUntil` to keep the refresh alive;
 *  - a single `isRefreshing` guard collapses concurrent stale sub-navigations into
 *    one Upstash read instead of a thundering herd.
 */
let isRefreshing = false;

export function getMaintenanceStateCachedOnly(
  waitUntil?: (promise: Promise<unknown>) => void,
): MaintenanceState {
  if (cachedState && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedState;
  }
  if (!isRefreshing) {
    isRefreshing = true;
    const refresh = getMaintenanceState()
      .catch(() => {})
      .finally(() => {
        isRefreshing = false;
      });
    waitUntil?.(refresh);
  }
  return cachedState ?? OFF_STATE;
}

// Matches paths ending with a file extension (e.g. .js, .css, .png, .woff2).
// More precise than pathname.includes(".") which false-positives on /api/v2.0/foo.
// Exported so middleware.ts reuses the exact same rule for its static-asset skip
// (single source of truth — #776).
export const HAS_FILE_EXTENSION = /\.\w{2,10}$/;

/**
 * Check if a route is exempt from maintenance mode.
 */
export function isMaintenanceExempt(pathname: string): boolean {
  if (HAS_FILE_EXTENSION.test(pathname)) return true;
  return EXEMPT_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

// Transactional write routes to block during DEGRADED maintenance.
// Read-only methods (GET, HEAD, OPTIONS) are always allowed.
// Every pattern matches by PREFIX: naming a route also blocks everything
// nested under it. A single '*' stands for exactly one path segment.
const WRITE_BLOCKED_IN_DEGRADED = [
  "/api/checkout",
  "/api/appointments/*/cancel",
  // Prefix semantics cover /respond and /withdraw, which the old endsWith
  // matcher left writable for the whole life of the write-block.
  "/api/appointments/*/reschedule",
  "/api/appointments/*/documents",
  "/api/appointments/*/feedback",
  "/api/appointments/*/support",
  "/api/bookings/consultations",
  "/api/bookings/subscriptions",
  "/api/bookings/webinars",
  "/api/bookings/classes",
  "/api/bookings/*/allocate",
  "/api/trials",
  "/api/plans/*/materials",
  "/api/stream/meetings", // Block new video call creation
  "/api/form/onboarding/*", // Block new user registration/onboarding
  // Onboarding wizard server actions (draft autosave, terminal submit,
  // ORG_WORKSPACE role handoff) POST to this page route, not to /api/* —
  // without this entry they wrote straight through DEGRADED while the
  // equivalent PATCH route above was blocked. GET reads still pass with
  // banner headers; the global MaintenanceBanner explains the pause.
  "/form/onboarding",
  "/api/verification/documents", // Block verification document uploads
  "/api/verification/submit", // Block verification submission
  "/api/verification/resubmit", // Block verification resubmission
  "/api/scheduling/request-for-approval", // Block new approval-rail bookings
  // Weekly, custom and per-id availability writes; the sibling
  // /api/scheduling/availability-with-allocation is a different prefix and is GET.
  "/api/scheduling/availability",
  "/api/waitlist", // Block newsletter signups
  "/api/referrals", // Block referral code creation
  // #1599 F-P0-02 — the routes live under /api/collaborations; the old
  // "/api/collaborators" entry matched nothing.
  "/api/collaborations",
  "/api/payments/disputes", // Block dispute handling mutations
  "/api/admin/payouts", // Block admin payout mutations
  "/api/consultant/payouts/instant", // #1771 row 6 — expert-initiated payout
  // #1598 P1-W02a — the admin refund front door, TDS filing marks and the
  // wallet unfreeze are money writes too; GETs still pass via READ_ONLY_METHODS.
  "/api/admin/refunds",
  "/api/admin/tds",
  "/api/admin/billing-accounts",
  // #1599 F-P0-03..05, F-P1-02/05/06 — money-writing doors the list missed:
  // an admin re-drive of a payment, a recording purchase, an overage order,
  // a seat removal (its DELETE refunds through refundRemovedAttendeeSeat),
  // and a call join/end (the provision side already refuses in maintenance).
  "/api/payments/*/recover",
  "/api/recordings/*/purchase",
  "/api/overage/*/order",
  "/api/participants",
  "/api/meetings/*/join",
  "/api/meetings/*/end",
  // Org money rails. Nothing under /api/organizations was blocked before, so
  // an org could top up a wallet, issue an invoice or move a payout while the
  // deployment was half-applied. Prefix semantics mean `programs` also covers
  // programs/*/assignments and programs/*/auto-enroll, and `contracts` covers
  // contracts/*/supersede.
  "/api/organizations/*/billing-account/wallet/top-ups",
  "/api/organizations/*/billing-account/invoices",
  "/api/organizations/*/billing-account/purchase-orders",
  "/api/organizations/*/programs",
  "/api/organizations/*/contracts",
  "/api/organizations/*/rate-cards",
  "/api/organizations/*/payouts",
  "/api/organizations/*/payout-account",
  // Seat changes meter the licences the checkout entitlement resolver reads.
  "/api/organizations/*/members",
  "/api/organizations/*/invitations",
];

const READ_ONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Match one pattern against a path, PREFIX-wise.
 *
 * The wildcard used to be matched as `startsWith(prefix) && endsWith(suffix)`,
 * which pinned the match to the END of the path: the appointments reschedule pattern
 * blocked `/reschedule` and nothing under it, so `/reschedule/respond` and
 * `/reschedule/withdraw` — the two routes that actually move a booking — wrote
 * straight through DEGRADED. Naming a route now blocks its whole subtree, which
 * is what every entry in the list above was always read as meaning.
 *
 * The wildcard still stands for exactly one non-empty segment, so
 * the bookings allocate pattern cannot be satisfied by `/api/bookings/allocate`.
 */
function matchesBlockedPattern(pathname: string, pattern: string): boolean {
  const star = pattern.indexOf("*");
  if (star === -1) {
    return pathname === pattern || pathname.startsWith(pattern + "/");
  }

  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (!pathname.startsWith(prefix)) return false;

  const rest = pathname.slice(prefix.length);
  const slash = rest.indexOf("/");
  const segment = slash === -1 ? rest : rest.slice(0, slash);
  if (segment.length === 0) return false;

  const tail = slash === -1 ? "" : rest.slice(slash);
  return tail === suffix || tail.startsWith(suffix + "/");
}

/**
 * Returns true if the route+method combination should be blocked in DEGRADED mode.
 * Prevents transactional writes (bookings, payments, cancellations) during
 * partial maintenance while still allowing users to browse and read data.
 */
export function isWriteBlockedInDegraded(
  pathname: string,
  method: string,
  searchParams?: URLSearchParams,
): boolean {
  // #1599 R-P0-02 — GET /api/checkout/verify?sync=true drives the capture
  // pipeline, so it is a money write wearing a read-only method.
  if (
    method.toUpperCase() === "GET" &&
    pathname === "/api/checkout/verify" &&
    searchParams?.get("sync") === "true"
  ) {
    return true;
  }
  if (READ_ONLY_METHODS.has(method.toUpperCase())) return false;

  return WRITE_BLOCKED_IN_DEGRADED.some((pattern) =>
    matchesBlockedPattern(pathname, pattern),
  );
}

// #1861 S3a — this module runs on the edge runtime, where node:crypto's
// timingSafeEqual is unavailable, so the bypass secret compare needs its own
// constant-time routine. Length inequality is folded into the accumulator
// rather than returned early, and every byte up to max(len) is visited, so
// neither a length mismatch nor an early differing byte shortens the loop.
function constantTimeEqual(a: string | null | undefined, b: string): boolean {
  if (a === null || a === undefined) return false;
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  const maxLen = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length === bBytes.length ? 0 : 1;
  for (let i = 0; i < maxLen; i++) {
    diff |=
      (i < aBytes.length ? aBytes[i] : 0) ^ (i < bBytes.length ? bBytes[i] : 0);
  }
  return diff === 0;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

// Pure Edge-compatible SHA-256 / HMAC-SHA256 implementation used by synchronous
// `validateBypass` when the Web Crypto `crypto.subtle` verified-token cache is
// cold on a request in `middleware.ts`. Produces the exact same RFC 2104 / FIPS
// 180-4 digest as `crypto.subtle.sign("HMAC", ...)`.
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256Bytes(msg: Uint8Array): Uint8Array {
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  let h0 = 0x6a09e667,
    h1 = 0xbb67ae85,
    h2 = 0x3c6ef372,
    h3 = 0xa54ff53a,
    h4 = 0x510e527f,
    h5 = 0x9b05688c,
    h6 = 0x1f83d9ab,
    h7 = 0x5be0cd19;

  const bitLen = msg.length * 8;
  const padLen = (msg.length + 9 + 63) & ~63;
  const padded = new Uint8Array(padLen);
  padded.set(msg);
  padded[msg.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(padLen - 4, bitLen >>> 0, false);

  const w = new Uint32Array(64);
  for (let offset = 0; offset < padLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h0,
      b = h1,
      c = h2,
      d = h3,
      e = h4,
      f = h5,
      g = h6,
      h = h7;

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0, false);
  outView.setUint32(4, h1, false);
  outView.setUint32(8, h2, false);
  outView.setUint32(12, h3, false);
  outView.setUint32(16, h4, false);
  outView.setUint32(20, h5, false);
  outView.setUint32(24, h6, false);
  outView.setUint32(28, h7, false);
  return out;
}

function hmacSha256HexSync(secret: string, message: string): string {
  const enc = new TextEncoder();
  let keyBytes: Uint8Array = enc.encode(secret);
  if (keyBytes.length > 64) {
    keyBytes = sha256Bytes(keyBytes);
  }
  const blockKey = new Uint8Array(64);
  blockKey.set(keyBytes);

  const oKeyPad = new Uint8Array(64);
  const iKeyPad = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    oKeyPad[i] = blockKey[i] ^ 0x5c;
    iKeyPad[i] = blockKey[i] ^ 0x36;
  }

  const msgBytes = enc.encode(message);
  const innerInput = new Uint8Array(64 + msgBytes.length);
  innerInput.set(iKeyPad, 0);
  innerInput.set(msgBytes, 64);
  const innerHash = sha256Bytes(innerInput);

  const outerInput = new Uint8Array(64 + innerHash.length);
  outerInput.set(oKeyPad, 0);
  outerInput.set(innerHash, 64);
  return bytesToHex(sha256Bytes(outerInput));
}

async function hmacSha256HexWebCrypto(
  secret: string,
  message: string,
): Promise<string> {
  const enc = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await globalThis.crypto.subtle.sign(
    "HMAC",
    key,
    enc.encode(message),
  );
  return bytesToHex(new Uint8Array(sig));
}

export const DEFAULT_BYPASS_COOKIE_TTL_MS = 24 * 60 * 60 * 1000;

// Bounded Edge-local cache of tokens verified via Web Crypto `crypto.subtle`.
const verifiedCookieCache = new Map<string, number>();
const MAX_VERIFIED_COOKIE_CACHE = 128;

function parseBypassCookieToken(
  token: string | null | undefined,
  nowMs: number,
): { expiryStr: string; expiryMs: number; hmacHex: string } | null {
  if (!token) return null;
  const dotIdx = token.indexOf(".");
  if (dotIdx <= 0 || dotIdx !== token.lastIndexOf(".")) return null;

  const expiryStr = token.slice(0, dotIdx);
  const hmacHex = token.slice(dotIdx + 1).toLowerCase();
  if (!/^\d{10,16}$/.test(expiryStr) || !/^[0-9a-f]{64}$/.test(hmacHex)) {
    return null;
  }

  const expiryMs = Number(expiryStr);
  if (!Number.isSafeInteger(expiryMs) || expiryMs <= nowMs) {
    return null;
  }

  return { expiryStr, expiryMs, hmacHex };
}

function recordVerifiedToken(
  secret: string,
  token: string,
  expiryMs: number,
): void {
  if (verifiedCookieCache.size >= MAX_VERIFIED_COOKIE_CACHE) {
    const oldestKey = verifiedCookieCache.keys().next().value;
    if (oldestKey !== undefined) verifiedCookieCache.delete(oldestKey);
  }
  verifiedCookieCache.set(`${secret}:${token}`, expiryMs);
}

/**
 * #1487 — Mint a short-lived HMAC-SHA256 signed bypass cookie token
 * (`<expiryTimestamp>.<hmac>`) using Web Crypto `crypto.subtle` so the raw
 * `MAINTENANCE_BYPASS_SECRET` is never stored in the browser cookie.
 */
export async function signMaintenanceBypassCookie(
  secret: string,
  expiresAtMs: number = Date.now() + DEFAULT_BYPASS_COOKIE_TTL_MS,
): Promise<string> {
  if (!secret) {
    throw new Error(
      "Cannot sign maintenance bypass cookie with an empty secret",
    );
  }
  const expiryMs = Math.floor(expiresAtMs);
  const expiryStr = String(expiryMs);
  const hmacHex = await hmacSha256HexWebCrypto(secret, expiryStr);
  const token = `${expiryStr}.${hmacHex}`;
  recordVerifiedToken(secret, token, expiryMs);
  return token;
}

/**
 * #1487 — Verify an HMAC-SHA256 signed maintenance bypass cookie token
 * (`<expiryTimestamp>.<hmac>`) using Web Crypto `crypto.subtle`.
 * Rejects raw secrets, expired timestamps, and tampered signatures.
 */
export async function verifyMaintenanceBypassCookie(
  token: string | null | undefined,
  secret: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  if (!secret) return false;
  const parsed = parseBypassCookieToken(token, nowMs);
  if (!parsed || !token) return false;

  const expectedHmac = await hmacSha256HexWebCrypto(secret, parsed.expiryStr);
  const ok = constantTimeEqual(parsed.hmacHex, expectedHmac);
  if (ok) {
    recordVerifiedToken(secret, token, parsed.expiryMs);
  }
  return ok;
}

/**
 * Async variant of `validateBypass` that verifies the cookie directly through
 * Web Crypto `crypto.subtle`.
 */
export async function validateBypassAsync(
  request: NextRequest,
  storedSecret: string | null,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const activeSecret = storedSecret || process.env.MAINTENANCE_BYPASS_SECRET;
  if (!activeSecret) return false;

  const headerVal = request.headers.get("x-maintenance-bypass");
  if (constantTimeEqual(headerVal, activeSecret)) return true;

  const cookieVal = request.cookies.get("maintenance_bypass")?.value;
  return verifyMaintenanceBypassCookie(cookieVal, activeSecret, nowMs);
}

/**
 * Validate maintenance bypass via header or signed cookie (#1487).
 *
 * - `x-maintenance-bypass` header: matches `storedSecret` (or fallback
 *   `MAINTENANCE_BYPASS_SECRET`) via constant-time comparison.
 * - `maintenance_bypass` cookie: MUST be an unexpired HMAC-SHA256 signed token
 *   of the form `<expiryTimestamp>.<hmac>` (never the raw secret). Verified in
 *   constant time and cached via Web Crypto `crypto.subtle`.
 */
export function validateBypass(
  request: NextRequest,
  storedSecret: string | null,
  nowMs: number = Date.now(),
): boolean {
  const activeSecret = storedSecret || process.env.MAINTENANCE_BYPASS_SECRET;
  if (!activeSecret) return false;

  const headerVal = request.headers.get("x-maintenance-bypass");
  if (constantTimeEqual(headerVal, activeSecret)) return true;

  const cookieVal = request.cookies.get("maintenance_bypass")?.value;
  const parsed = parseBypassCookieToken(cookieVal, nowMs);
  if (!parsed || !cookieVal) return false;

  const cacheKey = `${activeSecret}:${cookieVal}`;
  const cachedExpiry = verifiedCookieCache.get(cacheKey);
  if (cachedExpiry !== undefined) {
    if (cachedExpiry > nowMs) return true;
    verifiedCookieCache.delete(cacheKey);
    return false;
  }

  const expectedHmac = hmacSha256HexSync(activeSecret, parsed.expiryStr);
  if (!constantTimeEqual(parsed.hmacHex, expectedHmac)) {
    return false;
  }

  // Warm the cache via Web Crypto `crypto.subtle` verification as well.
  void verifyMaintenanceBypassCookie(cookieVal, activeSecret, nowMs).catch(
    () => {},
  );
  recordVerifiedToken(activeSecret, cookieVal, parsed.expiryMs);
  return true;
}
