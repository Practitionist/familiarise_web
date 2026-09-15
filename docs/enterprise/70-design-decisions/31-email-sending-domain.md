---
title: Email sending domain, subdomain split and env-derived sender identities
band: 70-design-decisions
audience: sde3
status: live
last-reviewed: 2026-09-14
---

# ADR 31 — Email sending domain, subdomain split and env-derived sender identities

## Context

Signup, password reset and every other transactional email stopped reaching customers, tracked as issue #1298. Three causes compounded, and none was a copy mistake.

First, the `RESEND_API_KEY` deployed to Netlify production, the GitHub Actions secret, `.env` and `.mcp.json` all carried the same invalid value; Resend returned 400 "API key is invalid" on every send. Those failures were dead-lettered into `FailedEmail`, which is how the outage was eventually diagnosed, but nothing paged: the capture was a Sentry warning, and the retry worker walked all five attempts on every row even though no retry could succeed. A key that was absent rather than invalid would have been worse still, because the senders returned `{success: false}` before the message existed and nothing was recorded at all.

Second, every `from:` address in the codebase was `@familiarise.com`, a domain the company has never owned. It sits parked at NameBright/HugeDomains with an SPF record of `-all`, which instructs a receiving mail server to reject any mail claiming to be from it. Resend can only verify a domain whose DNS the account holder controls, so this domain could never have been verified, independent of the key.

Third, `familiarisenow.com` — the domain the company does own and the live site runs on — had no DKIM, SPF or DMARC records. Its DNS is Netlify DNS (nameservers at NS1), not the domain registrar, which is where the records needed to be added.

## Decision

1. **Send from `familiarisenow.com`, split across two subdomains.** `mail.familiarisenow.com` carries every transactional identity (`onboarding@`, `security@`, `payments@`, `notifications@`, `finance@`, `dpdp@`, `noreply@`, and the bare `system@` internal requester id, which is never used as a `From` header). `news.familiarisenow.com` carries only `newsletter@`, the waitlist double opt-in and broadcast sender. Splitting the domains keeps sender reputations apart: a bounce or complaint spike from a newsletter blast cannot degrade deliverability for password resets and payment confirmations, and Resend itself recommends sending from a subdomain rather than the apex domain. Buying `familiarise.com` was declined — the company does not control its DNS, so Resend cannot verify it regardless of ownership, and even owning it would not fix the second and third causes above.

2. **Every sender address is read from environment variables at call time, not hardcoded.** `SENDERS` in `lib/email/config.ts` is a set of getters, not constants, backed by `EMAIL_TRANSACTIONAL_DOMAIN` and `EMAIL_NEWSLETTER_DOMAIN` (defaulting to `mail.familiarisenow.com` and `news.familiarisenow.com`). `supportEmail()`, `contactInboxAddress()`, `billingEmail()` and `companyPostalAddress()` follow the same pattern, reading `NEXT_PUBLIC_SUPPORT_EMAIL`, `CONTACT_INBOX_ADDRESS`, `BILLING_EMAIL` and `NEXT_PUBLIC_COMPANY_POSTAL_ADDRESS` respectively, each falling back to the support mailbox where that makes sense. A hand-maintained domain string in eleven sender functions is exactly the failure mode #1298 exposed: nobody could grep-and-replace one wrong domain across the codebase with confidence that every call site was caught. Reading the domain at call time also means an environment can point at a different verified domain — a staging subdomain, for instance — without a code change.

3. **The Tokyo region (`ap-northeast-1`).** Resend offers four regions (`us-east-1`, `eu-west-1`, `sa-east-1`, `ap-northeast-1`); the region controls where Resend dispatches outbound mail from, not where Resend stores account data, which remains in the US regardless of the region chosen. Tokyo was picked as the region closest to the platform's user base without being a data-residency claim.

4. **Support and contact mail still lands in a real mailbox, not on the new domain.** `familiarisenow.com` has no MX record yet and cannot receive mail, so `NEXT_PUBLIC_SUPPORT_EMAIL` and `CONTACT_INBOX_ADDRESS` point at an existing inbox rather than an address on the new sending subdomains. Standing up inbound mail for `familiarisenow.com` is deliberately out of scope for this change.

5. **A missing or invalid key dead-letters instead of dropping the message.** `deliver()` in `lib/email/deliver.ts` is the single send core all eleven senders funnel through. `EmailNotConfiguredError` is thrown inside `deliver()`'s own try block, not before it, so a missing key takes the same `recordFailedEmail()` path into the `FailedEmail` table as any other terminal Resend failure, landing as `PENDING` rather than being lost with only a log line. This closes the silent half of the gap #1298 exposed: for a missing key the previous code path returned `{success: false}` before reaching the point where the message could be captured, and for an invalid key it captured the row but only at warning level. Either cause now pages at Sentry level "error" under one stable fingerprint, and the retry worker dead-letters a terminal Resend error on the first attempt instead of walking the ladder.

6. **The idempotency key is derived, not stored.** `lib/email/idempotency.ts` computes `<EMAIL_TYPE>/<sha256(to\nsubject\nhtml)[:48]>` from the message content itself and sends it as Resend's `Idempotency-Key` header. Resend deduplicates on that header for 24 hours, which covers the entire five-step retry ladder (one minute, five minutes, thirty minutes, two hours, eight hours) `jobs/email/retry-failed-emails.ts` walks. Because the key is a pure function of the message, the sender and the retry worker compute the same key independently without a database column to keep in sync, and a retry that races a Resend-side success which never reached the caller cannot double-send.

7. **A stale verification or reset link dead-letters without a send.** The retry worker dead-letters an `EMAIL_VERIFICATION` row once it is older than 60 minutes and a `PASSWORD_RESET` row once it is older than 30 minutes, matching the links' own expiry, rather than sending a link the recipient can no longer use.

## What was asked and declined

**Buying `familiarise.com`.** As covered in Context and Decision item 1, this does not address the DNS-control requirement Resend enforces, and does not fix the missing key or the unconfigured `familiarisenow.com` DNS.

**Sending from the apex domain (`familiarisenow.com`) instead of a subdomain.** Declined because a single domain shared between transactional and newsletter mail means a newsletter-driven bounce or spam-complaint spike degrades deliverability for password resets and payment confirmations, which is the more expensive failure. The subdomain split follows Resend's own guidance.

**Routing email through Novu instead of Resend directly.** Declined because none of the sixteen Novu workflow families has an email step — they are in-app only by ADR 30 — and Novu's own "email" integration is its demo provider, not a production path. Adding an email channel to Novu for these eleven transactional senders would introduce a second delivery pipeline with its own idempotency and dead-letter story to build, for no benefit over the `deliver()` core this ADR describes.

## Relations

Builds on ADR 27 (state-as-outbox with a scheduled ticker) — `FailedEmail` is the same durable-state pattern as `OutboundWebhookDelivery`, drained by a worker rather than a broker — and ADR 30 (Novu templates as code), which is why Novu is not a candidate for the email channel. Closes the email-sending half of #1298.
