import { getSessionCookie } from "better-auth/cookies";
import { NextRequest, NextResponse, NextFetchEvent } from "next/server";

import {
  getMaintenanceState,
  getMaintenanceStateCachedOnly,
  isMaintenanceExempt,
  validateBypass,
  isWriteBlockedInDegraded,
  HAS_FILE_EXTENSION,
  type MaintenanceState,
} from "@/lib/maintenance-edge";
import {
  sessionMgmtLimiter,
  searchLimiter,
  eligibilityLimiter,
  waitlistLimiter,
  availabilityLimiter,
  availabilityGridLimiter,
  orgWalletTopUpLimiter,
  applyRateLimit,
  getClientIp,
  isBypassableIp,
  streamJoinLimiter,
  streamApiLimiter,
  isRateLimitDegraded,
  RATE_LIMIT_DEGRADED_HEADER,
} from "@/lib/rate-limit";
import {
  RATE_POLICIES,
  RATE_SCOPE,
  limiterFor,
  tokenKey,
  type RateDimension,
  type RateScope,
} from "@/lib/rate-limit/policies";
import { Ratelimit } from "@upstash/ratelimit";

// ─────────────────────────────────────────────────────────────────────────────
// What this middleware does, in order (see `middleware()` at the bottom):
//   1. Skip static assets / Next internals (no auth concerns).
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
    "/api/scheduling/", // Private: appointment slot data and mutations
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
    "/api/organizations/public", // Public: explore organisations directory (shadows the private /api/organizations/ parent)
    "/api/user/consultants", // Public: explore experts list and individual profiles
    "/api/user/reviews", // Public: consultant reviews
    "/api/plans/classes", // Public: browse and view class plans (sub-routes enforce their own auth)
    "/api/plans/webinars", // Public: browse and view webinar plans (sub-routes enforce their own auth)
    "/api/explore/recordings", // Public: #366 recordings library listing (metadata only; playback is authed)
    "/api/scheduling/availability/", // Public: consultant availability for booking page
    "/api/scheduling/availability-with-allocation/", // Public: consultant availability with allocation info
  ],
};

/**
 * Fast route matching using string prefix checks instead of glob patterns.
 * Also matches the exact path without trailing slash (e.g. "/settings" matches
 * the "/settings/" prefix).
 */
const matchesAnyPrefix = (pathname: string, prefixes: string[]): boolean => {
  for (const prefix of prefixes) {
    // Match on SEGMENT boundaries. A bare startsWith let a prefix without a
    // trailing slash leak across the boundary — "/api/organizations/public"
    // would also match "/api/organizations/publicfoo", handing an unintended
    // route the public exemption. Intended matches (exact path, or any deeper
    // segment) are unchanged.
    const base = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
    if (pathname === base || pathname.startsWith(`${base}/`)) return true;
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
  const secs = Math.ceil(
    (new Date(estimatedEnd).getTime() - Date.now()) / 1000,
  );
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
 *   - DEGRADED + read route → continue, and stamp x-maintenance-* banner
 *     headers on whatever the rest of the middleware answers.
 *
 * #1599 — the DEGRADED read branch used to return `NextResponse.next()`
 * here, which skipped the edge rate limiter and the cookie routing for every
 * read during a window. It now hands the banner headers back so the caller
 * runs the limiter and the auth routing first and stamps them on the result.
 */
type MaintenanceGate =
  | { kind: "respond"; response: NextResponse }
  | { kind: "banner"; headers: Record<string, string> };

function handleMaintenance(
  req: NextRequest,
  pathname: string,
  state: MaintenanceState,
): MaintenanceGate | null {
  if (state.phase === "OFF" || isMaintenanceExempt(pathname)) return null;
  if (validateBypass(req, state.bypassSecret)) return null;

  const headers = maintenanceRetryAfterHeaders(state.estimatedEnd);

  if (state.phase === "OFFLINE") {
    // API callers get machine-readable 503 JSON, not rewritten HTML.
    if (pathname.startsWith("/api/")) {
      return {
        kind: "respond",
        response: NextResponse.json(
          {
            error: "Service temporarily unavailable during maintenance",
            phase: "OFFLINE",
            reason: state.reason || null,
            estimatedEnd: state.estimatedEnd || null,
          },
          { status: 503, headers },
        ),
      };
    }
    const response = NextResponse.rewrite(new URL("/maintenance", req.url));
    for (const [key, value] of Object.entries(headers)) {
      response.headers.set(key, value);
    }
    return { kind: "respond", response };
  }

  // DEGRADED: block transactional writes; allow reads with banner headers.
  if (
    isWriteBlockedInDegraded(pathname, req.method, req.nextUrl.searchParams)
  ) {
    return {
      kind: "respond",
      response: NextResponse.json(
        {
          error: "Writes are temporarily unavailable during maintenance",
          phase: "DEGRADED",
          reason: state.reason || null,
          estimatedEnd: state.estimatedEnd || null,
        },
        { status: 503, headers },
      ),
    };
  }

  return {
    kind: "banner",
    headers: {
      "x-maintenance-phase": "degraded",
      "x-maintenance-reason": encodeURIComponent(state.reason || ""),
      "x-maintenance-eta": encodeURIComponent(state.estimatedEnd || ""),
    },
  };
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
//                       May be async — per-token buckets have to hash, and
//                       hashing is Web Crypto, which is promise-returning.
//   - `skipLocalhost` : when true, dev/localhost requests bypass this limiter so
//                       local + e2e flows aren't blocked. PRESERVE the original
//                       per-rule value — it is intentionally inconsistent (the
//                       public read endpoints rate-limit even on localhost; the
//                       auth + enterprise write endpoints do not).
//
// The AUTH rules are not written here at all. They are generated from
// `POLICY_ROUTES` (below) so that a rule cannot name a budget the policy table
// does not declare. See the block comment there for why.
// ─────────────────────────────────────────────────────────────────────────────
type RateRule = {
  label: string;
  match: (pathname: string, method: string) => boolean;
  limiter: Ratelimit;
  /**
   * The policy this rule spends, when it spends one. Carried as a field rather
   * than parsed back out of `label` so the scope reported in the 429 body
   * cannot drift from the limiter that produced it.
   */
  scope?: RateScope;
  key?: (
    pathname: string,
    clientIp: string,
  ) => string | null | Promise<string | null>;
  skipLocalhost: boolean;
};

/**
 * Which policy covers which edge path.
 *
 * The number, the window, the `scope` string the 429 reports and the Redis
 * prefix all come from `lib/rate-limit/policies.ts`. This list contributes only
 * the one thing a budget cannot know about itself: the route.
 *
 * ## The path list is now the only place a path can be wrong
 *
 * It used to be one of three. The bug this replaced: the auth rule matched
 * `/api/auth/forget-password`, and BetterAuth has never had an endpoint by that
 * name — it is `/api/auth/request-password-reset` (`password.mjs:20`). The
 * prefix silently never matched, so the whole forgot-password flow ran
 * unthrottled, including the response that distinguishes a registered address
 * from an unregistered one. Endpoint names below are quoted from
 * `node_modules/better-auth/dist/api/routes/*.mjs` and
 * `node_modules/@better-auth/sso/dist/`; a typo here is a silent hole again, so
 * a rename upstream has to be reflected in this list on purpose.
 *
 * The matchers are deliberately **disjoint** — each is a full sub-path, not a
 * shared prefix. `/api/auth/sign-in` is three different budgets (`/email`,
 * `/social`, `/sso`), so an overlapping matcher would spend two counters on one
 * request and return whichever of the two verdicts came first.
 *
 * ## What is still deliberately NOT covered
 *
 * Carried over verbatim from the #1856 rule this replaces: **not** `sign-out`,
 * `update-user`, `link-social`, `unlink-account` or `revoke-other-sessions`.
 * All are session-bound with no guessable secret, and throttling sign-out is
 * actively harmful — it strands a user on a device they are trying to
 * decommission, which is the one moment a limit is most likely to cost a
 * compromised account its owner. `isBypassableIp` returns false in production
 * for every value including the `unknown_ip` sentinel, so a misconfigured proxy
 * or a stripped header in prod still pays the full penalty on every rule here.
 *
 * ## Which dimensions the edge can spend, and which it cannot
 *
 * The edge sees the method, the path and a few headers. It **cannot read the
 * request body** — consuming the stream in middleware strands the handler, and
 * `NextRequest` offers no rewind. BetterAuth puts its secrets in JSON bodies:
 * `sign-in/email` `{email, password}`, `sign-up/email`, `request-password-reset`
 * `{email}`, `send-verification-email` `{email}`, `reset-password`
 * `{newPassword, token}` (`password.mjs:120`), and the invite `invitationId`.
 *
 * So the rules below spend **only the `ip` dimension**, with one exception, and
 * the per-account and per-token budgets the policies declare are spent by the
 * handlers that parse those bodies:
 *
 *     limiterFor(RATE_SCOPE.AUTH_SIGN_IN, "account")
 *     limiterFor(RATE_SCOPE.AUTH_PASSWORD_RESET_SUBMIT, "token")
 *     limiterFor(RATE_SCOPE.INVITE_ACCEPT, "token")
 *
 * The exception is `GET /api/auth/reset-password/:token`, which carries its
 * secret in the path and therefore is keyable here. It is the one budget worth
 * having at the edge: a reset token is a bearer credential, and a per-token
 * bucket is what turns a leaked link into a bounded number of attempts rather
 * than an open door.
 *
 * Hashing for that key is Web Crypto (`crypto.subtle.digest` in `policies.ts`),
 * not `node:crypto` — which does not exist in the Edge runtime, so importing it
 * here would fail the build outright rather than degrade gracefully.
 */
type PolicyRoute = {
  scope: RateScope;
  match: (pathname: string, method: string) => boolean;
  /** Which declared budget to spend. Defaults to `ip`. */
  dimension?: RateDimension;
  key?: (
    pathname: string,
    clientIp: string,
  ) => string | null | Promise<string | null>;
};

const POLICY_ROUTES: PolicyRoute[] = [
  {
    // sign-in.mjs:9 — `method: "POST"`.
    scope: RATE_SCOPE.AUTH_SIGN_IN,
    match: (p, m) => m === "POST" && p.startsWith("/api/auth/sign-in/email"),
  },
  {
    // sign-up.mjs:4 — `method: "POST"`.
    scope: RATE_SCOPE.AUTH_SIGN_UP,
    match: (p, m) => m === "POST" && p.startsWith("/api/auth/sign-up/email"),
  },
  {
    // password.mjs:20 — `method: "POST"`, body `{ email, redirectTo }`.
    // The route the old `forget-password` prefix was reaching for. Its response
    // is deliberately uniform, but only the budget is uniform; three an hour
    // per address is what makes an address-list walk expensive.
    scope: RATE_SCOPE.AUTH_PASSWORD_RESET_REQUEST,
    match: (p, m) =>
      m === "POST" && p.startsWith("/api/auth/request-password-reset"),
  },
  {
    // password.mjs:120 — `method: "POST"`, body `{ newPassword, token }`. The
    // token may also arrive as a query param, but keying on it *only when
    // present* would be a bypass: drop the query and the budget reverts to the
    // IP one. So this rule is IP-keyed and the per-token budget is spent by
    // the handler that actually holds the body.
    scope: RATE_SCOPE.AUTH_PASSWORD_RESET_SUBMIT,
    match: (p, m) => m === "POST" && p.startsWith("/api/auth/reset-password"),
  },
  {
    // password.mjs:83 — `method: "GET"`, token in the path. The one auth secret
    // the edge can key on, and the one where it matters most: a reset token is a
    // bearer credential, so this bucket is what turns a leaked link from a
    // takeover into ten uses an hour. Hashed, never the token itself — Redis
    // keys are plaintext at rest and visible in MONITOR.
    scope: RATE_SCOPE.AUTH_PASSWORD_RESET_SUBMIT,
    dimension: "token",
    match: (p, m) => m === "GET" && p.startsWith("/api/auth/reset-password/"),
    key: (p) => {
      const token = p.split("/")[4];
      return token ? tokenKey(token) : null;
    },
  },
  {
    // email-verification.mjs — `method: "POST"`, body `{ email, callbackURL }`.
    // Was unthrottled entirely: one POST per call, addressed to anyone, at our
    // sending reputation and bounce rate.
    scope: RATE_SCOPE.AUTH_SEND_VERIFICATION,
    match: (p, m) =>
      m === "POST" && p.startsWith("/api/auth/send-verification-email"),
  },
  {
    // email-verification.mjs:109 — `method: "GET"`, `?token=` in the query.
    scope: RATE_SCOPE.AUTH_VERIFY_EMAIL,
    match: (p, m) => m === "GET" && p.startsWith("/api/auth/verify-email"),
  },
  {
    // sign-in.mjs — `/sign-in/social` POST (out to the IdP) and
    // `callback.mjs` — `/callback/:id` GET (the redirect landing). Both halves
    // of one round-trip, and a user on a flaky connection retries several times
    // inside one window, which is why the policy is IP-only and generous.
    scope: RATE_SCOPE.AUTH_SOCIAL,
    match: (p, m) =>
      (m === "POST" && p.startsWith("/api/auth/sign-in/social")) ||
      (m === "GET" && p.startsWith("/api/auth/callback/")),
  },
  {
    // @better-auth/sso — `/sign-in/sso` POST. The redirect out to the
    // corporate IdP; the per-account half of the policy is handler-enforced,
    // since an unauthenticated caller may not know which address they are yet.
    scope: RATE_SCOPE.AUTH_SSO_START,
    match: (p, m) => m === "POST" && p.startsWith("/api/auth/sign-in/sso"),
  },
  {
    // @better-auth/sso — both callback halves, and SAML is enabled here
    // (`sso()` is registered in lib/auth.ts, and lib/sso/derive-urls.ts builds
    // the ACS URL), so leaving the SAML leg out would leave half of enterprise
    // sign-in on no budget at all:
    //   GET  /api/auth/sso/callback[/:providerId]   — OIDC redirect landing
    //   POST /api/auth/sso/saml2/sp/acs[/:providerId] — SAML HTTP-POST binding
    // IP-keyed because both are the *user's browser* arriving from their IdP, so
    // the address is the person's, not the provider's — the same shape as the
    // OIDC sign-in that has always been keyed this way.
    //
    // EXCLUDED on purpose: `/sso/saml2/sp/metadata` and `/sso/saml2/sp/slo` /
    // `/sso/saml2/logout`. Those are fetched by the *IdP*, from its own shared
    // infrastructure, and one egress address serves a whole tenant. A per-IP
    // bucket there would be a single corporate NAT throttling every employee in
    // the building, and the traffic is machine cadence anyway — the abuse
    // surface is nil, since the ACS signature is the actual gate.
    scope: RATE_SCOPE.AUTH_SSO_CALLBACK,
    match: (p, m) =>
      (m === "GET" && p.startsWith("/api/auth/sso/callback")) ||
      (m === "POST" && p.startsWith("/api/auth/sso/saml2/sp/acs")),
  },
  {
    // account.mjs — `method: "POST"`, session-bound and gated on the CURRENT
    // password, so a stolen session turns it into a guessing surface.
    scope: RATE_SCOPE.AUTH_CHANGE_PASSWORD,
    match: (p, m) => m === "POST" && p.startsWith("/api/auth/change-password"),
  },
  {
    // Pre-login and returns `enforceSSO` + org name for any recognised domain,
    // so hit in a loop it enumerates the whole enterprise customer base. On the
    // critical path of every corporate sign-in, hence the raise to 120/hr for
    // shared-office NATs. Disjoint from the callback rule above: `domain-check`
    // is not a `callback` prefix.
    scope: RATE_SCOPE.SSO_DOMAIN_CHECK,
    match: (p, m) => m === "GET" && p.startsWith("/api/auth/sso/domain-check"),
  },
  {
    // Credential stuffing against stolen invite links. `invitationId` is in the
    // POST body, so this rule spends the IP budget and the per-invitation one
    // is handler-enforced.
    scope: RATE_SCOPE.INVITE_ACCEPT,
    match: (p, m) =>
      m === "POST" && p === "/api/organizations/invitations/accept",
  },
];

const POLICY_RATE_LIMIT_RULES: RateRule[] = POLICY_ROUTES.map((route) => ({
  label: `policy: ${route.scope}`,
  match: route.match,
  limiter: limiterFor(route.scope, route.dimension ?? "ip"),
  scope: route.scope,
  key: route.key,
  // Uniform across the whole table, and matching every auth/enterprise rule
  // this replaces. The deliberate inconsistency in the wider table (public
  // reads limit even on localhost) is preserved on the hand-written rules
  // below; none of them govern a credential path, where a developer running
  // `npm run dev` behind the same IP as their other services should not be able
  // to lock themselves out of signing in.
  skipLocalhost: true,
}));

/**
 * Every declared policy must be reachable from `POLICY_ROUTES`, or it is dead
 * configuration that reads as protection.
 *
 * The mirror image of the bug this file replaced, and the reason it is worth
 * the four lines: that rule was not missing from the *table*, it was missing
 * from the *matcher*, which is exactly the kind of gap that survives review and
 * a test that only asserts the limiter exists. Warned rather than thrown
 * because a hard failure here would take the whole edge down over a
 * bookkeeping slip; a declared-but-unwired budget is an under-enforcement, not
 * an outage, and the log is where that belongs.
 */
const UNWIRED_SCOPES = (Object.keys(RATE_POLICIES) as RateScope[]).filter(
  (scope) => !POLICY_ROUTES.some((route) => route.scope === scope),
);
if (UNWIRED_SCOPES.length > 0) {
  console.error(
    `[middleware] rate-limit policies declared but never matched at the ` +
      `edge, so no budget is being spent on them: ${UNWIRED_SCOPES.join(", ")}. ` +
      `Either add a POLICY_ROUTES entry or drop the policy.`,
  );
}

const RATE_LIMIT_RULES: RateRule[] = [
  ...POLICY_RATE_LIMIT_RULES,
  {
    // #1856 — session/device management. Own limiter, not the auth budget:
    // the device list reloads after every revoke and none of that
    // traffic may eat the AUTH_SIGN_IN budget. IP-keyed (middleware is
    // cookie-presence only and cannot resolve a user id — see the
    // meeting-join rule).
    //
    // The liveness probe (`/current`) is EXEMPT: every open tab calls it
    // on focus, and it must not spend the device list's budget. It needs
    // a valid session cookie and returns only the caller's own status.
    label: "auth: session/device management",
    match: (p) =>
      p.startsWith("/api/user/sessions") &&
      !p.startsWith("/api/user/sessions/current"),
    limiter: sessionMgmtLimiter,
    skipLocalhost: true,
  },
  {
    // #1134 P1-11 — the meeting join gate. Call ids are deterministic
    // (`occurrence-<occurrenceId>`), so this is the enumeration surface: without a
    // limit, someone holding one occurrence id can walk neighbours and probe which
    // meetings they can reach.
    //
    // Keyed by IP, NOT by user — an earlier version of this comment claimed the
    // opposite. `applyEdgeRateLimits` falls back to the client IP whenever a
    // rule supplies no `key`, and this rule supplies none. Per-user keying is
    // not available here by design: this middleware is cookie-presence only,
    // with no DB hit and no JWT parsing, so it cannot resolve a user id cheaply.
    //
    // IP-keying is the right shape for enumeration anyway, since a walker works
    // from one address. The cost is that users behind a shared NAT share a
    // bucket, which is why the limit is generous rather than tight.
    label: "stream: meeting join",
    match: (p, m) => m === "POST" && /^\/api\/meetings\/[^/]+\/join$/.test(p),
    limiter: streamJoinLimiter,
    skipLocalhost: true,
  },
  {
    // Ordinary authenticated Stream reads/writes — search, channel create,
    // block. Unbounded before, and each one costs a billable Stream API call.
    //
    // EXCLUDES the webhook endpoint. Stream POSTs every delivery from its own
    // infrastructure, so they all collapse onto one rate-limit key, and a burst
    // is the normal shape — a 200-attendee webinar emits 200
    // `call.session_participant_joined` events at once. A 429 there is not a
    // deferral: Stream retries inside a fifteen-second total budget and then
    // DROPS the event permanently, which is precisely the loss #1137's
    // ack-first/persist-first work exists to prevent. Throttling it would have
    // undone that from the middleware, before the route ever ran.
    //
    // Safe to exclude because the endpoint is not open: it verifies an HMAC
    // signature against the API secret and 401s anything unsigned before doing
    // any work. The signature is the gate, not the limiter.
    label: "stream: api",
    match: (p) =>
      p.startsWith("/api/stream/") && !p.startsWith("/api/stream/webhooks"),
    limiter: streamApiLimiter,
    skipLocalhost: true,
  },
  {
    label: "public: consultant search / explore",
    match: (p) => p.startsWith("/api/user/consultants"),
    limiter: searchLimiter,
    skipLocalhost: false,
  },
  {
    // #1244 review — public + query-parameter-driven DB reads need a gate so
    // `search`/`tag` variation can't hammer Postgres unauthenticated.
    label: "public: recordings library browse",
    match: (p) => p.startsWith("/api/explore/recordings"),
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
    label: "public: waitlist signup",
    match: (p, m) => m === "POST" && p === "/api/waitlist",
    limiter: waitlistLimiter,
    skipLocalhost: false,
  },
  {
    label: "public: booking-page availability",
    match: (p) => p.startsWith("/api/scheduling/availability/"),
    limiter: availabilityLimiter,
    skipLocalhost: false,
  },
  {
    // #1697 item 2 — a different prefix, so the rule above never matched the
    // polling grid; it was the hottest unthrottled read in the app.
    label: "public: availability grid (with allocation)",
    match: (p) => p.startsWith("/api/scheduling/availability-with-allocation/"),
    limiter: availabilityGridLimiter,
    skipLocalhost: false,
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

type RateLimitOutcome = {
  /** A 429 to return immediately, or null to continue. */
  limited: NextResponse | null;
  /**
   * True when a limiter check in this request failed because the store was
   * unreachable, so the budgets that would otherwise have applied were not
   * enforced. See `RATE_LIMIT_DEGRADED_HEADER` in lib/rate-limit.ts for what a
   * consumer is meant to do about it — the short version is "raise the price of
   * a guess, do not lock the site down".
   */
  degraded: boolean;
};

/**
 * Apply the first matching edge rate-limit rule. Returns a 429 response when a
 * limit is exceeded, else null. (Rules match disjoint paths, so at most one
 * applies per request; the loop still honours array order if that ever changes.)
 *
 * Two policies deliberately spend two budgets on one request — the two halves
 * of the password-reset token flow — so the loop does not stop at the first
 * rule that matches; it stops at the first rule that actually 429s. That keeps a
 * caller from skipping the second bucket by tripping the first.
 */
async function applyEdgeRateLimits(
  req: NextRequest,
  pathname: string,
): Promise<RateLimitOutcome> {
  const clientIp = getClientIp(req);
  const isLocalhost = isBypassableIp(clientIp);
  let limited: NextResponse | null = null;

  for (const rule of RATE_LIMIT_RULES) {
    if (rule.skipLocalhost && isLocalhost) continue;
    if (!rule.match(pathname, req.method)) continue;
    // `key` may be async: the per-token buckets hash the secret, and hashing is
    // Web Crypto. `applyRateLimit`'s scope argument is what puts the policy's
    // stable identifier in the 429 body, so a client can tell which budget it
    // spent without string-matching the error sentence.
    const id = rule.key ? await rule.key(pathname, clientIp) : clientIp;
    if (id === null) continue;
    const verdict = await applyRateLimit(rule.limiter, id, rule.scope);
    if (verdict && !limited) limited = verdict;
  }

  const degraded = isRateLimitDegraded();
  // Also on the 429, so the client can see *why* it was refused: "over quota"
  // and "we could not check your quota" are different support conversations,
  // and only the second is worth waking someone for.
  if (limited && degraded) {
    limited.headers.set(RATE_LIMIT_DEGRADED_HEADER, "1");
  }
  return { limited, degraded };
}

/**
 * Cookie-based middleware — no DB hit, no JWT parsing. See the header block above
 * for the auth model and the per-stage rationale.
 */
export async function middleware(
  req: NextRequest,
  event: NextFetchEvent,
): Promise<NextResponse> {
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

  // 2. Maintenance gate (fail-open; 30s-cached read). RSC/prefetch sub-navigation
  // fetches use the cached value only — no blocking Upstash round-trip — so a soft
  // navigation can't sit blank before its loading.tsx streams. A full document
  // load still does the live read, so a maintenance window is enforced within one
  // navigation / the 30s cache window.
  const isSubNavigation =
    req.headers.get("Next-Router-Prefetch") === "1" ||
    req.headers.get("RSC") === "1";
  const maintenanceState = isSubNavigation
    ? getMaintenanceStateCachedOnly(event.waitUntil.bind(event))
    : await getMaintenanceState();
  const maintenance = handleMaintenance(req, pathname, maintenanceState);
  if (maintenance?.kind === "respond") return maintenance.response;

  const response = await routeRequest(req, pathname);
  // A DEGRADED read carries the banner headers on top of whatever the limiter
  // and the cookie routing decided, instead of skipping them (#1599).
  if (maintenance?.kind === "banner") {
    for (const [key, value] of Object.entries(maintenance.headers)) {
      response.headers.set(key, value);
    }
  }
  return response;
}

/** Steps 3–4: the edge rate limiter, then cookie-presence auth routing. */
async function routeRequest(
  req: NextRequest,
  pathname: string,
): Promise<NextResponse> {
  // 3. Edge rate limiting.
  const { limited: rateLimited, degraded } = await applyEdgeRateLimits(
    req,
    pathname,
  );
  if (rateLimited) return rateLimited;

  // Carry the degradation flag to whatever runs next.
  //
  // `isRateLimitDegraded()` cannot be read from the handler: middleware and
  // route handlers are separate isolates with separate module graphs, so a
  // module-level flag set in here is always `false` over there. The request
  // header is the only channel across that boundary, which makes this the
  // single point where it has to be stamped.
  //
  // Only forwarded when degraded, and only on branches that actually have a
  // downstream consumer — a 401 or a redirect has no handler to inform, and
  // `NextResponse.next({request:{headers}})` is not free to set up on a path
  // that never needs it.
  const degradedForward: Record<string, string> = degraded
    ? { [RATE_LIMIT_DEGRADED_HEADER]: "1" }
    : {};

  /** Pass-through, forwarding the degradation flag when one is set. */
  const next = (extra?: Record<string, string>): NextResponse => {
    if (!degraded && !extra) return NextResponse.next();
    const requestHeaders = new Headers(req.headers);
    for (const [key, value] of Object.entries({
      ...degradedForward,
      ...extra,
    })) {
      requestHeaders.set(key, value);
    }
    return NextResponse.next({ request: { headers: requestHeaders } });
  };

  // 4. Auth routing (cookie presence only).

  // Public API routes first (most common; no auth) — must precede the
  // authenticated-prefix check so public sub-routes shadow their private parent.
  // This is the branch that matters for the flag: it is where
  // /api/auth/[...all] — and therefore the captcha gate that will read it — lands.
  if (matchesAnyPrefix(pathname, ROUTE_PATTERNS.PUBLIC_API_PREFIXES)) {
    return next();
  }

  const isAuthenticated = !!getSessionCookie(req);

  // Authenticated API routes — 401 JSON without a session cookie.
  if (matchesAnyPrefix(pathname, ROUTE_PATTERNS.AUTHENTICATED_API_PREFIXES)) {
    return isAuthenticated
      ? next()
      : NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Public auth routes (/auth/*) — always allow through.
  // Do NOT redirect cookie-present users to /dashboard here: cookie presence ≠
  // session validity, and a stale cookie (DB session gone) would cause an
  // infinite redirect loop (requireOnboarded() → /auth/signin → /dashboard →
  // /auth/signin). The signin/signup pages redirect authenticated users via
  // useSession()/useEffect instead.
  if (matchesAnyPrefix(pathname, ROUTE_PATTERNS.PUBLIC_AUTH_PREFIXES)) {
    return next();
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
    // Expose the resolved path so server guards (requireOnboarded) can send an
    // authenticated-but-not-onboarded user back to their intended destination
    // after onboarding, instead of dropping them on the dashboard.
    return next({ "x-pathname": pathname + req.nextUrl.search });
  }

  // Everything else (public pages) — allow.
  return next();
}

// Matcher: run middleware on all routes except static files / Next internals,
// plus all API routes. Keep in sync with the static-asset skip in middleware().
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)",
    "/api/(.*)",
  ],
};
