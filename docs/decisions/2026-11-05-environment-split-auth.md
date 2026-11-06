# ADR: Environment split for auth: seeded TOTP operators, Turnstile test keys on production, and the signed-out profile

- **Status**: Accepted on 2026-11-05. Built in the pull request that adds this record. The owner steps at the bottom are not done yet.
- **Date**: 2026-11-05
- **Author**: Platform engineering
- **Related**: [Environment split explainer](../start-here/10-environment-split.md), [Staff onboarding §9](../authentication/staff-onboarding.md#9-two-factor-policy-seeds-and-qa-operators), [Rate limiting and abuse](../authentication/rate-limiting-and-abuse.md), [Database split plan](../deployment/db-split-plan.md), issue [#2530](https://github.com/Practitionist/familiarise_web/issues/2530)

## Context

One Postgres database serves production, every deploy preview, the branch deploy (`dev.familiarisenow.com`) and every local checkout. Three problems surfaced on the environment boundary.

- **Seeded TOTP operators could not sign in.** The live `twoFactor.secret` rows for `qa-admin-1`, `qa-admin-3` and `qa-staff-2` were 144 hex characters long. That is the length of Better Auth's own `/two-factor/enable` output: a 32-character random secret encrypted with XChaCha20-Poly1305 and hex-encoded, which is 2 × (24 nonce + 32 plaintext + 16 tag) bytes. The seed encrypts a 64-character HMAC secret, which comes out at 208 hex characters. The seed only created `TwoFactor` rows for users it had just created, so after those three accounts had been enrolled by hand, no later seed run rewrote them, and the documented seed derivation produced codes for a secret that was never stored.
- **Nothing refused Cloudflare's test keys on production.** The deploy-preview context carries the always-pass test site key `1x00000000000000000000AA`. If a test key were ever copied into the production context, the captcha would either pass every bot (an always-pass secret) or quietly break sign-up for everyone (a test site key against the real secret), and nothing would say why.
- **The signed-out expert profile probed an authenticated API.** `ProfileReviewComposer` asked `/api/user/reviews/reviewable-sessions` on every visit, so every signed-out visitor to an expert profile logged a 401 in the browser console. The page is statically cached (ISR), so it cannot read a session on the server.

## Decision

| #   | Decision                             | Choice                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Real operators on previews           | Keep 2FA for every real operator on every deployment. Relaxing it off production would let one leaked operator password reach the production back office through any public preview URL, because previews read and write production's rows.                                                                                                                                                                                   |
| D2  | Seeded TOTP operators                | The seed upserts the seed-derived `TwoFactor` row for every seeded operator outside the exemption list, whether the user was just created or already existed, sets `twoFactorEnabled`, and clears `failedVerificationCount` and `lockedUntil` (`seedOperatorEnrolmentUpdate` in `prisma/seedFiles/seed-two-factor.ts`).                                                                                                       |
| D3  | Repairing the live rows              | An owner-run script, `scripts/auth/repair-qa-operator-2fa.ts`, rewrites those rows on the shared database. It is a dry run unless `--apply` is passed, and it refuses any address that is not `qa-(admin\|staff)-N@qa.familiarise.invalid` outside the exemption list, so it can never touch a real operator or an exempt QA account. No agent runs it with `--apply`.                                                        |
| D4  | Reading a QA code                    | `npm run qa:totp -- <email>` prints the current code and the seconds left, from `BETTER_AUTH_SECRET`. It refuses every other address. The secret is derived from `BETTER_AUTH_SECRET` with HMAC, so only someone who already holds the deployment's auth secret can compute a code; no constant secret is published.                                                                                                          |
| D5  | Turnstile test keys on production    | When `NEXT_PUBLIC_SENTRY_ENVIRONMENT` is `production` and either Turnstile key is one of Cloudflare's published test keys, `turnstileCaptcha()` still registers the captcha plugin on the same endpoints, but verifies with Cloudflare's always-fail test secret. Sign-up, password-reset requests and code resends answer 403 `VERIFICATION_FAILED` until the real keys are set; sign-in and every other route keep working. |
| D6  | How the misconfiguration is reported | One `console.error` line and one `AUTH_CAPTCHA_TEST_KEYS_IN_PRODUCTION` Sentry Logs warning (`Sentry.logger.warn`) per cold start, naming which variable holds the test key. Nothing is reported during `next build`, and nothing is captured per request.                                                                                                                                                                    |
| D7  | Local development                    | `.env.sample` ships Cloudflare's always-pass test keys, which are public, so a fresh checkout has a working captcha without an account.                                                                                                                                                                                                                                                                                       |
| D8  | The signed-out profile               | `ProfileReviewComposer` asks only once `useSession()` reports a signed-in user. The page stays ISR. The 401 fallback stays for an expired cookie, and the response is parsed with a Zod schema instead of a cast.                                                                                                                                                                                                             |

### Why D5 verifies with the always-fail secret

There were three ways to "fail closed", and two of them are wrong.

1. **Skip the captcha plugin.** This is what the code already does when a key is unset, and for a test key it would be fail-open: the endpoints would accept requests with no token at all, so bots could sign up and trigger reset mail freely.
2. **Throw while `lib/auth.ts` loads.** The Razorpay client throws on a test key in production because it guards one subsystem. `lib/auth.ts` serves every route, so a throw there would take down sign-in, every session read and the whole back office over a captcha setting. The house pattern in `lib/payments/core/razorpay-key-mode.ts` and `lib/payments/core/razorpay.ts` is narrower than "throw": classify the key in a leaf module, keep the process booting, and let only the affected operation refuse. That is what D5 does.
3. **Keep the plugin and make its verification fail.** The plugin keeps requiring a token on exactly the three mail-sending endpoints, using Better Auth's own path matching, so there is no second matcher that could drift and let a path through. Verification goes to Cloudflare with the test secret `2x0000000000000000000000000000000AA`, which Cloudflare documents as "Validation fails". If Cloudflare is unreachable, the plugin answers 500, which is also a refusal. Every outcome is a refusal.

Cloudflare's published test keys, read on 2026-11-05 from [Turnstile testing](https://developers.cloudflare.com/turnstile/troubleshooting/testing/), are the five site keys `1x00000000000000000000AA` (passes), `2x00000000000000000000AB` (fails), `1x00000000000000000000BB` (invisible, passes), `2x00000000000000000000BB` (invisible, fails) and `3x00000000000000000000FF` (forces an interactive challenge), and the three secret keys `1x0000000000000000000000000000000AA` (validation succeeds), `2x0000000000000000000000000000000AA` (validation fails) and `3x0000000000000000000000000000000AA` (token already spent). The same page says that production secret keys reject the dummy token that test site keys mint.

## Consequences

- A production deploy with a test key cannot pass bots and cannot fail silently. The cost is that sign-up and password reset stop on production until the keys are fixed, which the log line names.
- Re-running the seed against the shared database now rewrites the three TOTP operators' rows. Anyone who enrolled one of them by hand loses that authenticator entry and uses `npm run qa:totp` instead.
- The QA codes depend on `BETTER_AUTH_SECRET`. A local `.env` with a different secret prints codes that the deployment rejects.

## Owner steps

1. Run `npx tsx -r dotenv/config scripts/auth/repair-qa-operator-2fa.ts` with the production `BETTER_AUTH_SECRET` and `DATABASE_URL`, read the dry-run list (it should name `qa-admin-1`, `qa-admin-3` and `qa-staff-2` only), then run it again with `--apply`.
2. Put Cloudflare's always-pass test keys on the Netlify branch-deploy context (`NEXT_PUBLIC_TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`) and redeploy it, because the site key is inlined at build.

## Deprecated & Superseded Approaches

- **Creating `TwoFactor` rows for freshly created operators only.** It left any hand-enrolled QA operator on a secret the seed could not reproduce. The seed now upserts every TOTP operator.
- **The 401 as the signed-out answer on the expert profile.** It was handled correctly but still cost one request per visit and a console error. The query is now gated on the client session.
