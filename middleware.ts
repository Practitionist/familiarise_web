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
  ssoDomainCheckLimiter,
  inviteAcceptIpLimiter,
  applyRateLimit,
  getClientIp,
  isBypassableIp,
  streamJoinLimiter,
  streamApiLimiter,
} from "@/lib/rate-limit";
import { Ratelimit } from "@upstash/ratelimit";

const URLS = {
  SIGNIN: "/auth/signin",
};

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
  AUTHENTICATED_API_PREFIXES: [
    "/api/form/onboarding/",
    "/api/verification/",
    "/api/user/",
    "/api/bookings/",
    "/api/plans/",
    "/api/participants/",
    "/api/dashboard/",
    "/api/trials/",
    "/api/scheduling/",
    "/api/admin/",
    "/api/staff/",
    "/api/organizations/",
  ],
  // Matched before AUTHENTICATED_API_PREFIXES, so a public sub-route shadows
  // its private parent; mutation/private sub-routes enforce auth in-handler.
  PUBLIC_API_PREFIXES: [
    "/api/auth/",
    "/api/health/",
    "/api/organizations/public",
    "/api/user/consultants",
    "/api/user/reviews",
    "/api/plans/classes",
    "/api/plans/webinars",
    "/api/plans/consultations",
    "/api/plans/subscriptions",
    "/api/explore/recordings",
    "/api/scheduling/availability/",
    "/api/scheduling/availability-with-allocation/",
  ],
};

const matchesAnyPrefix = (pathname: string, prefixes: string[]): boolean => {
  for (const prefix of prefixes) {
    const base = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
    if (pathname === base || pathname.startsWith(`${base}/`)) return true;
  }
  return false;
};

function maintenanceRetryAfterHeaders(
  estimatedEnd: string | null,
): Record<string, string> {
  if (!estimatedEnd) return {};
  const secs = Math.ceil(
    (new Date(estimatedEnd).getTime() - Date.now()) / 1000,
  );
  return secs > 0 ? { "Retry-After": String(secs) } : {};
}

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

type RateRule = {
  label: string;
  match: (pathname: string, method: string) => boolean;
  limiter: Ratelimit;
  scope?: string;
  key?: (pathname: string, clientIp: string) => string | null;
  skipLocalhost: boolean;
};

const RATE_LIMIT_RULES: RateRule[] = [
  {
    label: "policy: enterprise.sso-domain-check",
    match: (p, m) => m === "GET" && p.startsWith("/api/auth/sso/domain-check"),
    limiter: ssoDomainCheckLimiter,
    scope: "enterprise.sso-domain-check",
    skipLocalhost: true,
  },
  {
    label: "policy: enterprise.org-invite-accept",
    match: (p, m) =>
      m === "POST" && p === "/api/organizations/invitations/accept",
    limiter: inviteAcceptIpLimiter,
    scope: "enterprise.org-invite-accept",
    skipLocalhost: true,
  },
  {
    label: "auth: session/device management",
    match: (p) =>
      p.startsWith("/api/user/sessions") &&
      !p.startsWith("/api/user/sessions/current"),
    limiter: sessionMgmtLimiter,
    skipLocalhost: true,
  },
  {
    // Keyed by IP, NOT by user.
    label: "stream: meeting join",
    match: (p, m) => m === "POST" && /^\/api\/meetings\/[^/]+\/join$/.test(p),
    limiter: streamJoinLimiter,
    skipLocalhost: true,
  },
  {
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
    label: "public: availability grid (with allocation)",
    match: (p) => p.startsWith("/api/scheduling/availability-with-allocation/"),
    limiter: availabilityGridLimiter,
    skipLocalhost: false,
  },
  {
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
    if (id === null) return null;
    return applyRateLimit(rule.limiter, id, rule.scope);
  }
  return null;
}

export async function middleware(
  req: NextRequest,
  event: NextFetchEvent,
): Promise<NextResponse> {
  const { pathname } = req.nextUrl;

  if (
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/favicon") ||
    HAS_FILE_EXTENSION.test(pathname)
  ) {
    return NextResponse.next();
  }

  const isSubNavigation =
    req.headers.get("Next-Router-Prefetch") === "1" ||
    req.headers.get("RSC") === "1";
  const maintenanceState = isSubNavigation
    ? getMaintenanceStateCachedOnly(event.waitUntil.bind(event))
    : await getMaintenanceState();
  const maintenance = handleMaintenance(req, pathname, maintenanceState);
  if (maintenance?.kind === "respond") return maintenance.response;

  const response = await routeRequest(req, pathname);
  if (maintenance?.kind === "banner") {
    for (const [key, value] of Object.entries(maintenance.headers)) {
      response.headers.set(key, value);
    }
  }
  return response;
}

async function routeRequest(
  req: NextRequest,
  pathname: string,
): Promise<NextResponse> {
  const rateLimited = await applyEdgeRateLimits(req, pathname);
  if (rateLimited) return rateLimited;

  const next = (extra?: Record<string, string>): NextResponse => {
    const spoofedPath = req.headers.has("x-pathname");
    if (!extra && !spoofedPath) return NextResponse.next();
    const requestHeaders = new Headers(req.headers);
    requestHeaders.delete("x-pathname");
    for (const [key, value] of Object.entries(extra ?? {})) {
      requestHeaders.set(key, value);
    }
    return NextResponse.next({ request: { headers: requestHeaders } });
  };

  if (matchesAnyPrefix(pathname, ROUTE_PATTERNS.PUBLIC_API_PREFIXES)) {
    return next();
  }

  const isAuthenticated = !!getSessionCookie(req);

  if (matchesAnyPrefix(pathname, ROUTE_PATTERNS.AUTHENTICATED_API_PREFIXES)) {
    return isAuthenticated
      ? next()
      : NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (matchesAnyPrefix(pathname, ROUTE_PATTERNS.PUBLIC_AUTH_PREFIXES)) {
    return next();
  }

  if (matchesAnyPrefix(pathname, ROUTE_PATTERNS.PROTECTED_PREFIXES)) {
    if (!isAuthenticated) {
      const signInUrl = new URL(URLS.SIGNIN, req.url);
      signInUrl.searchParams.set("callbackUrl", pathname + req.nextUrl.search);
      return NextResponse.redirect(signInUrl);
    }
    return next({ "x-pathname": pathname + req.nextUrl.search });
  }

  return next();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)",
    "/api/(.*)",
  ],
};
