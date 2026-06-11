/**
 * Shared rate limiters for API routes.
 *
 * Rate limit profiles:
 * - authLimiter:            10/15min per IP  — POST /api/auth/sign-in, sign-up, forget-password (brute-force)
 * - checkoutLimiter:        5/min per user   — POST /api/checkout (fraud)
 * - discountLimiter:        10/min per user  — POST /api/payments/discounts/validate (brute-force)
 * - newsletterLimiter:      3/hr per IP      — POST /api/newsletter/subscribe (spam)
 * - referralApplyLimiter:   3/24h per user   — POST /api/referrals/apply (farming)
 * - spamLimiter:            5/hr per user    — support-tickets, feedbacks, reviews, report
 * - waitlistLimiter:        5/hr per user    — POST /api/waitlist
 * - trialRequestLimiter:    3/24h per user   — POST /api/trials (spam prevention)
 * - requestApprovalLimiter: 10/hr per user   — POST /api/slots/request-for-approval
 * - searchLimiter:          60/min per IP    — GET /api/user/consultants, /api/consultants/search
 * - eligibilityLimiter:     20/min per IP    — GET /api/trials/check-eligibility
 * - availabilityLimiter:    30/min per IP    — GET /api/slots/availability/[consultantId]
 */

import { Ratelimit } from "@upstash/ratelimit";
import redis from "@/lib/redis-edge";
import { NextResponse } from "next/server";

type RatelimitRedis = ConstructorParameters<typeof Ratelimit>[0]["redis"];

function makeLimiter(
  requests: number,
  window: `${number} ${"ms" | "s" | "m" | "h" | "d"}`,
  prefix: string,
): Ratelimit {
  return new Ratelimit({
    redis: redis as RatelimitRedis,
    limiter: Ratelimit.slidingWindow(requests, window),
    prefix,
  });
}

/** 10 per 15 minutes — auth endpoints (sign-in, sign-up, forget-password) */
export const authLimiter = makeLimiter(10, "15 m", "rl:auth");

/** 5 per minute — POST /api/checkout */
export const checkoutLimiter = makeLimiter(5, "1 m", "rl:checkout");

/** 10 per minute — POST /api/payments/discounts/validate */
export const discountLimiter = makeLimiter(10, "1 m", "rl:discount");

/** 3 per hour — POST /api/newsletter/subscribe (IP-based) */
export const newsletterLimiter = makeLimiter(3, "1 h", "rl:newsletter");

/** 3 per 24 hours — POST /api/referrals/apply */
export const referralApplyLimiter = makeLimiter(3, "24 h", "rl:referral-apply");

/** 5 per hour — support-tickets, feedbacks, reviews, report (scope key by route) */
export const spamLimiter = makeLimiter(5, "1 h", "rl:spam");

/** 5 per hour — POST /api/waitlist */
export const waitlistLimiter = makeLimiter(5, "1 h", "rl:waitlist");

/** 3 per 24 hours — POST /api/trials (prevents flooding consultant inboxes) */
export const trialRequestLimiter = makeLimiter(3, "24 h", "rl:trial-request");

/** 10 per hour — POST /api/slots/request-for-approval */
export const requestApprovalLimiter = makeLimiter(
  10,
  "1 h",
  "rl:request-approval",
);

/** 60 per minute — GET /api/user/consultants, GET /api/consultants/search */
export const searchLimiter = makeLimiter(60, "1 m", "rl:search");

/** 20 per minute — GET /api/trials/check-eligibility */
export const eligibilityLimiter = makeLimiter(20, "1 m", "rl:eligibility");

/** 30 per minute — GET /api/slots/availability/[consultantId] (IP-based, public booking flow) */
export const availabilityLimiter = makeLimiter(30, "1 m", "rl:availability");

// ============================================================================
// Enterprise (arch-4) — per-org / per-IP buckets for org-specific surfaces.
//
// These are narrower than the global authLimiter because an org-scoped
// attacker (e.g. credential-stuffing against a single tenant's SSO) can
// keep the global IP counter fresh by rotating source IPs. Adding an
// org-scoped bucket catches single-tenant floods that wouldn't trip the
// global bucket.
// ============================================================================

/** 30 per hour — POST /api/organizations/invitations/accept (IP-based; org-level identity only available post-token-lookup, which middleware can't do) */
export const orgInviteAcceptLimiter = makeLimiter(
  30,
  "1 h",
  "rl:org-invite-accept",
);

/** 60 per hour — GET /api/auth/sso/domain-check (IP-based, prevents org-existence enumeration) */
export const ssoDomainCheckLimiter = makeLimiter(
  60,
  "1 h",
  "rl:sso-domain-check",
);

/** 20 per hour per org — POST /api/organizations/[orgId]/billing-account/wallet/top-ups (orgId-keyed; blocks a single org from minting hundreds of Razorpay orders) */
export const orgWalletTopUpLimiter = makeLimiter(
  20,
  "1 h",
  "rl:org-wallet-topup",
);

/** 20 per hour per org — POST /api/organizations/[orgId]/invitations
 * (orgId-keyed; prevents a malicious OWNER from flooding audit logs and
 *  Novu ORG_INVITE_SENT workflows via rapid-fire invite spam) */
export const orgInviteLimiter = makeLimiter(20, "1 h", "rl:org-invite");

/**
 * 5 per minute per org — POST /api/organizations/[orgId]/webhooks
 * + PATCH endpoint + rotate-secret. Org-keyed to keep a misconfigured
 * automation from chewing through the audit log (every CRUD writes a
 * WEBHOOK row). Generous enough for the human admin clicking
 * "rotate secret" twice on a stuck modal but restrictive enough to
 * stop a runaway script. See `lib/enterprise/outbound-webhooks/*`.
 */
export const orgWebhookLimiter = makeLimiter(5, "1 m", "rl:org-webhook");

/**
 * 60 requests per minute per token — SCIM 2.0 bearer endpoint.
 * Matches Okta + Azure AD default polling cadence; integrator IdPs
 * tend to issue 10–30 RPM at most, so 60 is two-headroom while still
 * mitigating runaway loops in test scripts. Keyed on tokenHash so a
 * leaked token can't burn another org's quota.
 */
export const scimLimiter = makeLimiter(60, "1 m", "rl:scim");

/**
 * 1 per 24h per org — POST /api/organizations/[orgId]/data-exports.
 * The bundle build is expensive (cross-entity walk + zip + Supabase
 * Storage upload + Resend email). One export per day is well above
 * the DPDP §11 use-case (responding to a regulator request) and far
 * below the cost ceiling we want to expose to a single tenant.
 */
export const orgDataExportLimiter = makeLimiter(
  1,
  "24 h",
  "rl:org-data-export",
);

/**
 * Apply rate limit to a request.
 * Returns a 429 NextResponse if exceeded, otherwise null.
 *
 * @param limiter    - Named Ratelimit instance from this module
 * @param identifier - Rate limit key: userId for auth'd routes, IP for public routes.
 *                     Prefix with a route slug when reusing the same limiter across
 *                     multiple endpoints (e.g. `tickets:${userId}`).
 */
export async function applyRateLimit(
  limiter: Ratelimit,
  identifier: string,
): Promise<NextResponse | null> {
  try {
    const { success, remaining } = await limiter.limit(identifier);
    if (!success) {
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        {
          status: 429,
          headers: { "X-RateLimit-Remaining": String(remaining) },
        },
      );
    }
    return null;
  } catch {
    return null; // Redis down — fail open
  }
}

/**
 * Extract the client IP from request headers.
 * Use for IP-based rate limiting on public endpoints.
 *
 * Header preference (most-trusted first):
 *   - `req.ip` (Next.js / Vercel-derived)
 *   - `x-nf-client-connection-ip` (Netlify canonical client IP)
 *   - `x-forwarded-for` (first hop)
 *
 * Returns the sentinel `"unknown_ip"` when nothing resolves. The
 * production middleware MUST NOT bypass on this sentinel — see
 * `isBypassableIp`. In dev / test, the sentinel is treated as
 * localhost and waved through.
 */
export function getClientIp(req: {
  ip?: string;
  headers: { get(name: string): string | null };
}): string {
  const ip =
    req.ip ??
    req.headers.get("x-nf-client-connection-ip")?.trim() ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return ip || "unknown_ip";
}

/**
 * Returns true when an IP value is safe to bypass rate-limiting on.
 * Localhost handles (`::1`, `127.0.0.1`) and the `unknown_ip` sentinel
 * are bypassable in non-production environments only — production
 * traffic that arrives without a usable IP header should fall into the
 * normal limiter bucket so a header-stripping attacker pays the same
 * rate-limit price as a real client. Previously the sentinel was an
 * unconditional bypass, which meant a misconfigured reverse-proxy in
 * production would silently disable every limiter.
 */
export function isBypassableIp(ip: string): boolean {
  if (process.env.NODE_ENV === "production") return false;
  return (
    ip === "::1" ||
    ip === "127.0.0.1" ||
    ip === "unknown_ip"
  );
}
