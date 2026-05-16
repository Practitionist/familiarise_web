# Rate limiting

> **Scope.** Auth + enterprise rate-limit coverage matrix, who enforces
> what, and why BetterAuth's own limiter is disabled.
>
> **Audience.** Engineers touching `middleware.ts`, `lib/auth.ts`,
> any unauthenticated route under `app/api/auth/**`, or the wallet /
> invoice endpoints.

---

## §1 — Why BetterAuth's built-in limiter is disabled

`lib/auth.ts` carries `rateLimit: { enabled: false }`. This is deliberate:

- BetterAuth's limiter is **in-memory per Node.js process**.
- We deploy to **Netlify** (serverless). Each cold-start lambda gets
  its own counter. An attacker can race past a per-process gate by
  rotating through enough fresh lambdas.
- A globally-coherent limit has to live in shared state. We use
  Upstash Redis.

If you ever re-enable BetterAuth's limiter, audit the overlap against
the Upstash-backed limiters below. Double-counting produces two
different 429 responses for the same flow and confuses operators
during incident response.

See audit Phase B.8.

---

## §2 — Coverage matrix

| Surface | Limiter | Window | Key | Source |
|---|---|---|---|---|
| `POST /api/auth/sign-up/email` | `authLimiter` (Upstash) | 10 req / 15 min | IP | `middleware.ts:192-197` |
| `POST /api/auth/sign-in/email` | `authLimiter` (Upstash) | 10 req / 15 min | IP | `middleware.ts:192-197` |
| `POST /api/auth/forget-password` | `authLimiter` (Upstash) | 10 req / 15 min | IP | `middleware.ts:192-197` |
| `POST /api/auth/reset-password` | `authLimiter` (Upstash) | 10 req / 15 min | IP | `middleware.ts:192-197` |
| `GET /api/auth/sso/domain-check` | `unauthLimiter` (Upstash) | 60 req / hour | IP | `middleware.ts:240-246` |
| `POST /api/organizations/invitations/accept` | `inviteAcceptLimiter` | 5 req / hour | IP | `middleware.ts:231-233` |
| `POST /api/organizations/[orgId]/billing-account/wallet/top-ups` | `walletTopUpLimiter` | 20 req / hour | `org:${orgId}` | `middleware.ts:254-267` |

Everything else inherits the org-scoped role gates in
`lib/auth-helpers.ts:requireOrgAccess` and the IP-level Cloudflare /
Netlify edge rate limits (the latter are operational, not in code).

---

## §3 — Localhost bypass

`isBypassableIp(clientIp)` returns true for `::1`, `127.0.0.1`, and the
unknown-IP sentinel. The booking-algorithm-tests + Chrome MCP runs
need to fire hundreds of requests in a few minutes; the bypass keeps
them unblocked without weakening production rate limits (production
traffic never carries those IPs).

The bypass is fenced inside `middleware.ts` — it cannot be reached
from a real client connecting via Vercel / Netlify edge.

See `CLAUDE.md` memory note on agent-006 booking tests for context.

---

## §4 — What's NOT rate-limited (and why)

- **Authenticated org-scoped reads** (`GET /api/organizations/[orgId]/...`)
  — gated by `requireOrgAccess`. A bad actor with a valid OWNER
  session can already query the org's data; rate-limiting would just
  punish a UI bug that triggers a fetch loop. Use TanStack Query's
  `staleTime` to deduplicate.
- **Webhooks** (`POST /api/webhooks/razorpay`, etc.) — signature
  verification is the gate. Rate-limiting would risk dropping
  legitimate retries from the gateway.
- **Static assets + Next.js system routes** — handled at the edge.

---

## §5 — How to add a new limiter

1. Define the limit in `middleware.ts` near the existing ones:
   ```ts
   const myLimiter = new Ratelimit({
     redis,
     limiter: Ratelimit.slidingWindow(<count>, "<window>"),
     prefix: "rl:my-key",
   });
   ```
2. Apply inside the appropriate path branch. Use the same
   `applyRateLimit(myLimiter, key)` helper everywhere — it returns a
   `Response` (429) on exceed and `null` on pass.
3. **Document the limiter in §2 of this doc** so the matrix stays
   complete.
4. Add an MCP test case to the relevant prompt file (see SSO.9 in
   `prompts/enterprise-tests/1-membership-auth/1.3-sso-and-domain-claims.md`
   for the pattern — fire N requests, assert the tail returns 429).

---

## §6 — Common pitfalls

- **Don't pick a key shared across tenants.** A limiter keyed on
  `unknown_ip` from behind a corporate NAT will punish the whole
  company.
- **Don't put auth-mutation rate limits behind the auth gate.** If you
  apply `authLimiter` only after `requireApiAuth`, a brute-force
  attacker on the signin endpoint is never gated — the limiter must
  run BEFORE the session check.
- **Don't conflate idempotency with rate limiting.** A wallet top-up
  retry of the same `clientIdempotencyKey` is legitimate and should
  not count against the limiter (or should at least be deduped before
  counting). The current `walletTopUpLimiter` counts every request;
  the idempotency key handles deduplication at the route layer.

---

## §7 — Audit references

- Phase B.8 — documented decision to keep BetterAuth's limiter
  disabled.
- `lib/auth.ts:31` — the comment block referencing this doc.
