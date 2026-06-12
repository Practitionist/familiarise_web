import { getSessionCookie } from "better-auth/cookies";
import { NextRequest, NextResponse } from "next/server";

import {
  getMaintenanceState,
  isMaintenanceExempt,
  validateBypass,
  isWriteBlockedInDegraded,
  HAS_FILE_EXTENSION,
  type MaintenanceState,
} from "@/lib/maintenance-edge";
import {
  authLimiter,
  searchLimiter,
  eligibilityLimiter,
  newsletterLimiter,
  availabilityLimiter,
  orgInviteAcceptLimiter,
  ssoDomainCheckLimiter,
  orgWalletTopUpLimiter,
  applyRateLimit,
  getClientIp,
  isBypassableIp,
} from "@/lib/rate-limit";
import { Ratelimit } from "@upstash/ratelimit";

// ─────────────────────────────────────────────────────────────────────────────
// What this middleware does, in order (see `middleware()` at the bottom):
//   1. Skip static assets / Next internals / SCIM (no auth concerns).
//   2. Maintenance gate     → `handleMaintenance()`  (OFFLINE/DEGRADED windows).
//   3. Edge rate limiting   → `applyEdgeRateLimits()` (table-driven; DDoS/abuse).
//   4. Auth routing         → cookie-presence check (NO DB hit at the edge).
//
// IMPORTANT (auth model): we only check for the *presence* of a session cookie.
// We CANNOT validate the session here — `auth.api.getSession()` pulls in
// `@better-auth/sso` → `node:crypto`/`node:dns`, which don't exist in the Edge
// Runtime middleware compiles to. Real session validation + SSO enforcement
// happens in `customSession()` (lib/auth.ts) and in server components/route
// handlers. Cookie-present therefore means "likely authenticated", not "valid".
// ─────────────────────────────────────────────────────────────────────────────

const URLS = {
  SIGNIN: "/auth/signin",
  ONBOARDING: "/form/onboarding",
};

// Route-prefix groups. Prefix matching (startsWith) is used instead of globs for
// speed — this runs on every non-static request. Keep these lists in sync with
// the handler-level auth (the middleware is a coarse first gate; the real
// authorization, e.g. requireOrgAccess, still runs in each route).
const ROUTE_PATTERNS = {
  PROTECTED_PREFIXES: [
    "/form/",
    "/dashboard/",
    "/settings/",
    "/profile/",
    "/checkout/",
    "/meetings/",
  ],
  PUBLIC_AUTH_PREFIXES: ["/auth/"],
  // API routes requiring a session cookie (returns 401 JSON without one).
  AUTHENTICATED_API_PREFIXES: [
    "/api/inngest/",
    "/api/form/onboarding/",
    "/api/verification/",
    "/api/user/",
    "/api/bookings/",
    "/api/plans/",
    "/api/participants/", // Private: participant management for classes/webinars/etc.
    "/api/dashboard/", // Private: dashboard data routes
    "/api/trials/", // Private: trial session routes (public sub-routes exempted below)
    "/api/slots/", // Private: appointment slot data and mutations
    "/api/admin/", // Private: platform admin operations (handler-level auth still runs)
    "/api/staff/", // Private: platform staff operations (handler-level auth still runs)
    "/api/organizations/", // Private: enterprise org CRUD, members, billing, sso (handler-level requireOrgAccess still runs)
  ],
  // Public API prefixes are matched BEFORE the authenticated prefixes, so a
  // public sub-route shadows its private parent (e.g. /api/user/consultants is
  // public even though /api/user/ is private). Order matters — see middleware().
  // Notes:
  //   - /api/auth/ must stay public for BetterAuth to work.
  //   - /api/plans/classes|webinars are public for browse/detail; their
  //     sub-routes (recordings, materials) enforce auth in their own handlers.
  PUBLIC_API_PREFIXES: [
    "/api/auth/", // BetterAuth core + SSO endpoints (including /api/auth/sso/domain-check)
    "/api/health/",
    "/api/user/consultants", // Public: explore experts list and individual profiles
    "/api/user/reviews", // Public: consultant reviews
    "/api/plans/classes", // Public: browse and view class plans (sub-routes enforce their own auth)
    "/api/plans/webinars", // Public: browse and view webinar plans (sub-routes enforce their own auth)
    "/api/slots/availability/", // Public: consultant availability for booking page
    "/api/slots/availability-with-allocation/", // Public: consultant availability with allocation info
  ],
};

/**
 * Fast route matching using string prefix checks instead of glob patterns.
 * Also matches the exact path without trailing slash (e.g. "/settings" matches
 * the "/settings/" prefix).
 */
const matchesAnyPrefix = (pathname: string, prefixes: string[]): boolean => {
  for (const prefix of prefixes) {
    if (pathname.startsWith(prefix)) return true;
    if (prefix.endsWith("/") && pathname === prefix.slice(0, -1)) return true;
  }
  return false;
};

// ─────────────────────────────────────────────────────────────────────────────
// Maintenance mode
//
// Live feature (admin UI at /dashboard/admin/maintenance, API at
// /api/admin/maintenance, cron in lib/maintenance-cron.ts). `getMaintenanceState`
// is 30s in-memory cached and fails open (OFF) when Upstash is unreachable/unset,
// so this is NOT a per-request Redis round-trip.
// ─────────────────────────────────────────────────────────────────────────────

/** `Retry-After` header (seconds until the window's estimated end), or {} if unknown. */
function maintenanceRetryAfterHeaders(
  estimatedEnd: string | null,
): Record<string, string> {
  if (!estimatedEnd) return {};
  const secs = Math.ceil((new Date(estimatedEnd).getTime() - Date.now()) / 1000);
  return secs > 0 ? { "Retry-After": String(secs) } : {};
}

/**
 * Resolve the maintenance gate for a request.
 *
 * Returns a `NextResponse` to short-circuit the request, or `null` to continue
 * normally. Continues (null) when: phase is OFF, the path is exempt
 * (webhooks/health/auth/admin-maintenance/etc.), or a valid bypass secret is
 * present (operators previewing during a window).
 *
 * Behaviours when a window IS in force and no bypass:
 *   - OFFLINE  → 503 JSON for /api/*, else rewrite to the /maintenance page.
 *   - DEGRADED + write route (non-GET) → 503 JSON ("writes unavailable").
 *   - DEGRADED + read route → pass through WITH x-maintenance-* banner headers.
 *
 * GOTCHA for future devs: the DEGRADED read branch returns `NextResponse.next()`
 * and therefore SHORT-CIRCUITS the rest of the middleware — edge rate limiting
 * and the auth-cookie routing below do NOT run for reads during a DEGRADED
 * window. That's existing behaviour (banner-only degraded mode); change with care.
 */
function handleMaintenance(
  req: NextRequest,
  pathname: string,
  state: MaintenanceState,
): NextResponse | null {
  if (state.phase === "OFF" || isMaintenanceExempt(pathname)) return null;
  if (validateBypass(req, state.bypassSecret)) return null;

  const headers = maintenanceRetryAfterHeaders(state.estimatedEnd);

  if (state.phase === "OFFLINE") {
    // API callers get machine-readable 503 JSON, not rewritten HTML.
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        {
          error: "Service temporarily unavailable during maintenance",
          phase: "OFFLINE",
          reason: state.reason || null,
          estimatedEnd: state.estimatedEnd || null,
        },
        { status: 503, headers },
      );
    }
    const response = NextResponse.rewrite(new URL("/maintenance", req.url));
    for (const [key, value] of Object.entries(headers)) {
      response.headers.set(key, value);
    }
    return response;
  }

  // DEGRADED: block transactional writes; allow reads with banner headers.
  if (isWriteBlockedInDegraded(pathname, req.method)) {
    return NextResponse.json(
      {
        error: "Writes are temporarily unavailable during maintenance",
        phase: "DEGRADED",
        reason: state.reason || null,
        estimatedEnd: state.estimatedEnd || null,
      },
      { status: 503, headers },
    );
  }

  const response = NextResponse.next();
  response.headers.set("x-maintenance-phase", "degraded");
  response.headers.set(
    "x-maintenance-reason",
    encodeURIComponent(state.reason || ""),
  );
  response.headers.set(
    "x-maintenance-eta",
    encodeURIComponent(state.estimatedEnd || ""),
  );
  return response;
}

// ─────────────────────────────────────────────────────────────────────────────
// Edge rate limiting
//
// IP/org-keyed limits applied BEFORE any serverless function is invoked — this
// prevents cost amplification under DDoS even when every request would otherwise
// just return 429. Each limiter fails OPEN (Redis down → allowed) and only fires
// on the specific high-risk routes below; everything else is untouched.
//
// To add a limit: append a rule here. The table replaces what used to be a long
// chain of near-identical `if` blocks — keep the per-rule fields exact:
//   - `match`         : when the rule applies (path + method).
//   - `limiter`       : the shared bucket (defined in lib/rate-limit.ts).
//   - `key`           : bucket identifier; defaults to client IP. Return null to
//                       skip (e.g. a per-org bucket when the orgId can't be parsed).
//   - `skipLocalhost` : when true, dev/localhost requests bypass this limiter so
//                       local + e2e flows aren't blocked. PRESERVE the original
//                       per-rule value — it is intentionally inconsistent (the
//                       public read endpoints rate-limit even on localhost; the
//                       auth + enterprise write endpoints do not).
// ─────────────────────────────────────────────────────────────────────────────
type RateRule = {
  label: string;
  match: (pathname: string, method: string) => boolean;
  limiter: Ratelimit;
  key?: (pathname: string, clientIp: string) => string | null;
  skipLocalhost: boolean;
};

const RATE_LIMIT_RULES: RateRule[] = [
  {
    // Auth brute-force protection (POST only). `isBypassableIp` returns false in
    // production for every value (incl. the `unknown_ip` sentinel), so a
    // misconfigured proxy / missing header in prod still incurs the penalty.
    label: "auth: sign-in / sign-up / forget-password",
    match: (p, m) =>
      m === "POST" &&
      (p.startsWith("/api/auth/sign-in") ||
        p.startsWith("/api/auth/sign-up") ||
        p.startsWith("/api/auth/forget-password")),
    limiter: authLimiter,
    skipLocalhost: true,
  },
  {
    label: "public: consultant search / explore",
    match: (p) => p.startsWith("/api/user/consultants"),
    limiter: searchLimiter,
    skipLocalhost: false,
  },
  {
    label: "public: trial eligibility check",
    match: (p) => p.startsWith("/api/trials/check-eligibility"),
    limiter: eligibilityLimiter,
    skipLocalhost: false,
  },
  {
    label: "public: newsletter subscribe",
    match: (p, m) => m === "POST" && p.startsWith("/api/newsletter/subscribe"),
    limiter: newsletterLimiter,
    skipLocalhost: false,
  },
  {
    label: "public: booking-page availability",
    match: (p) => p.startsWith("/api/slots/availability/"),
    limiter: availabilityLimiter,
    skipLocalhost: false,
  },
  {
    // Invite-accept floods. orgId isn't in the URL (it's inside the invite token
    // body), so this is IP-keyed; org-level observability is the per-accept audit
    // log. Covers credential-stuffing against stolen invite tokens.
    label: "enterprise: org invite-accept",
    match: (p, m) =>
      m === "POST" && p === "/api/organizations/invitations/accept",
    limiter: orgInviteAcceptLimiter,
    skipLocalhost: true,
  },
  {
    // SSO domain-check enumeration. This pre-login endpoint returns
    // "enforceSSO: true" + org name for any recognised domain — hit in a loop it
    // leaks the tenant list. IP-keyed 60/hr is wide enough for a shared-office NAT.
    label: "enterprise: SSO domain-check",
    match: (p, m) => m === "GET" && p.startsWith("/api/auth/sso/domain-check"),
    limiter: ssoDomainCheckLimiter,
    skipLocalhost: true,
  },
  {
    // Wallet top-up create. orgId IS in the path
    // (/api/organizations/<orgId>/billing-account/wallet/top-ups), so key the
    // bucket per-org — one tenant can't DoS their own endpoint or mint hundreds
    // of Razorpay orders. `key` returns null if the orgId segment is missing,
    // which skips the limiter (preserving the original `if (orgId)` guard).
    label: "enterprise: wallet top-up (per-org)",
    match: (p, m) =>
      m === "POST" &&
      p.startsWith("/api/organizations/") &&
      p.endsWith("/billing-account/wallet/top-ups"),
    limiter: orgWalletTopUpLimiter,
    key: (p) => {
      const orgId = p.split("/")[3];
      return orgId ? `org:${orgId}` : null;
    },
    skipLocalhost: true,
  },
];

/**
 * Apply the first matching edge rate-limit rule. Returns a 429 response when a
 * limit is exceeded, else null. (Rules match disjoint paths, so at most one
 * applies per request; the loop still honours array order if that ever changes.)
 */
async function applyEdgeRateLimits(
  req: NextRequest,
  pathname: string,
): Promise<NextResponse | null> {
  const clientIp = getClientIp(req);
  const isLocalhost = isBypassableIp(clientIp);

  for (const rule of RATE_LIMIT_RULES) {
    if (rule.skipLocalhost && isLocalhost) continue;
    if (!rule.match(pathname, req.method)) continue;
    const id = rule.key ? rule.key(pathname, clientIp) : clientIp;
    if (id == null) continue;
    const limited = await applyRateLimit(rule.limiter, id);
    if (limited) return limited;
  }
  return null;
}

/**
 * Cookie-based middleware — no DB hit, no JWT parsing. See the header block above
 * for the auth model and the per-stage rationale.
 */
export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;

  // 1a. Static assets / Next internals — nothing to gate. (Mostly excluded by
  // `config.matcher` already; this is a cheap belt-and-suspenders.)
  if (
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/favicon") ||
    HAS_FILE_EXTENSION.test(pathname)
  ) {
    return NextResponse.next();
  }

  // 1b. SCIM 2.0 self-authenticates via bearer tokens — it's the surface IdPs
  // (Okta, Azure AD) hit when provisioning. A session-cookie check here would
  // mis-classify it as an unauth user and bounce it to /auth/signin. The route
  // handler enforces token auth + rate limit + per-org scoping. See
  // lib/scim/auth.ts and docs/enterprise/20-iam-and-security/03-scim-provisioning.md.
  if (pathname.startsWith("/scim/v2/")) {
    return NextResponse.next();
  }

  // 2. Maintenance gate (fail-open; 30s-cached read).
  const maintenance = handleMaintenance(
    req,
    pathname,
    await getMaintenanceState(),
  );
  if (maintenance) return maintenance;

  // 3. Edge rate limiting.
  const rateLimited = await applyEdgeRateLimits(req, pathname);
  if (rateLimited) return rateLimited;

  // 4. Auth routing (cookie presence only).

  // Public API routes first (most common; no auth) — must precede the
  // authenticated-prefix check so public sub-routes shadow their private parent.
  if (matchesAnyPrefix(pathname, ROUTE_PATTERNS.PUBLIC_API_PREFIXES)) {
    return NextResponse.next();
  }

  const isAuthenticated = !!getSessionCookie(req);

  // Authenticated API routes — 401 JSON without a session cookie.
  if (matchesAnyPrefix(pathname, ROUTE_PATTERNS.AUTHENTICATED_API_PREFIXES)) {
    return isAuthenticated
      ? NextResponse.next()
      : NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Public auth routes (/auth/*) — always allow through.
  // Do NOT redirect cookie-present users to /dashboard here: cookie presence ≠
  // session validity, and a stale cookie (DB session gone) would cause an
  // infinite redirect loop (requireOnboarded() → /auth/signin → /dashboard →
  // /auth/signin). The signin/signup pages redirect authenticated users via
  // useSession()/useEffect instead.
  if (matchesAnyPrefix(pathname, ROUTE_PATTERNS.PUBLIC_AUTH_PREFIXES)) {
    return NextResponse.next();
  }

  // Protected app routes — redirect to signin (preserving callbackUrl) when no
  // session cookie. SSO enforcement is NOT done here: customSession() in
  // lib/auth.ts marks `ssoEnforcementFailed` on the session and layouts/server
  // components redirect on it. We can't call getSession() at the edge (see the
  // header block).
  if (matchesAnyPrefix(pathname, ROUTE_PATTERNS.PROTECTED_PREFIXES)) {
    if (!isAuthenticated) {
      const signInUrl = new URL(URLS.SIGNIN, req.url);
      signInUrl.searchParams.set("callbackUrl", pathname + req.nextUrl.search);
      return NextResponse.redirect(signInUrl);
    }
    return NextResponse.next();
  }

  // Everything else (public pages) — allow.
  return NextResponse.next();
}

// Matcher: run middleware on all routes except static files / Next internals,
// plus all API routes. Keep in sync with the static-asset skip in middleware().
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)",
    "/api/(.*)",
  ],
};
