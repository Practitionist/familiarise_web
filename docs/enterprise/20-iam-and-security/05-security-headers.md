---
title: Security headers
band: 20-iam-and-security
audience: sde2
status: live
last-reviewed: 2026-06-05
---

# Security headers

**New here?** HTTP response headers are instructions the server hands
the browser on every page: *don't let other sites frame me*
(`X-Frame-Options`), *only talk to me over HTTPS*
(`Strict-Transport-Security`), *only load scripts from this allow-list*
(`Content-Security-Policy`, "CSP"). They cost nothing at runtime and are
the first thing a large-customer security review greps for, so getting
them right is table stakes for enterprise.

PR #655 adds the two missing headers that block any large-customer
security review on Familiarise: `Content-Security-Policy` (report-only
by default) and `Strict-Transport-Security`. The other five were
already in place; they get a brief mention here for completeness.

**Design decision: ship CSP in report-only first, enforce later.**
A CSP that's even slightly too strict *breaks the page* — a blocked
script is a blank dashboard, in production, for everyone. So the policy
ships as `Content-Security-Policy-Report-Only`: the browser evaluates
every directive and *reports* what it would have blocked, but blocks
nothing. Violations POST to `/api/csp-report` and surface as
`event: "csp_violation"` log lines, giving a real-traffic window to find
the legitimate origin we forgot before any user hits a wall. Flipping
`ENABLE_CSP_ENFORCE=true` swaps the header key to
`Content-Security-Policy` — same directives, now enforced. The trade-off
is that report-only protects *nothing* while it's on (a real injection
isn't blocked, only logged); the bet is that a short observation window
is cheaper than a production breakage, and the §Rollout schedule keeps
that window bounded.

```mermaid
flowchart LR
  B[Browser renders a page] -->|"loads a resource outside the allow-list"| EVAL{"ENABLE_CSP_ENFORCE?"}
  EVAL -->|"false (report-only)"| ALLOW["resource LOADS + violation reported"]
  EVAL -->|"true (enforce)"| BLOCK["resource BLOCKED + violation reported"]
  ALLOW --> POST["POST /api/csp-report"]
  BLOCK --> POST
  POST --> LOG[("log line — event: csp_violation")]
  LOG --> OP["operator scans during rollout, fixes allow-list"]
```

## Header inventory (production)

| Header | Value | Notes |
|---|---|---|
| `Content-Security-Policy-Report-Only` | see `next.config.mjs` CSP_DIRECTIVES | flipped to enforce by `ENABLE_CSP_ENFORCE=true` |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` | 2-year window + preload-list eligibility |
| `X-Frame-Options` | `DENY` | Anti-clickjacking |
| `X-Content-Type-Options` | `nosniff` | Anti-MIME-sniffing |
| `X-DNS-Prefetch-Control` | `off` | Reduces info leakage |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | |
| `Permissions-Policy` | `camera=(self), microphone=(self), geolocation=(), payment=()` | Stream.io needs camera/mic; payment is iframe-scoped via Razorpay |

All seven are applied globally via `next.config.mjs` `async headers()`
(the single `source: "/(.*)"` block over `securityHeaders`). There are
no per-route overrides — the production allow-list is already narrow
enough to cover the dashboard surface (`/dashboard/organization/[orgId]/**`)
and the public marketplace pages alike.

## CSP allow-list rationale

Anything outside this list will be blocked once `ENABLE_CSP_ENFORCE=true`:

- **`script-src`** — `'self' 'unsafe-inline' 'unsafe-eval'` is non-negotiable until Next.js 16 ships hashed inline runtime chunks. External:
  - `https://checkout.razorpay.com` — payment SDK
  - `https://*.sentry.io` — error reporting
  - `https://*.getstream.io` — call widget
  - `https://*.supabase.co` — storage signed URLs

- **`connect-src`** — XHR / fetch / WSS targets. External:
  - `https://api.razorpay.com`
  - `wss://*.getstream.io` + `https://*.getstream.io`
  - `https://*.supabase.co` + `https://*.upstash.io`
  - `https://*.sentry.io`
  - `https://api.resend.com`

- **`media-src`** — Stream.io recording + call audio/video. Requires both `blob:` (local recording playback) and the getstream.io CDN.

- **`frame-src`** — Razorpay checkout opens an iframe. Without this entry, payments break in CSP-enforce mode.

The remaining directives in `CSP_DIRECTIVES` carry no external origins
and are listed here for completeness: `default-src 'self'`,
`style-src 'self' 'unsafe-inline'` (Tailwind/runtime inline styles),
`font-src 'self' data:`, and `img-src 'self' data: https: blob:` —
note `img-src` is deliberately broad (`https:`) because user/consultant
avatars come from many CDNs (Google, GitHub, logo.dev, Supabase, …);
tightening it would mean enumerating every avatar host in the
`images.remotePatterns` list.

## Rollout

1. **Day 0 (now)**: report-only mode shipped. Violations stream to `/api/csp-report` and surface as `event: "csp_violation"` log lines.
2. **Day 7**: review the report log for unexpected entries. Update the allow-list if a legitimate dependency was missed; create an issue if a suspicious entry shows up.
3. **Day 14**: flip `ENABLE_CSP_ENFORCE=true` in the production env. The header key changes from `Content-Security-Policy-Report-Only` to `Content-Security-Policy`; the same reports keep arriving but the browser blocks the request instead of allowing-but-flagging.

## Auditing

Headers are visible via `curl -sI`. The rollout-readiness check:

```bash
curl -sI https://app.familiarise.work/ | grep -iE 'content-security|strict-transport|x-frame'
```

Expected lines:

```
content-security-policy-report-only: default-src 'self'; ...
strict-transport-security: max-age=63072000; includeSubDomains; preload
x-frame-options: DENY
```
