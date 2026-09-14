# The Resend outage, its three causes, and the send core that replaced it

**Date:** 2026-09-14 · **Branch:** `hotfix/email-resend-2026-09-14` · **Issue:** #1298 · **PR:** #1646 · **Scope:** every direct Resend send (`lib/email.ts`, now `lib/email/`) and its retry worker.

This entry records why signup, password reset and every other transactional email stopped reaching customers, the three independent causes behind the single symptom, and the send core the fix introduced so the same class of failure dead-letters instead of dropping mail silently.

## The reported symptom

New signups never received a verification email, and a password reset link never arrived. Resend's dashboard showed a 400 on every send attempt: `"API key is invalid."`

## The three causes

| #   | Cause in one line                                                                                                                                                                                                   | Where                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| C1  | The `RESEND_API_KEY` value deployed to Netlify production, the GitHub Actions secret, `.env` and `.mcp.json` was the same invalid key in all four places.                                                           | Netlify env, GitHub secret, `.env`, `.mcp.json` |
| C2  | Every `from:` address used `@familiarise.com`, a domain the company has never owned; it sits parked at NameBright/HugeDomains with SPF `-all`, which tells receiving servers to reject mail claiming to be from it. | `lib/email.ts` (all senders)                    |
| C3  | `familiarisenow.com` — the domain the company does own and the live site runs on — had no DKIM, SPF or DMARC records; its DNS is Netlify DNS, not the domain registrar.                                             | DNS zone for `familiarisenow.com`               |

None of the three alone explains the outage: fixing only the key would still fail domain verification, and fixing only the domain would still 400 on an invalid key.

### C1 — one invalid key, deployed to four places

The key had gone stale, and because it lived in four independent locations (Netlify prod, the GitHub Actions secret used by the retry-worker cron, local `.env`, and the Resend MCP server config in `.mcp.json`), there was no single place to rotate it. The owner runbook added in this PR (`docs/notifications/05-pre-production-checklist.md`) now lists all four explicitly, in rotation order.

### C2 — a domain the company never controlled

`@familiarise.com` could never have been verified in Resend, because Resend only verifies a domain whose DNS the account holder controls. The parked domain's `SPF -all` record actively told receiving mail servers to reject anything claiming to be from it, so even a successful Resend send would likely have been rejected or spam-foldered downstream.

### C3 — the owned domain had no mail records

`familiarisenow.com` is the domain the company owns and the site is deployed under, but nobody had added the DKIM, SPF or DMARC records Resend requires, and its DNS lives in Netlify DNS rather than at the registrar most engineers would have checked first.

## The fix

`lib/email.ts` became `lib/email/{index,config,deliver,idempotency,classify,render}.ts` (`@/lib/email` still resolves). `deliver()` in `lib/email/deliver.ts` is now the single send core behind all eleven senders:

- Sender addresses split across two subdomains of `familiarisenow.com` — `mail.` for transactional, `news.` for the waitlist/newsletter — read from `EMAIL_TRANSACTIONAL_DOMAIN` / `EMAIL_NEWSLETTER_DOMAIN` at call time rather than hardcoded, closing the class of bug in C2.
- `EmailNotConfiguredError` is thrown inside `deliver()`'s own try block, so a missing or invalid key dead-letters into the `FailedEmail` table instead of returning early and dropping the message, closing the class of bug in C1.
- A content-hash Idempotency-Key (`<EMAIL_TYPE>/<sha256(to\nsubject\nhtml)[:48]>`) is sent on every Resend request; Resend deduplicates on it for 24 hours, which covers the whole five-step retry ladder.
- The retry worker (`jobs/email/retry-failed-emails.ts`) dead-letters a terminal failure on the first attempt with a paging Sentry message, and dead-letters an expired `EMAIL_VERIFICATION` (60 min) or `PASSWORD_RESET` (30 min) row without a send.
- `lib/auth.ts` now awaits `sendWelcomeEmail()` and `sendAccountLinkedEmail()` inside a try/catch, because an un-awaited call is dropped when a Netlify instance freezes right after the response is sent.
- `react-email` 6.9.5 replaced the deprecated `@react-email/components` and `@react-email/render`, and two shared components (`EmailLogo`, `EmailFooter`) replaced six templates' relative `../public/...` logo paths, which cannot load in a mail client.

The full design rationale is recorded in [ADR 31](../enterprise/70-design-decisions/31-email-sending-domain-and-sender-identities.md). The owner runbook for rotating the key and adding the two subdomains is in [05-pre-production-checklist.md](./05-pre-production-checklist.md#owner-runbook-rotating-resend_api_key).

## What is still open

A Resend webhook receiver for bounces and complaints, a `CRON_SECRET` HTTP twin of the retry worker on the Netlify ticker, and an inbound support mailbox for `familiarisenow.com` are deliberately outside this fix and remain open follow-ups.
