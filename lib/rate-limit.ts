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
 * - requestApprovalLimiter: 10/hr per user   — POST /api/slots/request-for-approval
 * - searchLimiter:          60/min per IP    — GET /api/user/consultants, /api/consultants/search
 * - eligibilityLimiter:     20/min per IP    — GET /api/trials/check-eligibility
 * - availabilityLimiter:    30/min per IP    — GET /api/slots/availability/[consultantId]
 */

import { Ratelimit } from "@upstash/ratelimit";
import redis from "@/lib/redis";
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
        { status: 429, headers: { "X-RateLimit-Remaining": String(remaining) } },
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
 */
export function getClientIp(
  req: { ip?: string; headers: { get(name: string): string | null } },
): string {
  const ip =
    req.ip ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return ip ?? "unknown_ip";
}
