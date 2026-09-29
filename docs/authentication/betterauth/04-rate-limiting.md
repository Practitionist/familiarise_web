# Rate Limiting

| Field | Value |
|---|---|
| Status | Stable |
| Audience | All engineers |
| Last reviewed | 2026-09-29 |
| Source files | `lib/rate-limit/policies.ts`, `lib/rate-limit.ts`, `lib/auth/attempts.ts`, `lib/redis-edge.ts`, `middleware.ts` |

## 1. Background

Rate limiting prevents brute-force attacks, scraping, spam, and cost amplification under DDoS. All limiters use [Upstash Redis](https://upstash.com/) sliding windows via `@upstash/ratelimit`.

Two categories of limiters exist:

- **Edge limiters** — applied in `middleware.ts`, run before any serverless function. IP-keyed. Prevents cost amplification.
- **Handler limiters** — applied inside API route handlers. User-keyed or route-scoped. Provides per-user fairness.

Every auth and enterprise limit used to be a hand-written edge rule, and that is
how `/forget-password` stayed in the matcher for the life of the app. Those are
now **generated from a policy table** (§2.2), which is a third shape: a
declaration that the middleware reads a scope from and a limiter is built
out of. The rule of thumb for deciding which shape a new limit takes is in
§3.

## 2. Design

### 2.1 Fail-Open Posture

```typescript
try {
  const { success } = await limiter.limit(identifier);
  if (!success) return NextResponse.json(..., { status: 429 });
  return null;
} catch {
  return null; // Redis down — fail open
}
```

> [!IMPORTANT]
> If Upstash Redis is unreachable, **all rate limits fail open** — requests proceed. This is intentional: shipping a request during a Redis outage beats 429-ing every login. Monitor Upstash uptime in the ops dashboard.
>
> The same outage has a second consequence the fail-open does not address, and
> it is the reason `RATE_LIMIT_DEGRADED_HEADER` exists: under store failure
> **the budgets are not being enforced**, silently, on exactly the credential
> endpoints where the human at the keyboard is the last remaining line. Consumers
> inside a handler read the `x-rate-limit-degraded` request header (the
> module-level `isRateLimitDegraded()` is always `false` in a handler, because
> edge middleware and the route are separate isolates with separate module
> graphs). The intended response is to **raise the price of a guess** — captcha,
> step-up — not to lock the site down. No consumer reads it yet; see
> [`09-failure-modes.md`](./09-failure-modes.md) row 1.

### 2.2 The policy table — why the auth rules are generated

`middleware.ts` used to name `/api/auth/forget-password` in the auth rule's
`match`, and **BetterAuth has never had an endpoint by that name**. The real
password-reset-request route is `/api/auth/request-password-reset`
(`better-auth/dist/api/routes/password.mjs:20`). The prefix never matched, so the
whole forgot-password flow ran unthrottled — the endpoint that mails an attacker
unlimited reset links, and the one an attacker uses to confirm which addresses
hold accounts.

The rule was invisible, and it was invisible *because* the limiter name, the
path list and the 429 scope string were three unrelated pieces of text that
nothing kept in agreement.

So [`lib/rate-limit/policies.ts`](../../../lib/rate-limit/policies.ts) declares
the scope, the window, every participating budget, and the rationale **in one
row**, and `middleware.ts` builds its rules from `POLICY_ROUTES`, which can only
name a **scope** — it can no longer name a number. Three properties follow:

- A path that does not exist cannot be given a budget.
- A budget cannot drift from the scope that reports it.
- A policy declared but never matched at the edge logs an error at boot
  (`UNWIRED_SCOPES`), so dead configuration cannot read as protection.

#### The auth and enterprise policies

| Scope | Window | ip | account | token | Route |
|---|---|:--:|:--:|:--:|---|
| `auth.sign-in` | 15 m | 30 | 10 | — | `POST /api/auth/sign-in/email` |
| `auth.sign-up` | 1 h | 10 | 3 | — | `POST /api/auth/sign-up/email` |
| `auth.change-password` | 15 m | 5 | 5 | — | `POST /api/auth/change-password` |
| `auth.password-reset-request` | 1 h | 5 | 3 | — | `POST /api/auth/request-password-reset` |
| `auth.password-reset-submit` | 1 h | 20 | — | 10 | `POST /api/auth/reset-password` (body) + `GET /api/auth/reset-password/:token` (path) |
| `auth.send-verification` | 1 h | 10 | 3 | — | `POST /api/auth/send-verification-email` |
| `auth.verify-email` | 1 h | 30 | — | — | `GET /api/auth/verify-email?token=…` |
| `auth.social` | 15 m | 30 | — | — | `POST /api/auth/sign-in/social`, `GET /api/auth/callback/:id` |
| `auth.sso-start` | 15 m | 20 | 10 | — | `POST /api/auth/sign-in/sso` |
| `auth.sso-callback` | 15 m | 30 | — | — | `GET /api/auth/sso/callback[/:providerId]`, `POST /api/auth/sso/saml2/sp/acs[/:providerId]` |
| `enterprise.sso-domain-check` | 1 h | 120 | — | — | `GET /api/auth/sso/domain-check` |
| `enterprise.invite-accept` | 1 h | 60 | — | 20 | `POST /api/organizations/invitations/accept` |

`auth.sign-in` carries `lockAfter: 8` — **metadata only, deliberately not
implemented here.** The lockout needs an exact consumed count, a per-address TTL
that doubles on the second offence, and deletion on success, none of which a
sliding window expresses. It lives in [`lib/auth/attempts.ts`](../../../lib/auth/attempts.ts)
and is gated inside the sign-in handler. The edge budget is the coarse layer
*underneath* it and must stay wide enough not to lock a user out a minute before
the real lockout fires, or the customer is told "too many attempts" for a reason
they cannot see. Keep the number equal to `LOCKOUT_THRESHOLD`.

#### What the edge can and cannot enforce

Middleware runs before any serverless function, sees the method, the path and a
handful of headers, and **cannot read the request body** — consuming the stream
in middleware strands the handler, and `NextRequest` offers no rewind. BetterAuth
takes its secrets in JSON bodies (`sign-in/email` `{email, password}`,
`request-password-reset` `{email}`, `reset-password` `{newPassword, token}`).

So the `account` and most `token` dimensions are **declared and exported here but
not spent by the edge**; they are spent by whichever handler parses the body.
`middleware.ts` spends only the `ip` dimension, and says so at the call site.

Two exceptions exist, and they are the two routes that carry their secret in the
URL — which are exactly the two that most need a per-secret budget:

- `GET /api/auth/reset-password/:token` — token in the path.
- `GET /api/auth/verify-email?token=…` — token in the query.

`POST /api/auth/reset-password` is **deliberately IP-keyed even though the token
may also arrive as a query param.** Keying on it only when present would be a
bypass: drop the query and the budget reverts to the IP one.

#### Keys are digests, never addresses

`accountKey` and `tokenKey` both return `sha256(lower(trim(value)))`, hex.
Upstash keys are plaintext at rest and visible in `MONITOR`, so an address list
living in Redis is a customer list living in Redis — the same reason this project
holds `sendDefaultPii: false` in Sentry. Trimming and lower-casing first is what
makes the budget *per account* rather than per string: without it `Bob@x.com`
and `bob@x.com ` are two budgets for one account and the second is free.

`tokenKey` is domain-separated with a `token:` prefix. A reset token is a bearer
credential, so it gets the no-plaintext rule for the same reason and one more: if
address and token digests could collide, a bucket written under one would
silently answer for the other.

The same algorithm is written twice — `accountAttemptKey` in
`lib/auth/attempts.ts` (which is `node:crypto`) and `accountKey` here (Web
Crypto, so the module is Edge-safe). The mitigation is that this module exports
`accountKey` and callers import it rather than re-deriving it.

#### Deliberately excluded from `auth.sso-callback`

`/sso/saml2/sp/metadata`, `/sso/saml2/sp/slo` and `/sso/saml2/logout` are
excluded. They are fetched by the **IdP**, from its own shared egress, where one
address serves a whole tenant; a per-IP bucket there is a corporate NAT
throttling every employee in the building. The abuse surface is nil, because the
ACS signature is the actual gate.

#### `skipLocalhost` and the two pre-existing buckets

Every policy-derived rule sets `skipLocalhost: true`, uniformly. The hand-written
rules keep the original deliberate inconsistency (public reads limit even
locally).

`orgInviteAcceptLimiter` (30/hr) and `ssoDomainCheckLimiter` (60/hr) still exist
in `lib/rate-limit.ts` and still share the `rl:org-invite-accept` and
`rl:sso-domain-check` prefixes — which is why the table's `redisPrefix` override
exists. Deploying the table therefore **widened two existing windows** (30 → 60,
60 → 120) rather than opening a fresh hour of quota for whoever was already over
them. A stale caller gets the same bucket, not a second one that can be spent
too.

### 2.3 The rest of the edge table

#### Edge-Applied (middleware.ts)

| Limiter | Endpoint | Key | Limit | Window |
|---|---|---|---|---|
| *(policy)* | all eleven auth + enterprise scopes in §2.2 | see table | see table | see table |
| `sessionMgmtLimiter` | `/api/user/sessions*` except the signal poll — device list, per-device revoke, revoke-others (#1856; own limiter so session traffic cannot exhaust the sign-in budget; generous because one office NAT shares it) | IP | 120 | 15 min |
| `streamJoinLimiter` | `POST /api/meetings/:id/join` (#1134 P1-11; deterministic call ids make this the enumeration surface) | IP | 20 | 1 min |
| `streamApiLimiter` | `/api/stream/**` except `/api/stream/webhooks` | IP | 60 | 1 min |
| `searchLimiter` | GET `/api/user/consultants`, GET `/api/explore/recordings` | IP | 60 | 1 min |
| `eligibilityLimiter` | GET `/api/trials/check-eligibility` | IP | 20 | 1 min |
| `waitlistLimiter` | POST `/api/waitlist` | IP | 3 | 1 hr |
| `availabilityLimiter` | GET `/api/scheduling/availability/` | IP | 30 | 1 min |
| `availabilityGridLimiter` | GET `/api/scheduling/availability-with-allocation/` | IP | — | 1 min |
| `orgWalletTopUpLimiter` | POST `…/billing-account/wallet/top-ups` | `org:<orgId>` | 20 | 1 hr |

`streamApiLimiter` excludes the webhook endpoint on purpose: Stream POSTs every
delivery from its own infrastructure, so a burst is the *normal* shape — a
200-attendee webinar emits 200 `call.session_participant_joined` events at
once, and Stream retries inside a fifteen-second budget and then **drops the
event permanently**. Throttling it from middleware would undo ack-first work
before the route ever ran.

#### Handler-Applied (inside route handlers)

| Limiter | Endpoint | Key | Limit | Window |
|---|---|---|---|---|
| `sessionMgmtUserLimiter` | the same `/api/user/sessions*` routes, applied in-handler past `requireApiAuth` — the precise per-user gate | userId | 60 | 15 min |
| `orgInviteLimiter` | POST `/api/organizations/[orgId]/invitations` | `orgId` | 20 | 1 hr |
| `orgWebhookLimiter` | POST/PATCH `…/webhooks[/:id]`, `…/rotate-secret` | `org:<orgId>` | 5 | 1 min |
| `orgDataExportLimiter` | POST `/api/organizations/[orgId]/data-exports` | `org:<orgId>` | 1 | 24 hr |
| `scimLimiter` | `/scim/v2/**` — inside `requireScimAuth`, so every verb inherits it | `scim:<tokenHash>` | 60 | 1 min |
| `checkoutLimiter` | POST `/api/checkout` | userId | 5 | 1 min |
| `discountLimiter` | POST `/api/payments/discounts/validate` | userId | 10 | 1 min |
| `referralApplyLimiter` | POST `/api/referrals/apply` | userId | 3 | 24 hr |
| `spamLimiter` | support-tickets, feedbacks, reviews, report | `<route>:<userId>` | 5 | 1 hr |
| `trialRequestLimiter` | POST `/api/trials` | userId | 3 | 24 hr |
| `requestApprovalLimiter` | POST `/api/scheduling/request-for-approval` | userId | 10 | 1 hr |
| `cspReportLimiter` | POST `/api/csp-report` | IP | 120 | 1 min |

`cspReportLimiter` is separate from `spamLimiter` for a reason worth keeping: a
browser emits one report per violated directive per navigation, so a single
person opening a few dashboard pages exhausted a 5/hour budget and every
subsequent report was rejected with a 429. Size a report sink's limiter by **who
generates the traffic**, not by how much you want to receive.

### 2.4 Localhost Bypass

`isBypassableIp(clientIp)` in `lib/rate-limit.ts` returns true for `::1`,
`127.0.0.1` and the `unknown_ip` sentinel — **but only when
`NODE_ENV !== "production"`**. In production it returns `false` for every value
including the sentinel, so a header-stripping proxy cannot silently disable a
limiter.

The bypass is **per rule**, and the values are deliberately inconsistent. Every
auth/enterprise credential rule sets `skipLocalhost: true` (a developer running
`npm run dev` behind the same IP as their other services must not be able to lock
themselves out of signing in); the public read rules set it `false` so they
rate-limit even locally. Preserve the original value when editing a hand-written
rule.

### 2.5 IP Extraction

```typescript
export function getClientIp(req) {
  const ip = req.ip ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return ip || "unknown_ip";
}
```

`req.ip` is Vercel/Netlify-provided. Behind other proxies, `x-forwarded-for` is used. Falls back to `"unknown_ip"`, which is bypassed in development and treated as a real bucket in production.

## 3. How to Add a New Rate Limit

### An auth or enterprise surface: declare a policy

1. **Add a scope to `RATE_SCOPE`** if this is a genuinely new machine identifier.
   Treat the string as wire format — it is sent verbatim in the 429 body so a
   client can tell "you are being slow on sign-up" from "this IP is over the
   SSO-callback budget" without string-matching a sentence. It is not safe to
   rename once shipped.
2. **Add a row to `RATE_POLICIES`**, with the window, the dimensions (the keys
   *are* the participants, so there is no separate list to keep in sync), and
   the `description` — the canonical rationale, and the one place it is written
   down, because the generated rules cannot each carry their own comment.
3. **Add a `POLICY_ROUTES` entry in `middleware.ts`** that names the scope and
   the method + path predicate. A rule cannot name a budget, only a scope.
4. **Verify it is actually matched.** An unwired policy logs
   `[middleware] rate-limit policies declared but never matched at the edge` at
   boot. If you see that line, the budget is not being spent and the scope
   reads as protection that does not exist.
5. **Assert the 429** — fire N+1 requests and check the tail is a 429 carrying
   `scope` and `retryAfterSeconds`.

If the secret is in the request body, declare the `account` / `token` dimension
anyway and note at the call site that the edge spends only `ip`; the
handler-enforced half is the one that actually protects the secret.

### Any other surface: the classic two-step

1. **Create the limiter** in `lib/rate-limit.ts`:
   ```typescript
   export const myLimiter = makeLimiter(10, "1 h", "rl:my-route");
   ```

2. **If edge-applied** — append a `RateRule` to `RATE_LIMIT_RULES` in
   `middleware.ts`:
   ```typescript
   {
     label: "public: my route",
     match: (p, m) => m === "POST" && p.startsWith("/api/my-route"),
     limiter: myLimiter,
     skipLocalhost: false,
   }
   ```

3. **If handler-applied** — call in the API route handler:
   ```typescript
   import { applyRateLimit, myLimiter } from "@/lib/rate-limit";
   const rl = await applyRateLimit(myLimiter, `my-route:${session.user.id}`, SCOPE);
   if (rl) return rl;
   ```

4. **Choose the key:** IP for public endpoints, userId for authenticated
   endpoints, `org:<orgId>` for org-scoped endpoints. Prefix with a route slug
   when reusing `spamLimiter` across multiple endpoints.

5. **Set a `redisPrefix` override only to keep a pre-existing bucket on its
   original key.** Deploying a widened budget should extend the window for
   whoever is already inside it, not open a fresh one alongside it.

## 4. Edge Cases & Foot-Guns

1. **Shared NAT.** IP-based limits block everyone behind a corporate NAT. This
   has bitten twice and both corrections are in the policy table's
   `description` fields: `enterprise.sso-domain-check` went 60 → 120/hr (it is on
   the critical path of *every* corporate sign-in, and one office floor is one
   IP) and `enterprise.invite-accept` went 30 → 60/hr (accept is followed by the
   invitee's first sign-up burst).
2. **The BetterAuth endpoint matcher is not a prefix.** A bare `/sign-in` in an
   `endpoints` list does not match; the plugin's matcher requires an exact path or
   an explicit wildcard. That is a *different* footgun from the `/forget-password`
   one, which matched nothing because the path does not exist — and the second is
   the reason the policy table exists.
3. **org-keyed wallet limiter.** `orgWalletTopUpLimiter` extracts `orgId` from
   the URL path (`pathname.split("/")[3]`). If the URL structure changes, update
   the extraction.
4. **Redis prefix collision.** Each limiter has a unique prefix. Never reuse one —
   and note that the policy table's `rl:<scope with dots as colons>` derivation
   exists so a `MONITOR` line can be traced back to a table row.
5. **Do not throttle a provider's webhook endpoint.** A 429 on a Stream delivery
   is not a deferral; Stream retries inside a fifteen-second total budget and then
   drops the event permanently.
6. **Never inline a second limiter where a policy exists.** The `lockAfter` field
   on `auth.sign-in` is metadata precisely so a second budget cannot be declared
   next to the one that is actually enforced.

## 5. Related Docs

- [02-middleware.md](./02-middleware.md) — Where edge limiters are wired
- [04-errors.md](./04-errors.md) — how a 429 becomes "Try again in 12 minutes",
  and why `scope` is wire format
- [09-failure-modes.md](./09-failure-modes.md) — rows 1, 2 and 20: the degraded
  store, the plan quota, and the route that ran unthrottled
- [../../enterprise/20-iam-and-security/04-rate-limiting.md](../../enterprise/20-iam-and-security/04-rate-limiting.md)
  — the enterprise coverage matrix, for the org-scoped handler limiters
- [docs/upstash/](../../upstash/) — the command ceiling the quota row runs into
