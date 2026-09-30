/**
 * Shared rate limiters for API routes.
 *
 * Rate limit profiles:
 * - authLimiter:            10/15min per IP  — POST /api/auth/sign-in, sign-up, forget-password (brute-force)
 * - checkoutLimiter:        5/min per user   — POST /api/checkout (fraud)
 * - discountLimiter:        10/min per user  — POST /api/payments/discounts/validate (brute-force)
 * - waitlistLimiter:        3/hr per IP      — POST /api/waitlist (newsletter signup spam)
 * - referralApplyLimiter:   3/24h per user   — POST /api/referrals/apply (farming)
 * - remindLimiter:          1/24h per appointment — POST /api/bookings/{consultations,subscriptions}/[id]/remind (#1775)
 * - spamLimiter:            5/hr per user    — support-tickets, feedbacks, reviews, report
 * - cspReportLimiter:       120/min per IP   — POST /api/csp-report (browser-generated)
 * - trialRequestLimiter:    3/24h per user   — POST /api/trials (spam prevention)
 * - requestApprovalLimiter: 10/hr per user   — POST /api/scheduling/request-for-approval
 * - searchLimiter:          60/min per IP    — GET /api/user/consultants, /api/consultants/search
 * - eligibilityLimiter:     20/min per IP    — GET /api/trials/check-eligibility
 * - availabilityLimiter:    30/min per IP    — /api/scheduling/availability/* (weekly, custom)
 * - availabilityGridLimiter: 120/min per IP  — GET /api/scheduling/availability-with-allocation/[consultantId]
 * - currencyLimiter:        30/min per IP    — GET /api/currency (protects the FX provider quota)
 * - documentUploadLimiter:  10/min per user  — POST /api/appointments/[id]/documents (+ /consultant)
 * - streamRecordingSyncLimiter: 3/5min per user — POST /api/stream/recordings/sync (Stream fan-out)
 * - onboardingSubmitLimiter: 10/min per user  — updateOnboardingInformationAction + PATCH /api/form/onboarding/[id] (heavy multi-table tx)
 * - onboardingDraftLimiter:  30/min per user  — saveOnboardingDraftAction (800ms-debounced autosave + pagehide flush)
 * - verificationSubmitLimiter: 10/hr per user — POST /api/verification/submit + /resubmit (review-queue writes + admin notify)
 * - sessionMgmtLimiter:     120/15min per IP  — /api/user/sessions* except the liveness probe (see middleware)
 * - sessionMgmtUserLimiter: 60/15min per user — same three routes, keyed past requireApiAuth (the precise gate)
 *
 * The auth surface is NOT listed here because it is no longer configured here.
 * Every auth budget, its per-account and per-token dimensions, and the `scope`
 * its 429 reports come from one table in `lib/rate-limit/policies.ts`, and the
 * edge rules are generated from it. That indirection is the fix for the bug
 * that motivated it: this file used to name `/api/auth/forget-password`, which
 * is not a BetterAuth endpoint (it is `/api/auth/request-password-reset`), and
 * nothing noticed because the limiter name, the path list and the 429 label
 * were three unrelated pieces of text.
 */

import { Ratelimit } from "@upstash/ratelimit";
import redis from "@/lib/redis-edge";
import { NextResponse } from "next/server";
import { captureThrottled } from "@/lib/observability/throttled-capture";

type RatelimitRedis = ConstructorParameters<typeof Ratelimit>[0]["redis"];

// These limiters run in edge middleware on every matched request and fail OPEN
// (see applyRateLimit). The Ratelimit default timeout is 5000ms, so a slow or
// unreachable Upstash would stall the request 5s before allowing it through;
// 500ms keeps the fail-open fallback fast.
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

/**
 * 10 per 15 minutes — the original catch-all auth bucket (sign-in, sign-up,
 * forget-password).
 *
 * SUPERSEDED for the edge by `lib/rate-limit/policies.ts`, which is now the
 * single declaration for every auth budget — its per-scope numbers, and the
 * per-account and per-token dimensions this bucket never had, are what the
 * middleware actually spends. Kept exported and unchanged because it is a
 * stable, widely-referenced name in this repo's docs and comments; anything
 * that still points at it is on the coarse 10/15m, which is the safe direction
 * to be wrong in.
 */
export const authLimiter = makeLimiter(10, "15 m", "rl:auth");

/** 5 per minute — POST /api/checkout */
export const checkoutLimiter = makeLimiter(5, "1 m", "rl:checkout");
// #1583 E-P1-06 — the tax-context read runs once per checkout page mount and
// falls back to the domestic profile on any non-2xx, so it must not share the
// five-a-minute POST bucket: a page reload would silently mis-tax the buyer.
export const checkoutContextLimiter = makeLimiter(
  30,
  "1 m",
  "rl:checkout-context",
);

/**
 * 10 per minute — DELETE /api/checkout/pending/[paymentId] (#849).
 * Own bucket so releasing a hold never consumes checkout quota — a user
 * abandoning one attempt to start another needs both calls in the same minute.
 */
export const cancelPendingLimiter = makeLimiter(10, "1 m", "rl:cancel-pending");

/** 10 per minute — POST /api/payments/discounts/validate */
export const discountLimiter = makeLimiter(10, "1 m", "rl:discount");

// #677/PM-36 — money-operations limiter for admin/backoffice POST surfaces
// (refunds, dispute evidence, invoice generation). These are low-frequency,
// high-consequence endpoints: 10/min per user is far above legitimate ops
// traffic but caps scripted abuse of the most dangerous buttons in the app.
export const moneyOpsLimiter = makeLimiter(10, "1 m", "rl:money-ops");
// #1230 wave-4c — admin pipeline mutations (lead status moves, etc.).
export const adminMutationLimiter = makeLimiter(10, "1 m", "rl:admin-mutation");

/** 3 per hour — POST /api/waitlist newsletter signup (IP-based) */
export const waitlistLimiter = makeLimiter(3, "1 h", "rl:waitlist");

/** 3 per 24 hours — POST /api/referrals/apply */
export const referralApplyLimiter = makeLimiter(3, "24 h", "rl:referral-apply");

/** 1 per 24 hours per appointment — POST /api/bookings/{consultations,subscriptions}/[id]/remind (#1775) */
export const remindLimiter = makeLimiter(1, "24 h", "rl:remind");

/** 5 per hour — support-tickets, feedbacks, reviews, report (scope key by route) */
export const spamLimiter = makeLimiter(5, "1 h", "rl:spam");

// Review writes: the composer POSTs for every edit, and a new review is already
// bounded by the pair unique and a held session, so this only stops hammering.
export const reviewWriteLimiter = makeLimiter(20, "1 h", "rl:review-write");

/**
 * 120 per minute per IP — POST /api/csp-report.
 *
 * Was on spamLimiter's 5/hr, which is sized for a HUMAN deciding to file a
 * support ticket. A CSP report is emitted by the browser, unprompted, once per
 * violated directive per page load — so one person opening a few dashboard
 * pages exhausted the hour's quota in seconds and every report after that was
 * dropped with a 429. The report-only rollout was therefore blind in exactly
 * the situation it exists to observe: a directive drifting on a real user.
 *
 * Sized for a page that violates a handful of directives on every navigation,
 * with headroom, while still capping a hostile poster. Reports are logged, not
 * stored, so the cost of a generous ceiling is log volume rather than writes.
 */
export const cspReportLimiter = makeLimiter(120, "1 m", "rl:csp-report");

/**
 * #1134 P1-11 — Stream had NO rate limiting on any route or server action.
 *
 * Two shapes, two budgets:
 *
 * `streamJoinLimiter` guards the meeting join gate. It is the enumeration
 * surface: call ids are deterministic (`occurrence-<occurrenceId>`), so an attacker
 * who has one occurrence id can walk neighbours. Generous enough that a flaky network
 * retrying a join never trips it, tight enough that scanning is useless.
 *
 * `streamApiLimiter` guards the search / channel-create / block routes, which
 * are ordinary authenticated reads and writes but were completely unbounded —
 * every one of them costs a Stream API call we are billed for.
 */
export const streamJoinLimiter = makeLimiter(20, "1 m", "rl:stream-join");
export const streamApiLimiter = makeLimiter(60, "1 m", "rl:stream-api");

/**
 * 3 per 5 minutes per user — POST /api/stream/recordings/sync (#1270).
 *
 * The edge `stream: api` rule already covers this path, but at 60/min keyed by
 * IP, which is sized for ordinary reads. This one call walks every session the
 * caller owns or is enrolled in and issues a `listRecordings` request to Stream
 * for each, so a single authenticated user can force an unbounded, billable
 * fan-out — and the middleware bucket is shared with everyone behind the same
 * NAT, so it is the wrong shape to defend it.
 *
 * Sized on what the feature is for: a user clicks "Sync" because a replay is
 * missing, and the answer does not change on the second press. Three attempts
 * in five minutes covers an impatient human and a retry after a transient
 * error; it does not cover a loop.
 */
export const streamRecordingSyncLimiter = makeLimiter(
  3,
  "5 m",
  "rl:stream-recording-sync",
);

/** 3 per 24 hours — POST /api/trials (prevents flooding consultant inboxes) */
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

/** 30 per minute — /api/scheduling/availability/* (IP-based; the public grid is availability-with-allocation) */
export const availabilityLimiter = makeLimiter(30, "1 m", "rl:availability");

/**
 * 120 per minute per IP — GET /api/scheduling/availability-with-allocation/[consultantId]
 * (#1697 item 2). The hottest read in the app and, until now, the one the
 * middleware path match missed. Sized for a shared-NAT office of grids each
 * polling once a minute plus week-slides and post-allocation refetches; a
 * scripted loop trips it within seconds. 429s carry Retry-After and the
 * client poller backs off by it.
 */
export const availabilityGridLimiter = makeLimiter(
  120,
  "1 m",
  "rl:availability-grid",
);

/**
 * 30 per minute per IP — GET /api/currency (#1396).
 *
 * The route was public and completely unbounded, and every miss on the
 * per-instance rate cache becomes an outbound call to ExchangeRate-API's free
 * tier, whose 429 carries roughly a twenty-minute lockout. One scripted caller
 * could therefore take FX display down for every buyer on the site. IP-keyed
 * because the endpoint is anonymous: a visitor reading prices has no session.
 * Thirty a minute is far above what a browsing session needs — the client
 * caches the answer for an hour — while a loop trips it immediately.
 */
export const currencyLimiter = makeLimiter(30, "1 m", "rl:currency");

/** 30 per minute — GET /api/participants/{class,webinar}/[id] (per user) */
export const participantReadLimiter = makeLimiter(30, "1 m", "rl:participants");

/** 10 per minute — event mutations: /api/bookings/* POST/PATCH + [id]/validate + [id]/allocate (#831) */
export const eventMutationLimiter = makeLimiter(10, "1 m", "rl:event-mutation");

/**
 * 10 per minute per user — DOC-2 (#694): document upload POSTs
 * (appointment documents + consultant response uploads). Each upload
 * touches Supabase Storage and creates a DB row, so an unthrottled loop
 * can both balloon storage cost and flood the reviewer; bursts of a few
 * files at once stay under the limit.
 */
export const documentUploadLimiter = makeLimiter(
  10,
  "1 m",
  "rl:document-upload",
);

/**
 * 30 per minute per user — #347 bulk document review. One request reviews many
 * documents in a single transaction (replacing the old N-PATCH fan-out), so the
 * limit is generous; it only guards against a script hammering the endpoint.
 */
export const documentReviewLimiter = makeLimiter(
  30,
  "1 m",
  "rl:document-review",
);

/**
 * 10 per minute per user — onboarding terminal submit
 * (`updateOnboardingInformationAction` + `PATCH /api/form/onboarding/[id]`).
 * One submit runs a multi-table CAS transaction plus slot fan-out and a
 * post-commit verification side effect, so a double-click loop or a retry
 * storm is real DB + notify load. Ten covers impatient double-submits and
 * maintenance-window retries; a loop trips it immediately. Keyed by user id
 * (server actions have no request IP helper — reuse `applyRateLimit`, which
 * only needs the limiter + identifier).
 */
export const onboardingSubmitLimiter = makeLimiter(
  10,
  "1 m",
  "rl:onboarding-submit",
);

/**
 * 30 per minute per user — `saveOnboardingDraftAction` (draft autosave).
 * The wizard debounces saves at 800ms + flushes on pagehide, so legitimate
 * traffic is a handful of 64KB upserts per step. Thirty caps a stuck
 * autosave loop without ever touching a human.
 */
export const onboardingDraftLimiter = makeLimiter(
  30,
  "1 m",
  "rl:onboarding-draft",
);

/**
 * 10 per hour per user — `POST /api/verification/submit` + `/resubmit`.
 * Each call mints or mutates a review-queue row and notifies admins; an
 * hour bucket fits the human cadence (submit → fix docs → resubmit) while
 * stopping queue-flooding scripts. Status reads are intentionally unthrottled.
 */
export const verificationSubmitLimiter = makeLimiter(
  10,
  "1 h",
  "rl:verification-submit",
);

// ============================================================================
// Enterprise (arch-4) — per-org / per-IP buckets for org-specific surfaces.
//
// These are narrower than the global authLimiter because an org-scoped
// attacker (e.g. credential-stuffing against a single tenant's SSO) can
// keep the global IP counter fresh by rotating source IPs. Adding an
// org-scoped bucket catches single-tenant floods that wouldn't trip the
// global bucket.
// ============================================================================

/**
 * 30 per hour — POST /api/organizations/invitations/accept (IP-based; org-level identity only available post-token-lookup, which middleware can't do)
 *
 * SUPERSEDED by `RATE_POLICIES[RATE_SCOPE.INVITE_ACCEPT]`, which the middleware
 * now uses: 60/hr (the same shared-NAT correction applied to the SSO
 * domain-check) plus a per-invitation bucket. Left at 30/hr so a stale caller
 * gets the tighter, not the looser, budget. Shares the `rl:org-invite-accept`
 * prefix, so the two are the same bucket rather than two that can both be
 * spent.
 */
export const orgInviteAcceptLimiter = makeLimiter(
  30,
  "1 h",
  "rl:org-invite-accept",
);

/**
 * 60 per hour — GET /api/auth/sso/domain-check (IP-based, prevents org-existence enumeration)
 *
 * SUPERSEDED by `RATE_POLICIES[RATE_SCOPE.SSO_DOMAIN_CHECK]`, which the
 * middleware now uses at 120/hr — a shared-office NAT is one IP for a whole
 * floor and 60/hr was locking out offices on the critical path of every
 * corporate sign-in. Shares the `rl:sso-domain-check` prefix, so the two are
 * the same bucket rather than two that can both be spent.
 */
export const ssoDomainCheckLimiter = makeLimiter(
  60,
  "1 h",
  "rl:sso-domain-check",
);

/**
 * 120 per 15 minutes per IP — /api/user/sessions* except the signal
 * poll (#1856, exempt there).
 *
 * Deliberately NOT authLimiter: session traffic (a device list that
 * reloads after every revoke) must never exhaust the 10/15m sign-in
 * budget and lock a legitimate user out of signing in. IP-keyed
 * because middleware is cookie-presence-only — so one office NAT
 * shares this bucket, which is why it is generous AND paired with the
 * per-user limiter below (a single NAT office revoking devices must
 * not lock itself out; the per-user bucket is the precise gate).
 */
export const sessionMgmtLimiter = makeLimiter(120, "15 m", "rl:session-mgmt");

/**
 * 60 per 15 minutes per user — the same three session routes, keyed by
 * user id inside the handlers (past `requireApiAuth`, where the caller
 * is known). This is the precise gate; the IP rule above is coarse
 * abuse friction only. Applied in the route, not the middleware,
 * because only the route can resolve who is calling.
 */
export const sessionMgmtUserLimiter = makeLimiter(
  60,
  "15 m",
  "rl:session-mgmt-user",
);

/**
 * 120 per 15 minutes per STAFF USER — `/api/admin/users/[userId]/sessions*`
 * (#1856, review follow-up).
 *
 * The back-office session surface had no limiter at ANY layer before this:
 * no `RATE_LIMIT_RULES` entry matches `/api/admin/*` (they stop at the
 * `/api/auth/` and `/api/organizations/` prefixes), and neither handler
 * called `applyRateLimit`. That left an unauthenticated-rate-limit-free
 * read of up to 25 rows of `ipAddress` + device label + last-seen for ANY
 * user id, to any `users.read` operator.
 *
 * Keyed per STAFF USER, not per IP and not per TARGET: the threat is one
 * operator (or one hijacked operator session) walking the user directory
 * to harvest device/IP history, so the budget belongs to the operator.
 * An IP key would let a shared office pool cover for the abuse, and a
 * per-target key would be trivially reset by varying the user id.
 *
 * Budget is generous because the legitimate shape is a support agent
 * resolving ONE ticket, which is a handful of calls.
 */
export const adminSessionAccessLimiter = makeLimiter(
  120,
  "15 m",
  "rl:admin-session-access",
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
 * 10 per hour per org — POST /api/organizations/[orgId]/programs/[programId]/auto-enroll
 * (#1230 wave-9). One call provisions up to 200 ProgramAssignment rows, each
 * writing an audit row and (for LICENSED_SEAT) bumping activeSeatCount.
 * Org-keyed so a stuck automation loop can't churn seats/audit all day and one
 * tenant's provisioning burst can't crowd out others on the shared bucket.
 */
export const orgAutoEnrollLimiter = makeLimiter(
  10,
  "1 h",
  "rl:org-auto-enroll",
);

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
 * Seconds until the sliding window admits the caller again, floored at one so
 * a client never reads "retry now" off a 429 (#1697).
 */
export function retryAfterSeconds(
  resetAtMs: number,
  nowMs = Date.now(),
): number {
  if (!Number.isFinite(resetAtMs)) return 1;
  return Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000));
}

/* -------------------------------------------------------------------------- */
/* Degradation under store failure                                            */
/* -------------------------------------------------------------------------- */

/**
 * Set when the limiter store could not be reached, cleared on the next
 * successful check. Module-scope on purpose: when the shared state is down
 * there is no shared state left to coordinate through (same reasoning as the
 * `captureThrottled` note below).
 */
let rateLimitStoreDegraded = false;

/**
 * The header `applyEdgeRateLimits` stamps on the request when the limiter store
 * was unreachable, and the header a 429 carries alongside it.
 *
 * ## Why a header and not only the predicate below
 *
 * The two answer the same question about the same failure, but they reach
 * different processes. Edge middleware and the route handler are separate
 * isolates with separate module graphs, so a module-level flag set in the
 * middleware is **always `false`** when read from inside a handler. A captcha
 * gate that called the predicate in-process would be deaf to precisely the
 * outage it exists for.
 *
 * The contract, then: **consumers inside a handler read the request header.**
 * `isRateLimitDegraded()` is for callers in the same isolate, and for tests.
 *
 * ## What a consumer should do with it
 *
 * Under store failure the budgets are not being enforced. The fail-open in
 * `applyRateLimit` is correct and stays — a Redis outage must not log every
 * paying customer out of their own account. What fail-open leaves behind is a
 * *silent* hole on exactly the credential endpoints where the human at the
 * keyboard is the last remaining line. So a consumer that can raise the price
 * of a guess — captcha, step-up challenge, email confirmation — should raise it
 * precisely when this header is present. Degrade toward a second line, not
 * toward open.
 *
 * Deliberately NOT a signal to lock down: turning an Upstash blip into a global
 * 503 would be a self-inflicted outage, which is the failure this design exists
 * to avoid.
 */
export const RATE_LIMIT_DEGRADED_HEADER = "x-rate-limit-degraded";

/**
 * True when the most recent limiter check failed because the store was
 * unreachable — not because the caller was over quota.
 *
 * The distinction is the whole point. An exhausted budget is a `success: false`
 * return, never an exception, so it does not set this flag; only a thrown
 * store error does. A consumer branching on this is therefore saying "we have
 * no working limiter right now", which is a very different message from "you
 * are being rate limited", and the two must never be conflated into one boolean.
 *
 * See `RATE_LIMIT_DEGRADED_HEADER` for the cross-isolate version of the same
 * fact, and for what a captcha gate is expected to do with it.
 */
export function isRateLimitDegraded(): boolean {
  return rateLimitStoreDegraded;
}

/**
 * Apply rate limit to a request.
 * Returns a 429 NextResponse if exceeded, otherwise null.
 *
 * @param limiter    - Named Ratelimit instance from this module
 * @param identifier - Rate limit key: userId for auth'd routes, IP for public routes.
 *                     Prefix with a route slug when reusing the same limiter across
 *                     multiple endpoints (e.g. `tickets:${userId}`).
 * @param scope      - Optional `RATE_SCOPE` value (lib/rate-limit/policies.ts).
 *                     Echoed in the 429 body so a client can branch on which
 *                     budget it spent without string-matching the error
 *                     sentence. Omitted from the body when not supplied, so the
 *                     ~50 existing bare-`applyRateLimit(limiter, id)` call sites
 *                     keep their exact response shape.
 */
export async function applyRateLimit(
  limiter: Ratelimit,
  identifier: string,
  scope?: string,
): Promise<NextResponse | null> {
  try {
    const { success, remaining, reset } = await limiter.limit(identifier);
    // A completed check is proof the store is reachable again, so the degraded
    // flag is cleared here rather than on a timer — a caller that gets a verdict
    // can rely on that verdict being a real measurement.
    rateLimitStoreDegraded = false;
    if (!success) {
      const retryAfter = retryAfterSeconds(reset);
      return NextResponse.json(
        // Machine-readable code alongside the sentence: clients key the
        // shared "wait a moment, then retry" toast off it instead of
        // string-matching the message.
        {
          error: "Too many requests. Please try again later.",
          code: "RATE_LIMITED",
          // `identifier` is deliberately NOT echoed. It is a Redis key input,
          // and for the account and token dimensions it is a digest of a secret
          // — a body that returns the caller's own digest teaches an attacker
          // the shape of the keyspace for nothing.
          ...(scope ? { scope } : {}),
          // Repeated in the body so a client that cannot read headers (a JSON
          // fetch wrapper, an SDK) still has the honest number. `Retry-After`
          // remains the header of record (#1697).
          retryAfterSeconds: retryAfter,
        },
        {
          status: 429,
          headers: {
            "X-RateLimit-Remaining": String(remaining),
            // #1697 — background pollers back off by this rather than retrying
            // on their own cadence; the window's reset is the honest figure.
            "Retry-After": String(retryAfter),
          },
        },
      );
    }
    return null;
  } catch (error) {
    rateLimitStoreDegraded = true;
    // Fail open is deliberate (#1125) — but a Redis outage silently disables
    // every rate limiter in the app, so it must be reported, not swallowed.
    //
    // `identifier` is deliberately NOT attached. Callers key on whatever
    // identifies the caller, and app/api/consultants/search/route.ts passes a
    // raw client IP — which would put PII in Sentry against this project's
    // sendDefaultPii: false. It buys nothing anyway: when Redis is down every
    // limiter fails, so one sample's key is not diagnostic, and the captured
    // transaction already names the route. (#1127)
    // Throttled to one report per instance per minute. Unthrottled, a Redis
    // outage fires a capture on EVERY limited request across every route — the
    // failure is total, not per-caller, so the second event of an outage carries
    // no information the first did not, and the volume both burns quota and
    // buries unrelated alerts. Per-instance rather than global on purpose: there
    // is no shared state to coordinate through when the shared state IS what is
    // down. (#1125; extracted to a shared helper under #1822 so
    // lib/maintenance-cron.ts and lib/cron/cleanup-route.ts get the same
    // throttle instead of re-implementing it.)
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
  return ip === "::1" || ip === "127.0.0.1" || ip === "unknown_ip";
}
