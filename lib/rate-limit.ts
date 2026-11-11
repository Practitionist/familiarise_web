/**
 * Shared rate limiters for API routes and middleware.
 */

import { Ratelimit } from "@upstash/ratelimit";
import redis from "@/lib/redis-edge";
import { NextResponse } from "next/server";
import { captureThrottled } from "@/lib/observability/throttled-capture";
import { stampedClientIp } from "@/lib/request-ip";

type RatelimitRedis = ConstructorParameters<typeof Ratelimit>[0]["redis"];

// Fail-open budget for one limiter round trip.
const LIMITER_TIMEOUT_MS = 500;

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
/** 10 per minute — DELETE and PATCH /api/checkout/pending/[paymentId] */
export const cancelPendingLimiter = makeLimiter(10, "1 m", "rl:cancel-pending");
/** 10 per minute — POST /api/payments/discounts/validate */
export const discountLimiter = makeLimiter(10, "1 m", "rl:discount");
/** 10 per minute — admin/backoffice money operations */
export const moneyOpsLimiter = makeLimiter(10, "1 m", "rl:money-ops");
/** 10 per minute — admin GST outward-supplies register downloads */
export const gstRegisterDownloadLimiter = makeLimiter(
  10,
  "1 m",
  "rl:gst-register-download",
);
/** 10 per minute — admin pipeline mutations */
export const adminMutationLimiter = makeLimiter(10, "1 m", "rl:admin-mutation");
/** 3 per hour — POST /api/newsletter signup (IP-based) */
export const newsletterLimiter = makeLimiter(3, "1 h", "rl:newsletter");
/** 30 per minute per IP — GET /api/calendar/[appointmentId], the signed .ics link */
export const calendarLimiter = makeLimiter(30, "1 m", "rl:calendar");
/** 3 per 24 hours — POST /api/referrals/apply */
export const referralApplyLimiter = makeLimiter(3, "24 h", "rl:referral-apply");
/** 5 per hour per user — POST /api/referrals/code/customize */
export const referralCustomizeLimiter = makeLimiter(
  5,
  "1 h",
  "rl:referral-customize",
);
/** 30 per hour per user — GET /api/referrals/expert-link */
export const expertLinkLimiter = makeLimiter(30, "1 h", "rl:expert-link");
/** 1 per 24 hours per appointment — POST /api/bookings/{consultations,subscriptions}/[id]/remind */
export const remindLimiter = makeLimiter(1, "24 h", "rl:remind");
/** 5 per hour — support-tickets, feedbacks, reviews, report */
export const spamLimiter = makeLimiter(5, "1 h", "rl:spam");
/** 60 per hour — non-escalating support decision-tree button choices */
export const supportTurnLimiter = makeLimiter(60, "1 h", "rl:support-turn");
/** 20 per hour — review composer writes */
export const reviewWriteLimiter = makeLimiter(20, "1 h", "rl:review-write");
/**
 * 1,500 per minute per IP — POST /api/meetings/[id]/join, an abuse backstop only:
 * 200 attendees on one NAT make about 5 calls each as a room opens. See `meetingJoinLimiter`.
 */
export const streamJoinLimiter = makeLimiter(1500, "1 m", "rl:stream-join");
/** 10 per minute per user — POST /api/meetings/[id]/join (after authentication) */
export const meetingJoinLimiter = makeLimiter(10, "1 m", "rl:meeting-join");
/** 60 per minute — authenticated Stream reads/writes */
export const streamApiLimiter = makeLimiter(60, "1 m", "rl:stream-api");
/** 10 per minute per user — meeting room controls: end, extend, reopen, live */
export const meetingControlLimiter = makeLimiter(
  10,
  "1 m",
  "rl:meeting-control",
);
/** 60 per minute per user — stage grant/revoke, one request per attendee a host clears from the queue */
export const meetingStageLimiter = makeLimiter(60, "1 m", "rl:meeting-stage");
/** 30 per minute per user — in-call Q&A and stage chat writes */
export const meetingQaLimiter = makeLimiter(30, "1 m", "rl:meeting-qa");
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
/** 5 per 10 minutes per (appointment, user) — /api/appointments/[id]/reschedule* (#1497) */
export const rescheduleAppointmentLimiter = makeLimiter(
  5,
  "10 m",
  "rl:reschedule-appt",
);
/** 10 per minute per user — document upload POSTs */
export const documentUploadLimiter = makeLimiter(
  10,
  "1 m",
  "rl:document-upload",
);
/** Per user per minute, presign and commit apart: a bulk upload of a booking's 20-file cap fits each. */
export const documentUploadUrlLimiter = makeLimiter(
  20,
  "1 m",
  "rl:document-upload-url",
);
export const documentCommitLimiter = makeLimiter(
  20,
  "1 m",
  "rl:document-commit",
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
/** 5 per minute per org — outbound webhook CRUD + secret rotation */
export const orgWebhookLimiter = makeLimiter(5, "1 m", "rl:org-webhook");
/** 1 per 24h per org — POST /api/organizations/[orgId]/data-exports */
export const orgDataExportLimiter = makeLimiter(
  1,
  "24 h",
  "rl:org-data-export",
);
/** 1000 per hour per IP (offices share one NAT address) — GET /api/auth/sso/domain-check */
export const ssoDomainCheckLimiter = makeLimiter(
  1000,
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
/** 10 per minute per IP — GET /api/referrals/code/check/[code] */
export const referralCheckLimiter = makeLimiter(10, "1 m", "rl:referral-check");
/** 20 per hour per admin — POST /api/admin/team/members and setup-link */
export const staffCreateLimiter = makeLimiter(
  20,
  "1 h",
  "rl:platform:staff-create",
);

/** 5 per 15 minutes per user — POST /api/user/reauthenticate (password and TOTP guesses) */
export const reauthLimiter = makeLimiter(5, "15 m", "rl:reauth");

/** 60 per minute per creator — upload URL plus commit for a full 20-file product, with retry headroom */
export const digitalProductUploadLimiter = makeLimiter(
  60,
  "1 m",
  "rl:digital-product-upload",
);
/**
 * ~30 per 10 minutes per user — digital product file downloads. Upstash's
 * sliding window floors the previous bucket's weighted count, so a burst
 * straddling a bucket boundary can admit one or two more.
 */
export const digitalProductDownloadLimiter = makeLimiter(
  30,
  "10 m",
  "rl:digital-product-download",
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
 * The trial limiter read without spending a request: a 429 carrying when the
 * caller may retry, or null (also when Redis is slow or down: fail-open).
 */
export async function trialRequestRefusal(
  identifier: string,
): Promise<NextResponse | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const peek = await Promise.race([
      trialRequestLimiter.getRemaining(identifier),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), LIMITER_TIMEOUT_MS);
      }),
    ]);
    if (!peek || peek.remaining > 0) return null;
    const retryAfter = retryAfterSeconds(peek.reset);
    return NextResponse.json(
      {
        error: "You've reached today's trial request limit.",
        code: "RATE_LIMITED",
        retryAfterSeconds: retryAfter,
        retryAt: new Date(Date.now() + retryAfter * 1000).toISOString(),
      },
      {
        status: 429,
        headers: {
          "X-RateLimit-Remaining": "0",
          "Retry-After": String(retryAfter),
        },
      },
    );
  } catch (error) {
    captureThrottled("rate-limit:trialRequestRefusal", error, {
      subsystem: "rate-limit",
      op: "trialRequestRefusal",
      expected: false,
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Spends one trial request; called only once a trial has been created. */
export async function spendTrialRequest(identifier: string): Promise<void> {
  try {
    await trialRequestLimiter.limit(identifier);
  } catch (error) {
    captureThrottled("rate-limit:spendTrialRequest", error, {
      subsystem: "rate-limit",
      op: "spendTrialRequest",
      expected: false,
    });
  }
}

/** For route handlers: the client IP middleware stamped on the request. */
export function getClientIp(req: {
  headers: { get(name: string): string | null };
}): string {
  return stampedClientIp(req.headers);
}

/**
 * Returns true when an IP value is safe to bypass rate-limiting on
 * (localhost or unknown_ip in non-production environments only).
 */
export function isBypassableIp(ip: string): boolean {
  if (process.env.NODE_ENV === "production") return false;
  return ip === "::1" || ip === "127.0.0.1" || ip === "unknown_ip";
}
