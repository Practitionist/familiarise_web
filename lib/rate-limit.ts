/**
 * Shared rate limiters for API routes and middleware.
 */

import { Ratelimit } from "@upstash/ratelimit";
import redis from "@/lib/redis-edge";
import { NextResponse } from "next/server";
import { captureThrottled } from "@/lib/observability/throttled-capture";

type RatelimitRedis = ConstructorParameters<typeof Ratelimit>[0]["redis"];

const LIMITER_TIMEOUT_MS = (() => {
  const v = Number(process.env.LIMITER_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 500;
})();

export function makeLimiter(
  requests: number,
  window: `${number} ${"ms" | "s" | "m" | "h" | "d"}`,
  prefix: string,
): Ratelimit {
  return new Ratelimit({
    redis: redis as RatelimitRedis,
    limiter: Ratelimit.slidingWindow(requests, window),
    prefix,
    timeout: LIMITER_TIMEOUT_MS,
  });
}

/** 5 per minute — POST /api/checkout */
export const checkoutLimiter = makeLimiter(5, "1 m", "rl:checkout");
/** 30 per minute — GET /api/checkout/tax-context */
export const checkoutContextLimiter = makeLimiter(
  30,
  "1 m",
  "rl:checkout-context",
);
/** 10 per minute — DELETE /api/checkout/pending/[paymentId] */
export const cancelPendingLimiter = makeLimiter(10, "1 m", "rl:cancel-pending");
/** 10 per minute — POST /api/payments/discounts/validate */
export const discountLimiter = makeLimiter(10, "1 m", "rl:discount");
/** 10 per minute — admin/backoffice money operations */
export const moneyOpsLimiter = makeLimiter(10, "1 m", "rl:money-ops");
/** 10 per minute — admin pipeline mutations */
export const adminMutationLimiter = makeLimiter(10, "1 m", "rl:admin-mutation");
/** 3 per hour — POST /api/waitlist newsletter signup (IP-based) */
export const waitlistLimiter = makeLimiter(3, "1 h", "rl:waitlist");
/** 3 per 24 hours — POST /api/referrals/apply */
export const referralApplyLimiter = makeLimiter(3, "24 h", "rl:referral-apply");
/** 1 per 24 hours per appointment — POST /api/bookings/{consultations,subscriptions}/[id]/remind */
export const remindLimiter = makeLimiter(1, "24 h", "rl:remind");
/** 5 per hour — support-tickets, feedbacks, reviews, report */
export const spamLimiter = makeLimiter(5, "1 h", "rl:spam");
/** 20 per hour — review composer writes */
export const reviewWriteLimiter = makeLimiter(20, "1 h", "rl:review-write");
/** 20 per minute — POST /api/meetings/[id]/join */
export const streamJoinLimiter = makeLimiter(20, "1 m", "rl:stream-join");
/** 60 per minute — authenticated Stream reads/writes */
export const streamApiLimiter = makeLimiter(60, "1 m", "rl:stream-api");
/** 3 per 5 minutes per user — POST /api/stream/recordings/sync */
export const streamRecordingSyncLimiter = makeLimiter(
  3,
  "5 m",
  "rl:stream-recording-sync",
);
/** 3 per 24 hours — POST /api/trials */
export const trialRequestLimiter = makeLimiter(3, "24 h", "rl:trial-request");
/** 10 per hour — POST /api/scheduling/request-for-approval */
export const requestApprovalLimiter = makeLimiter(
  10,
  "1 h",
  "rl:request-approval",
);
/** 60 per minute — GET /api/user/consultants, GET /api/consultants/search */
export const searchLimiter = makeLimiter(60, "1 m", "rl:search");
/** 20 per minute — GET /api/trials/check-eligibility */
export const eligibilityLimiter = makeLimiter(20, "1 m", "rl:eligibility");
/** 30 per minute — /api/scheduling/availability/* */
export const availabilityLimiter = makeLimiter(30, "1 m", "rl:availability");
/** 120 per minute per IP — GET /api/scheduling/availability-with-allocation/[consultantId] */
export const availabilityGridLimiter = makeLimiter(
  120,
  "1 m",
  "rl:availability-grid",
);
/** 30 per minute per IP — GET /api/currency */
export const currencyLimiter = makeLimiter(30, "1 m", "rl:currency");
/** 30 per minute — GET /api/participants/{class,webinar}/[id] */
export const participantReadLimiter = makeLimiter(30, "1 m", "rl:participants");
/** 10 per minute — event mutations: /api/bookings/* POST/PATCH */
export const eventMutationLimiter = makeLimiter(10, "1 m", "rl:event-mutation");
/** 10 per minute per user — document upload POSTs */
export const documentUploadLimiter = makeLimiter(
  10,
  "1 m",
  "rl:document-upload",
);
/** 6 per minute per IP — on-demand plan brochure rendering */
export const brochureDownloadLimiter = makeLimiter(
  6,
  "1 m",
  "rl:plan-brochure",
);
/** 30 per minute per user — bulk document review */
export const documentReviewLimiter = makeLimiter(
  30,
  "1 m",
  "rl:document-review",
);
/** 10 per minute per user — onboarding terminal submit */
export const onboardingSubmitLimiter = makeLimiter(
  10,
  "1 m",
  "rl:onboarding-submit",
);
/** 30 per minute per user — onboarding draft autosave */
export const onboardingDraftLimiter = makeLimiter(
  30,
  "1 m",
  "rl:onboarding-draft",
);
/** 10 per hour per user — POST /api/verification/submit + /resubmit */
export const verificationSubmitLimiter = makeLimiter(
  10,
  "1 h",
  "rl:verification-submit",
);
/** 120 per 15 minutes per IP — /api/user/sessions* except /current */
export const sessionMgmtLimiter = makeLimiter(120, "15 m", "rl:session-mgmt");
/** 60 per 15 minutes per user — /api/user/sessions* */
export const sessionMgmtUserLimiter = makeLimiter(
  60,
  "15 m",
  "rl:session-mgmt-user",
);
/** 120 per 15 minutes per staff user — /api/admin/users/[userId]/sessions* */
export const adminSessionAccessLimiter = makeLimiter(
  120,
  "15 m",
  "rl:admin-session-access",
);
/** 20 per hour per org — POST /api/organizations/[orgId]/billing-account/wallet/top-ups */
export const orgWalletTopUpLimiter = makeLimiter(
  20,
  "1 h",
  "rl:org-wallet-topup",
);
/** 20 per hour per org — POST /api/organizations/[orgId]/invitations */
export const orgInviteLimiter = makeLimiter(20, "1 h", "rl:org-invite");
/** 10 per hour per org — POST /api/organizations/[orgId]/programs/[programId]/auto-enroll */
export const orgAutoEnrollLimiter = makeLimiter(
  10,
  "1 h",
  "rl:org-auto-enroll",
);
/** 5 per minute per org — outbound webhook CRUD + secret rotation */
export const orgWebhookLimiter = makeLimiter(5, "1 m", "rl:org-webhook");
/** 1 per 24h per org — POST /api/organizations/[orgId]/data-exports */
export const orgDataExportLimiter = makeLimiter(
  1,
  "24 h",
  "rl:org-data-export",
);
/** 120 per hour per IP — GET /api/auth/sso/domain-check */
export const ssoDomainCheckLimiter = makeLimiter(
  120,
  "1 h",
  "rl:sso-domain-check",
);
/** 60 per hour per IP — POST /api/organizations/invitations/accept */
export const inviteAcceptIpLimiter = makeLimiter(
  60,
  "1 h",
  "rl:org-invite-accept",
);
export const inviteAcceptLimiter = inviteAcceptIpLimiter;
/** 20 per hour per admin — POST /api/admin/team/members and setup-link */
export const staffCreateLimiter = makeLimiter(
  20,
  "1 h",
  "rl:platform:staff-create",
);

/**
 * Seconds until the sliding window admits the caller again, floored at 1.
 */
export function retryAfterSeconds(
  resetAtMs: number,
  nowMs = Date.now(),
): number {
  if (!Number.isFinite(resetAtMs)) return 1;
  return Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000));
}

/**
 * Apply rate limit to a request.
 * Returns a 429 NextResponse if exceeded, otherwise null.
 */
export async function applyRateLimit(
  limiter: Ratelimit,
  identifier: string,
  scope?: string,
): Promise<NextResponse | null> {
  try {
    const { success, remaining, reset } = await limiter.limit(identifier);
    if (!success) {
      const retryAfter = retryAfterSeconds(reset);
      return NextResponse.json(
        {
          error: "Too many requests. Please try again later.",
          code: "RATE_LIMITED",
          ...(scope ? { scope } : {}),
          retryAfterSeconds: retryAfter,
        },
        {
          status: 429,
          headers: {
            "X-RateLimit-Remaining": String(remaining),
            "Retry-After": String(retryAfter),
          },
        },
      );
    }
    return null;
  } catch (error) {
    captureThrottled("rate-limit:applyRateLimit", error, {
      subsystem: "rate-limit",
      op: "applyRateLimit",
      expected: false,
    });
    return null;
  }
}

/**
 * Extract the client IP from request headers.
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
 * Returns true when an IP value is safe to bypass rate-limiting on
 * (localhost or unknown_ip in non-production environments only).
 */
export function isBypassableIp(ip: string): boolean {
  if (process.env.NODE_ENV === "production") return false;
  return ip === "::1" || ip === "127.0.0.1" || ip === "unknown_ip";
}
