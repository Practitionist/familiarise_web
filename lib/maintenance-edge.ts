/**
 * Maintenance Mode — Edge-compatible reader and bypass validator
 *
 * Safe for Next.js middleware (Edge Runtime). Uses direct fetch to Upstash
 * Redis REST API and Web Crypto / pure JS HMAC-SHA256 without Node.js APIs.
 */

import { NextRequest } from "next/server";

import { REDIS_KEYS } from "./maintenance-keys";

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

let cachedState: MaintenanceState | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 180_000;
const FAILURE_CACHE_MS = 30_000;

const REDIS_FETCH_TIMEOUT_MS = (() => {
  const v = Number(process.env.REDIS_FETCH_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 200;
})();

async function redisGet(key: string): Promise<string | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  const res = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(REDIS_FETCH_TIMEOUT_MS),
  });

  if (!res.ok) throw new Error(`Upstash GET ${res.status}`);
  const data = await res.json();
  return data.result ?? null;
}

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
    cachedState = OFF_STATE;
    cacheTimestamp = now - CACHE_TTL_MS + FAILURE_CACHE_MS;
    return OFF_STATE;
  }
}

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

export const HAS_FILE_EXTENSION = /\.\w{2,10}$/;

export function isMaintenanceExempt(pathname: string): boolean {
  if (HAS_FILE_EXTENSION.test(pathname)) return true;
  return EXEMPT_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

const WRITE_BLOCKED_IN_DEGRADED = [
  "/api/checkout",
  "/api/appointments/*/cancel",
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
  "/api/stream/meetings",
  "/api/form/onboarding/*",
  "/form/onboarding",
  "/api/verification/documents",
  "/api/verification/submit",
  "/api/verification/resubmit",
  "/api/scheduling/request-for-approval",
  "/api/scheduling/availability",
  "/api/waitlist",
  "/api/referrals",
  "/api/collaborations",
  "/api/payments/disputes",
  "/api/admin/payouts",
  "/api/consultant/payouts/instant",
  "/api/admin/refunds",
  "/api/admin/tds",
  "/api/admin/billing-accounts",
  "/api/payments/*/recover",
  "/api/recordings/*/purchase",
  "/api/overage/*/order",
  "/api/participants",
  "/api/meetings/*/join",
  "/api/meetings/*/end",
  "/api/organizations/*/billing-account/wallet/top-ups",
  "/api/organizations/*/billing-account/invoices",
  "/api/organizations/*/billing-account/purchase-orders",
  "/api/organizations/*/programs",
  "/api/organizations/*/contracts",
  "/api/organizations/*/rate-cards",
  "/api/organizations/*/payouts",
  "/api/organizations/*/payout-account",
  "/api/organizations/*/members",
  "/api/organizations/*/invitations",
];

const READ_ONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

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

export function isWriteBlockedInDegraded(
  pathname: string,
  method: string,
  searchParams?: URLSearchParams,
): boolean {
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

  void verifyMaintenanceBypassCookie(cookieVal, activeSecret, nowMs).catch(
    () => {},
  );
  recordVerifiedToken(activeSecret, cookieVal, parsed.expiryMs);
  return true;
}
