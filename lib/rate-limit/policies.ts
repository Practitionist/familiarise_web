/**
 * The auth rate-limit policy table — one declaration per protected surface.
 *
 * ## Why this file exists
 *
 * `middleware.ts` used to name `/api/auth/forget-password` in the auth rule's
 * `match`, and BetterAuth has never had an endpoint by that name. The real
 * password-reset-request route is `/api/auth/request-password-reset`
 * (`node_modules/better-auth/dist/api/routes/password.mjs:20`). The prefix never
 * matched, so the whole forgot-password flow — the endpoint that mails an attacker
 * unlimited reset links, and the one an attacker uses to confirm which addresses
 * have accounts — ran unthrottled. The rule was invisible, and it was invisible
 * *because* the limiter name, the path list, and the 429 scope string were three
 * unrelated pieces of text that nothing kept in agreement.
 *
 * So: a policy here declares the scope string, the window, every participating
 * budget, and the rationale, and the limiter is derived from that declaration.
 * `middleware.ts` builds its rules from `POLICY_ROUTES`, which can only name a
 * scope — it can no longer name a number. A path that does not exist cannot be
 * given a budget, and a budget cannot drift from the scope that reports it.
 *
 * ## What the edge can and cannot enforce
 *
 * The middleware runs before any serverless function, sees the method, the path
 * and a handful of headers, and **cannot read the request body** (consuming the
 * stream in middleware strands the handler; `NextRequest` offers no rewind). That
 * is the single fact that shapes this file.
 *
 * BetterAuth takes its secrets in JSON bodies: `sign-in/email` `{email,
 * password}`, `sign-up/email`, `request-password-reset` `{email}`,
 * `send-verification-email` `{email}`, `reset-password` `{newPassword, token}`
 * (`password.mjs:120`). So the `account` and most `token` dimensions are
 * **declared and exported here but not spent by the edge** — they are spent by
 * whichever handler parses the body. `middleware.ts` spends only the `ip`
 * dimension, and says so in a comment at the call site.
 *
 * The exception is the two routes that carry their secret in the URL, which are
 * the two that most need a per-secret budget:
 *
 *   - `GET /api/auth/reset-password/:token` — token in the path.
 *   - `GET /api/auth/verify-email?token=…` — token in the query.
 *
 * ## Account keys are digests, never addresses
 *
 * `sha256(lower(trim(email)))`, hex. Upstash keys are plaintext at rest and
 * visible in `MONITOR`, so an address list living in Redis is a customer list
 * living in Redis — the same reason this project holds `sendDefaultPii: false`
 * in Sentry. Trimming and lower-casing first is what makes the budget *per
 * account* rather than per string: without it `Bob@x.com` and `bob@x.com ` are
 * two budgets for one account and the second is free. Callers import
 * `accountKey` rather than re-derive it, so there is one algorithm.
 *
 * Hashing uses **Web Crypto** (`crypto.subtle.digest`), not `node:crypto`, so
 * this module is safe to import from Edge middleware. It is a global in Node
 * >= 18 and in the Edge runtime, so the same function serves both sides of the
 * deploy boundary.
 */

import type { Ratelimit } from "@upstash/ratelimit";
import { makeLimiter } from "@/lib/rate-limit";

/* -------------------------------------------------------------------------- */
/* Scopes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Stable machine identifiers, one per protected surface.
 *
 * Sent verbatim in the 429 body as `scope`, so a client can tell "you are being
 * slow on sign-up" from "this IP is over the SSO-callback budget" without
 * string-matching an error sentence. **Treat these as wire format**: they are
 * not display strings and are not safe to rename once shipped — a client
 * branching on `scope` must keep working.
 */
export const RATE_SCOPE = {
  AUTH_SIGN_IN: "auth.sign-in",
  AUTH_SIGN_UP: "auth.sign-up",
  AUTH_PASSWORD_RESET_REQUEST: "auth.password-reset-request",
  AUTH_PASSWORD_RESET_SUBMIT: "auth.password-reset-submit",
  AUTH_SEND_VERIFICATION: "auth.send-verification",
  AUTH_VERIFY_EMAIL: "auth.verify-email",
  AUTH_SOCIAL: "auth.social",
  AUTH_SSO_START: "auth.sso-start",
  AUTH_SSO_CALLBACK: "auth.sso-callback",
  AUTH_CHANGE_PASSWORD: "auth.change-password",
  SSO_DOMAIN_CHECK: "enterprise.sso-domain-check",
  INVITE_ACCEPT: "enterprise.invite-accept",
  // #1927 — platform operator onboarding. Two surfaces, not one: minting a
  // privileged account is an authenticated, attributable act; redeeming one is
  // an unauthenticated act on a bearer token, so it is budgeted per token.
  STAFF_INVITE_CREATE: "platform.staff-invite-create",
  STAFF_INVITATION_ACCEPT: "platform.staff-invitation-accept",
} as const;

export type RateScope = (typeof RATE_SCOPE)[keyof typeof RATE_SCOPE];

/* -------------------------------------------------------------------------- */
/* Policy shape                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Which budgets participate in a policy.
 *
 * - `ip`      — one bucket per source address. The only dimension the edge can
 *               spend for body-carrying secrets, and the right one for a
 *               distributed attacker who is *not* yet spraying accounts.
 * - `account` — one bucket per email address, digest-keyed. The dimension a
 *               rotating-IP sprayer cannot reset.
 * - `token`   — one bucket per single-use secret (reset token, invitation id).
 *               The dimension that makes a leaked link provably useless quickly.
 */
export type RateDimension = "ip" | "account" | "token";

export type RateWindow = `${number} ${"ms" | "s" | "m" | "h" | "d"}`;

export interface RatePolicy {
  /** Wire identifier reported in the 429 body. */
  readonly scope: RateScope;
  readonly window: RateWindow;
  /**
   * Dimension -> requests allowed per `window`. The keys ARE the participants,
   * so there is no separate list to keep in sync with the numbers — the shape
   * that produced the `/forget-password` bug in the first place.
   */
  readonly dimensions: Readonly<Partial<Record<RateDimension, number>>>;
  /**
   * The canonical rationale, and the one place it is written down. The edge
   * rules are generated from scopes, so they cannot each carry their own
   * comment; this is what a reader of a 429 comes here for.
   */
  readonly description: string;
  /**
   * Override the derived Redis prefix. Used only to keep the two pre-existing
   * buckets that move under this table on their original keys, so deploying the
   * table extends those windows rather than opening a fresh hour of quota for
   * whoever is currently over them.
   */
  readonly redisPrefix?: string;
}

/* -------------------------------------------------------------------------- */
/* The table                                                                  */
/* -------------------------------------------------------------------------- */

export const RATE_POLICIES = {
  /* ---------------------------------------------------------------------- */
  /* Credential authentication                                              */
  /* ---------------------------------------------------------------------- */

  [RATE_SCOPE.AUTH_SIGN_IN]: {
    scope: RATE_SCOPE.AUTH_SIGN_IN,
    window: "15 m",
    dimensions: { ip: 30, account: 10 },
    description:
      "POST /api/auth/sign-in/email. IP 30/15m is far above a human (a few " +
      "typos, one Caps Lock discovery, a re-auth after a long idle) and well " +
      "below a scripted sweep of one address. Account 10/15m is the sprayed " +
      "dimension: an attacker with a residential proxy resets the IP counter " +
      "for free, and a counter that resets is a counter that never fills.",
  },

  [RATE_SCOPE.AUTH_SIGN_UP]: {
    scope: RATE_SCOPE.AUTH_SIGN_UP,
    window: "1 h",
    dimensions: { ip: 10, account: 3 },
    description:
      "POST /api/auth/sign-up/email. Ten an hour per address: signup is a " +
      "one-per-person event, and the ceiling is set by the disposable-mail " +
      "farming it enables rather than by user error — three an hour per " +
      "address stops one person minting throwaway accounts without touching a " +
      "corporate address list walk-on.",
  },

  [RATE_SCOPE.AUTH_CHANGE_PASSWORD]: {
    scope: RATE_SCOPE.AUTH_CHANGE_PASSWORD,
    window: "15 m",
    dimensions: { ip: 5, account: 5 },
    description:
      "POST /api/auth/change-password — session-bound, and gated on the " +
      "CURRENT password, which makes it a guessing surface for anyone holding a " +
      "stolen session. Five an hour per account covers a genuine user changing " +
      "it once after a support conversation, and makes five guesses visible as " +
      "an anomaly rather than a strategy.",
  },

  /* ---------------------------------------------------------------------- */
  /* Password reset                                                         */
  /* ---------------------------------------------------------------------- */

  [RATE_SCOPE.AUTH_PASSWORD_RESET_REQUEST]: {
    scope: RATE_SCOPE.AUTH_PASSWORD_RESET_REQUEST,
    window: "1 h",
    dimensions: { ip: 5, account: 3 },
    description:
      "POST /api/auth/request-password-reset — the endpoint the auth rule " +
      "used to call /forget-password, which BetterAuth does not have, so the " +
      "entire flow ran unthrottled. It is the most abusable route in the auth " +
      "surface: unbounded, it mails unlimited reset links (mail cost, and a " +
      "harassment channel) and turns the response into a batch oracle for which " +
      "addresses hold accounts. Three an hour per address is a person who " +
      "cannot find their mail and asks again; a list-walker exhausts it on the " +
      "first three probes per name.",
  },

  [RATE_SCOPE.AUTH_PASSWORD_RESET_SUBMIT]: {
    scope: RATE_SCOPE.AUTH_PASSWORD_RESET_SUBMIT,
    window: "1 h",
    dimensions: { ip: 20, token: 10 },
    description:
      "POST /api/auth/reset-password (secret in the JSON body) and " +
      "GET /api/auth/reset-password/:token (secret in the path). Twenty an " +
      "hour per IP for the body form — the edge cannot read the body, so the " +
      "token form there is handler-enforced. Ten an hour per token is spent by " +
      "the edge on the path form, and is the number that matters: a reset " +
      "token is a bearer credential, and ten uses an hour turns a leaked link " +
      "from a takeover into a statistic. A real user opens one link and submits " +
      "once.",
  },

  /* ---------------------------------------------------------------------- */
  /* Email verification                                                     */
  /* ---------------------------------------------------------------------- */

  [RATE_SCOPE.AUTH_SEND_VERIFICATION]: {
    scope: RATE_SCOPE.AUTH_SEND_VERIFICATION,
    window: "1 h",
    dimensions: { ip: 10, account: 3 },
    description:
      "POST /api/auth/send-verification-email. Was unthrottled entirely, which " +
      "made it a mail-bomb button: one POST per call, addressed to anyone, at " +
      "our sending reputation and our bounce rate. Same shape as the reset " +
      "request and for the same reason — ten an hour per IP, three per address.",
  },

  [RATE_SCOPE.AUTH_VERIFY_EMAIL]: {
    scope: RATE_SCOPE.AUTH_VERIFY_EMAIL,
    window: "1 h",
    dimensions: { ip: 30 },
    description:
      "GET /api/auth/verify-email?token=… (email-verification.mjs:109). IP " +
      "only: a verification token is single-use, so there is nothing to gain " +
      "from repeated attempts against one token, and the route also burns a " +
      "verifiable row. Thirty an hour leaves a shared address room for a team " +
      "joining on one connection while stopping token-enumeration sweeps.",
  },

  /* ---------------------------------------------------------------------- */
  /* Delegated authentication                                               */
  /* ---------------------------------------------------------------------- */

  [RATE_SCOPE.AUTH_SOCIAL]: {
    scope: RATE_SCOPE.AUTH_SOCIAL,
    window: "15 m",
    dimensions: { ip: 30 },
    description:
      "POST /api/auth/sign-in/social and GET /api/auth/callback/:id. " +
      "IP-keyed only, and generously: a legitimate user on a flaky mobile " +
      "connection retries the IdP round-trip several times inside one " +
      "fifteen-minute window, and a limit here reads to them as 'your Google " +
      "login is broken'. The abuse being bounded is provider callback abuse, " +
      "which is IP-shaped.",
  },

  [RATE_SCOPE.AUTH_SSO_START]: {
    scope: RATE_SCOPE.AUTH_SSO_START,
    window: "15 m",
    dimensions: { ip: 20, account: 10 },
    description:
      "POST /api/auth/sign-in/sso — the redirect out to the corporate IdP. " +
      "IP-keyed because an unauthenticated caller may not yet know which " +
      "address they are; account-keyed at ten because the start is also where " +
      "a single-tenant flood is aimed, and one attacker rotating addresses " +
      "against a single tenant's provider must still be caught.",
  },

  [RATE_SCOPE.AUTH_SSO_CALLBACK]: {
    scope: RATE_SCOPE.AUTH_SSO_CALLBACK,
    window: "15 m",
    dimensions: { ip: 30 },
    description:
      "GET /api/auth/sso/callback[/:providerId] and POST " +
      "/api/auth/sso/saml2/sp/acs[/:providerId] — the OIDC redirect landing " +
      "and the SAML HTTP-POST binding, i.e. both callback halves. SSO is " +
      "OIDC-only, but the sso() plugin still mounts the SAML ACS endpoint, so " +
      "it stays on budget. Was unthrottled. The budget is on the IP because " +
      "both arrive from the *user's* browser, not from the IdP, so the address " +
      "is the person's; thirty is set by the provider's own retry behaviour " +
      "rather than by ours — exceeding it locks a corporate user out of their " +
      "own IdP, so the ceiling is high and the abuse it still bounds is " +
      "callback stuffing. The IdP-originated SAML endpoints (metadata, SLO, " +
      "logout) are deliberately excluded: they come from the provider's shared " +
      "egress, where one address serves a whole tenant.",
  },

  /* ---------------------------------------------------------------------- */
  /* Enterprise surfaces that sit on the auth path                           */
  /* ---------------------------------------------------------------------- */

  [RATE_SCOPE.SSO_DOMAIN_CHECK]: {
    scope: RATE_SCOPE.SSO_DOMAIN_CHECK,
    window: "1 h",
    dimensions: { ip: 120 },
    redisPrefix: "rl:sso-domain-check",
    description:
      "GET /api/auth/sso/domain-check. Pre-login and returns " +
      "enforceSSO + org name for any recognised domain, so hit in a loop it " +
      "leaks the tenant list — the whole enterprise customer base. Raised from " +
      "60/hr to 120/hr: this endpoint is on the critical path of EVERY " +
      "corporate sign-in, and a shared-office NAT is a single IP for every " +
      "person on that floor. Sixty an hour was sized for enumeration and paid " +
      "for it with locked-out offices; 120 an hour is still minutes of " +
      "single-threaded enumeration, which is the only shape that threat takes.",
  },

  [RATE_SCOPE.INVITE_ACCEPT]: {
    scope: RATE_SCOPE.INVITE_ACCEPT,
    window: "1 h",
    dimensions: { ip: 60, token: 20 },
    redisPrefix: "rl:org-invite-accept",
    description:
      "POST /api/organizations/invitations/accept. Raised from 30/hr to " +
      "60/hr for the same NAT reason, and because accept is followed by the " +
      "invitee's first sign-up burst. The invitation id is in the request BODY, " +
      "so the per-invitation bucket is handler-enforced; twenty an hour makes a " +
      "scraped id list useless while a real invitee — who may retry a couple of " +
      "times on a failed upload — never notices.",
  },

  /* ---------------------------------------------------------------------- */
  /* Platform operator onboarding (#1927)                                   */
  /* ---------------------------------------------------------------------- */

  [RATE_SCOPE.STAFF_INVITE_CREATE]: {
    scope: RATE_SCOPE.STAFF_INVITE_CREATE,
    window: "1 h",
    dimensions: { account: 20 },
    description:
      "POST /api/admin/staff-invitations. Account-keyed on the ADMIN who is " +
      "doing the inviting, never on the invited address and never on the IP. " +
      "Keying on the invitee would be a foot-gun in the wrong direction (one " +
      "admin could exhaust a colleague's budget) and keying on the IP would " +
      "punish a whole office NAT for one person's mistake. Twenty an hour is " +
      "well above a real onboarding session — a first-admin hire, then a " +
      "batch of hires on a quiet afternoon — and low enough that a hijacked " +
      "admin session cannot mint a hundred privileged accounts before anyone " +
      "sees the OpsActionLog rows. The throttle is deliberately NOT the " +
      "moneyOpsLimiter: onboarding is not a money act, and sharing a bucket " +
      "would let a refunds burst lock the team out of hiring.",
  },

  [RATE_SCOPE.STAFF_INVITATION_ACCEPT]: {
    scope: RATE_SCOPE.STAFF_INVITATION_ACCEPT,
    window: "1 h",
    dimensions: { ip: 30, token: 10 },
    description:
      "POST /api/auth/staff-invitation/accept. Unauthenticated and token-" +
      "bearing, so it gets both dimensions: IP 30/hr stops a sweep of guessed " +
      "tokens from one host, and the per-token bucket is the one that " +
      "matters — a leaked setup link is a platform-privileged credential, and " +
      "ten redemption attempts an hour turns it from a takeover into a " +
      "statistic. Deliberately TIGHTER than the org invite's 60/20: an org " +
      "member's worst outcome is a membership, an operator's is `refunds." +
      "manage`. A real invitee opens one link and submits once, and the " +
      "password-strength check runs before the accept body is written, so a " +
      "typo costs one of the ten rather than the whole budget.",
  },
} as const satisfies Record<RateScope, RatePolicy>;

/* -------------------------------------------------------------------------- */
/* Limiter derivation                                                         */
/* -------------------------------------------------------------------------- */

/**
 * `rl:<scope with dots as colons>`, so the Redis keyspace reads the same way
 * the scope does and a `MONITOR` line can be traced back to a table row.
 */
function redisPrefixFor(scope: RateScope): string {
  return `rl:${scope.replace(/\./g, ":")}`;
}

const limiterCache = new Map<string, Ratelimit>();

/**
 * The `Ratelimit` instance for one scope and dimension.
 *
 * Derived from the declaration and memoised, so two call sites asking for the
 * same policy share one bucket (and therefore one counter) — the duplication
 * that let the limiter numbers drift from the rule in the first place.
 *
 * Throws on a dimension the policy does not declare. A typo in a dimension
 * would otherwise resolve to `undefined` requests and produce a limiter that
 * admits everyone, which is the failure mode this table exists to prevent.
 */
export function limiterFor(
  scope: RateScope,
  dimension: RateDimension = "ip",
): Ratelimit {
  const policy: RatePolicy = RATE_POLICIES[scope];
  const requests = policy.dimensions[dimension];
  if (requests === undefined) {
    throw new Error(
      `rate policy "${scope}" declares no "${dimension}" dimension ` +
        `(declared: ${Object.keys(policy.dimensions).join(", ") || "none"})`,
    );
  }
  const prefix = policy.redisPrefix ?? redisPrefixFor(scope);
  // Scope is deliberately absent from this key, but the effective configuration
  // is in it — so two policies that share a prefix AND a budget share a
  // limiter on purpose, and two that share only a prefix do not silently
  // inherit the wrong number.
  const cacheKey = `${prefix}|${dimension}|${requests}|${policy.window}`;
  const cached = limiterCache.get(cacheKey);
  if (cached) return cached;
  const limiter = makeLimiter(requests, policy.window, prefix);
  limiterCache.set(cacheKey, limiter);
  return limiter;
}

/* -------------------------------------------------------------------------- */
/* Named limiters                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Pre-resolved limiters for the surfaces that are not edge-enforced.
 *
 * They are derived HERE rather than declared as `makeLimiter` calls in
 * `lib/rate-limit.ts` on purpose. That file is the module `policies.ts`
 * imports `makeLimiter` from, so re-exporting from it would close a cycle;
 * and a fresh `makeLimiter` call would re-introduce exactly the problem this
 * table exists to prevent — a number living in two places, free to drift from
 * the rationale that justifies it. A caller that wants a budget for a
 * non-edge surface asks the table for it.
 */
export const staffInviteCreateLimiter = limiterFor(
  RATE_SCOPE.STAFF_INVITE_CREATE,
  "account",
);

export const staffInvitationAcceptIpLimiter = limiterFor(
  RATE_SCOPE.STAFF_INVITATION_ACCEPT,
  "ip",
);

export const staffInvitationAcceptTokenLimiter = limiterFor(
  RATE_SCOPE.STAFF_INVITATION_ACCEPT,
  "token",
);

/* -------------------------------------------------------------------------- */
/* Key derivation                                                             */
/* -------------------------------------------------------------------------- */

async function digestHex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Redis key for an email address: `sha256(lower(trim(email)))`, hex.
 *
 * Never put the address itself in a key.
 */
export function accountKey(email: string): Promise<string> {
  return digestHex(email.trim().toLowerCase());
}

/**
 * Redis key for a single-use secret (reset token, invitation id).
 *
 * Domain-separated from `accountKey` with a `token:` prefix. A reset token is a
 * bearer credential, so it gets the same no-plaintext rule as an address for
 * the same reason and one more: if address and token digests could collide, a
 * bucket written under one would silently answer for the other.
 */
export function tokenKey(token: string): Promise<string> {
  return digestHex(`token:${token.trim()}`);
}

/* -------------------------------------------------------------------------- */
/* Degradation                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The degradation flag and its header live in `lib/rate-limit.ts`, beside the
 * limiter that sets them — see `RATE_LIMIT_DEGRADED_HEADER` and
 * `isRateLimitDegraded()` there for the cross-isolate contract a captcha gate
 * needs to read.
 *
 * They are not here because a policy is a statement about a budget, and
 * whether that budget was *spent* is a property of the call, not the
 * declaration. `applyRateLimit` is the only thing that can know.
 */
