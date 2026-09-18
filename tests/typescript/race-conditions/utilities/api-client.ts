import { readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
/**
 * Real-API chaos harness (#837 — chaos categories 07-09).
 *
 * Unlike the simulated 01-06 categories (in-memory bookingRegistry), these
 * helpers drive the actual app over HTTP: BetterAuth session cookies from
 * seeded users, concurrent fetches, and status-histogram assertions.
 *
 * Execution model: seeded dev DB (`npm run db:seed:small`) + a running dev
 * server (`npm run dev`), then `npm run test:chaos:api`. Set CHAOS_BASE_URL
 * to target a staging clone instead.
 */

export const BASE_URL = process.env.CHAOS_BASE_URL ?? "http://localhost:3000";
const SEED_PASSWORD = process.env.SEED_PASSWORD ?? "SeedPass123!";

/**
 * The simulated 01-06 categories run anywhere, but these real-API scenarios
 * need a live server. The CI race-tests workflow runs `npm run test:race`
 * with no server, so every scenario calls this first and SKIPs (exit 0)
 * when the target is unreachable — same semantics as the missing-fixture
 * SKIPs. The pre-launch staging run sets CHAOS_BASE_URL and runs for real.
 */
export async function ensureServerOrSkip(): Promise<void> {
  try {
    await fetch(`${BASE_URL}/api/auth/get-session`, {
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    console.log(
      `⏭️  SKIP — no server reachable at ${BASE_URL} (set CHAOS_BASE_URL or start \`npm run dev\`)`,
    );
    process.exit(0);
  }
}

export interface Session {
  cookie: string;
  email: string;
}

// Cross-PROCESS session cache: the master-runner spawns each scenario as
// its own tsx process, and the auth limiter is 10 logins / 15 min per IP —
// a full suite run plus one rerun starves it (observed three times). Cached
// cookies are validated with a get-session call (unlimited) before reuse,
// so a stale cookie falls through to a real login.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const SESSION_CACHE_FILE = require("node:path").join(
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("node:os").tmpdir(),
  "chaos-session-cache.json",
);

function readSessionCache(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(SESSION_CACHE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function writeSessionCache(cache: Record<string, string>): void {
  try {
    writeFileSync(SESSION_CACHE_FILE, JSON.stringify(cache));
  } catch {
    // best-effort — cache misses just cost a login
  }
}

/** Sign in as a seeded user and return the session cookie header value. */
interface RawResponse {
  status: number;
  body: string;
  setCookies: string[];
}

/** POST JSON with an `Origin` header that survives — `fetch` silently strips it. */
function postWithOrigin(
  url: string,
  payload: Record<string, string>,
): Promise<RawResponse> {
  const target = new URL(url);
  const transport = target.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(
      target,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: BASE_URL },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on("end", () => {
          const raw = res.headers["set-cookie"];
          resolve({
            status: res.statusCode ?? 0,
            body,
            setCookies: Array.isArray(raw) ? raw : raw ? [raw] : [],
          });
        });
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(payload));
  });
}

export async function loginAs(email: string): Promise<Session> {
  const cache = readSessionCache();
  const cached = cache[email];
  if (cached) {
    const probe = await fetch(`${BASE_URL}/api/auth/get-session`, {
      headers: { Cookie: cached, origin: BASE_URL },
    });
    const body = await probe.json().catch(() => null);
    if (probe.ok && body?.user) {
      return { cookie: cached, email };
    }
  }

  // Node's fetch drops `Origin` (a forbidden request header under the Fetch
  // spec), so a deployed target answers 403 INVALID_ORIGIN; the raw client keeps it.
  const res = await postWithOrigin(`${BASE_URL}/api/auth/sign-in/email`, {
    email,
    password: SEED_PASSWORD,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`login ${email} failed: ${res.status} ${res.body}`);
  }
  const cookie = res.setCookies.map((c) => c.split(";")[0]).join("; ");
  cache[email] = cookie;
  writeSessionCache(cache);
  return { cookie, email };
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

export async function apiFetch(
  path: string,
  init: RequestInit & { session?: Session } = {},
): Promise<ApiResponse> {
  const { session, ...rest } = init;
  const res = await fetch(`${BASE_URL}${path}`, {
    ...rest,
    headers: {
      "Content-Type": "application/json",
      origin: BASE_URL,
      ...(session ? { cookie: session.cookie } : {}),
      ...(rest.headers ?? {}),
    },
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // non-JSON response is fine for histogram checks
  }
  return { status: res.status, body };
}

/** Fire n identical (or indexed) requests truly concurrently. */
export async function fireConcurrent(
  n: number,
  make: (i: number) => Promise<ApiResponse>,
): Promise<ApiResponse[]> {
  return Promise.all(Array.from({ length: n }, (_, i) => make(i)));
}

/** Bucket responses by status code. */
export function histogram(results: ApiResponse[]): Record<number, number> {
  const h: Record<number, number> = {};
  for (const r of results) h[r.status] = (h[r.status] ?? 0) + 1;
  return h;
}

let failures = 0;

export function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(
    `${ok ? "✅ PASS" : "❌ FAIL"}  ${name}${ok ? "" : `\n         -> ${JSON.stringify(detail)}`}`,
  );
  if (!ok) failures += 1;
}

/** Exit the scenario with the runner's pass/fail contract. */
export function finish(testName: string): never {
  console.log(
    `\n${failures === 0 ? "🎉" : "💥"} ${testName}: ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

/**
 * Exactly-one-winner assertion for guarded mutations: one 2xx and the rest
 * 4xx/5xx conflicts (409 from CAS guards; Serializable aborts may surface
 * as 5xx — both count as "did not double-apply").
 */
export function assertExactlyOneWinner(
  name: string,
  results: ApiResponse[],
): void {
  const winners = results.filter((r) => r.status >= 200 && r.status < 300);
  check(name, winners.length === 1, histogram(results));
}
