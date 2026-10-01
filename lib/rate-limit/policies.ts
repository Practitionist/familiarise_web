/**
 * Rate-limit policies for the app routes that sit on the auth path but are not
 * BetterAuth endpoints, so BetterAuth's own limiter (lib/auth/rate-limit.ts)
 * never sees them.
 *
 * A policy declares the scope string a 429 reports, the window and each
 * budget; the limiter is derived from that declaration so the number cannot
 * drift from the scope that reports it.
 *
 * ## Account keys are digests, never addresses
 *
 * `sha256(lower(trim(email)))`, hex. Upstash keys are plaintext at rest and
 * visible in `MONITOR`, so an address list living in Redis is a customer list
 * living in Redis. Trimming and lower-casing first makes the budget per
 * account rather than per string. Hashing uses Web Crypto, so this module is
 * also safe to import from Edge middleware.
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
 * - `ip`      — one bucket per source address.
 * - `account` — one bucket per user, digest-keyed.
 * - `token`   — one bucket per single-use secret, so a leaked link is only
 *               good for a bounded number of attempts.
 */
export type RateDimension = "ip" | "account" | "token";

export type RateWindow = `${number} ${"ms" | "s" | "m" | "h" | "d"}`;

export interface RatePolicy {
  /** Wire identifier reported in the 429 body. */
  readonly scope: RateScope;
  readonly window: RateWindow;
  /**
   * Dimension -> requests allowed per `window`. The keys ARE the participants,
   * so there is no separate list to keep in sync with the numbers.
   */
  readonly dimensions: Readonly<Partial<Record<RateDimension, number>>>;
  /** The rationale; what a reader of a 429 comes here for. */
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
  /* Enterprise surfaces that sit on the auth path                          */
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
