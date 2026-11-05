---
type: explanation
audience: intern
status: live
last-reviewed: 2026-11-05
---

# The environment split: what differs between local, previews, the branch deploy and production

This page explains which vendor keys, flags and data each environment uses today, why some of them are deliberately shared, and what that means for the accounts you sign in with. Read it before you test anything on a deploy preview or on `dev.familiarisenow.com`, and before you change an environment variable in Netlify.

The short version is this. There are four places the app runs, but there is only **one database**. Every environment reads and writes production's rows, so a preview is not a sandbox: it is new code pointed at live data. Most of the rules below follow from that one fact.

## 1. The four environments

| Environment    | Where it runs                                              | How the code knows where it is                                                                          |
| -------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Local          | `next dev` on your machine, with your `.env`               | `NEXT_PUBLIC_SENTRY_ENVIRONMENT` from your `.env` (`development`, or unset), and `NODE_ENV=development` |
| Deploy preview | One Netlify URL per pull request (`deploy-preview-<n>--…`) | `NEXT_PUBLIC_SENTRY_ENVIRONMENT=preview`, set in the Netlify deploy-preview context                     |
| Branch deploy  | `dev.familiarisenow.com`, built from the `dev` branch      | `NEXT_PUBLIC_SENTRY_ENVIRONMENT=preview`, set in the Netlify branch-deploy context                      |
| Production     | `familiarisenow.com`                                       | `NEXT_PUBLIC_SENTRY_ENVIRONMENT=production`, set in the Netlify production context                      |

Netlify also exposes a `CONTEXT` variable, but only while the site builds, so runtime code cannot read it. Instead, the code reads `NEXT_PUBLIC_SENTRY_ENVIRONMENT`, which Next.js inlines into the bundle at build time. That one variable is the production marker for the 2FA exemption (`deployEnvironment()` in `lib/auth/qa-accounts.ts`), for the Turnstile hostname check and test-key guard (`lib/auth/captcha.ts`), and for whether a deploy may run background jobs (`jobsMayRunHere()` in `lib/cron/dispatch-refusal.ts`). Every Netlify deploy runs with `NODE_ENV=production`, so `NODE_ENV` cannot tell a preview from production.

## 2. The vendor and environment matrix (as of 2026-11-05)

The table shows the current state, read from the Netlify environment variables and the code on 2026-11-05. "Shared" means the same value or the same tenant as production.

| Concern                 | Local                                                                                                | Deploy preview                                                    | Branch deploy (`dev.familiarisenow.com`)                               | Production                                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Database (Postgres)     | **Shared** with production                                                                           | **Shared**                                                        | **Shared**                                                             | The one Supabase project                                                                                         |
| Upstash Redis           | Shared                                                                                               | Shared                                                            | Shared                                                                 | The one Redis database                                                                                           |
| Operator 2FA            | Enforced for real operators; the four exempt QA operators skip it when the `.env` says `development` | Enforced for real operators; exempt QA operators skip it          | Enforced for real operators; exempt QA operators skip it               | Enforced for every operator, QA accounts included                                                                |
| Turnstile captcha       | Cloudflare's always-pass test keys from `.env.sample`                                                | Cloudflare's always-pass test site key `1x00000000000000000000AA` | Always-pass test keys (set 2026-11-06, live from the next `dev` build) | Real keys, with the hostname check on `familiarisenow.com`; a test key here makes the protected endpoints refuse |
| Stream (chat and video) | Whatever your `.env` holds                                                                           | **The production Stream app** (key `k4n5crxtstrx`)                | **The production Stream app**                                          | The production Stream app                                                                                        |
| Razorpay                | Test keys, or unset                                                                                  | Test keys (`rzp_test_`)                                           | Test keys (`rzp_test_`)                                                | **Test keys (`rzp_test_`) before launch**, allowed by `RAZORPAY_ALLOW_TEST_KEYS_IN_PRODUCTION=true`              |
| Email delivery          | `EMAIL_DELIVERY_MODE=allowlist` in `.env.sample`                                                     | Unset, which means allowlist                                      | Unset, which means allowlist                                           | Unset, which means allowlist until launch                                                                        |
| Sentry environment      | `development` (or unset)                                                                             | `preview`                                                         | `preview`                                                              | `production`                                                                                                     |
| Background jobs         | Run under `next dev`                                                                                 | Refused (409 `JOB_RUN_PRODUCTION_ONLY`)                           | Refused                                                                | Run on the ticker                                                                                                |

Some notes on the rows that surprise people:

- **Stream is shared today, and that is a known gap.** Every Netlify context uses the production Stream key, so a chat message or a call started on a preview lands in the production Stream app. The fix is an open pull request titled "refuse the production Stream key outside production", which moves deploy previews and the branch deploy to a separate Familiarise-dev Stream app **(planned)**.
- **Razorpay is on test keys everywhere, production included.** Before launch the production site takes test cards only. The Razorpay client refuses a test key on production at boot unless `RAZORPAY_ALLOW_TEST_KEYS_IN_PRODUCTION=true`, and that variable must be deleted when the live keys go in (`lib/payments/core/razorpay.ts`).
- **Email is held for everyone outside the allowlist.** With `EMAIL_DELIVERY_MODE` unset, `lib/email/delivery-guard.ts` lets mail through only to `familiarisenow.com` addresses and the addresses in `EMAIL_ALLOWLIST`; anything else is stored as a dead letter with `held:pre-launch`. Production switches to `live` at launch ([email architecture](../email/README.md)).
- **The branch deploy now has a captcha.** Until 2026-11-06 both Turnstile keys were unset there, so `turnstileCaptcha()` installed nothing and sign-up and password reset on `dev.familiarisenow.com` ran without a captcha, logging one `AUTH_CAPTCHA_DISABLED` line per cold start. The branch-deploy context now carries Cloudflare's always-pass test keys, which take effect from the next `dev` build.

## 3. Why real operators keep 2FA on previews

Operators are the `STAFF` and `ADMIN` accounts that use the back office. It is tempting to switch their second factor off on previews so testing is faster, but that would be a production security hole, and here is why.

A deploy preview is a public URL that runs new code against the production database. If a real admin's password leaked and previews skipped 2FA, anyone could open any preview, sign in with that password alone, and read every customer's contact details, issue refunds or ban accounts, in production, because the preview's back office reads and writes production's rows. The preview is a second front door to the same house. So the rule is that a real operator is challenged for a code on every deployment, and only a short list of designated QA accounts on a reserved domain skips it off production.

This matches standard practice. OWASP's Secrets Management Cheat Sheet recommends "separating the production and development secrets" and says a secret "should then be different per DTAP environment", so that "a secret does not leak cross-environment" ([OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html), read 2026-11-05). We cannot give previews their own credentials while they share production's user table, so the safe reading is the other way around: an identity that can sign in on a preview is a production identity and is protected like one.

The exemption is enforced by `isQaOperatorExemptFrom2fa()` in `lib/auth/qa-accounts.ts`. It is true only when all three of these hold: the user is `STAFF` or `ADMIN`; the email is one of the exact addresses in the list and is on `qa.familiarise.invalid`; and `NEXT_PUBLIC_SENTRY_ENVIRONMENT` is `preview` or `development`. A missing or unexpected value enforces 2FA, so a misconfigured host fails closed. The full policy is in [staff onboarding §9](../authentication/staff-onboarding.md#9-two-factor-policy-seeds-and-qa-operators).

## 4. Which QA account to use for what

Every seeded operator is on `qa.familiarise.invalid`. `.invalid` is reserved by RFC 2606 and never resolves, so no password reset, setup link or lockout email can ever reach these accounts. They all sign in with `SEED_OPERATOR_PASSWORD`, which the lead holds; never paste it into a doc, prompt or pull request.

| Account                                                | Second factor                              | Use it for                                                                                              |
| ------------------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `qa-admin-2`, `qa-staff-1`, `qa-staff-3`, `qa-staff-4` | None off production (exempt, not enrolled) | Everyday back-office QA on local, deploy previews and the branch deploy, with the password alone.       |
| `qa-admin-1`, `qa-admin-3`, `qa-staff-2`               | TOTP, enrolled by the seed                 | Testing the 2FA flows themselves (challenge, backup codes, step-up), and any operator QA on production. |

For a TOTP account, get the current six-digit code from a terminal:

```bash
npm run qa:totp -- qa-admin-1@qa.familiarise.invalid
# 482913  (17s left)
```

`scripts/auth/qa-totp.ts` refuses any other address. It computes the code from `BETTER_AUTH_SECRET`, so it needs the same secret as the deployment you are signing in to; with a different local secret it prints a code the site rejects. Every Netlify context (production, deploy previews and the `dev` branch deploy) shares one `BETTER_AUTH_SECRET`, and the main checkout's `.env` holds the same value, so run the command where that `.env` is loaded. Do not pipe the value out of `netlify env:get` inside a git worktree: a worktree is not linked to the Netlify site, so the CLI prints a sentence instead of the secret, and the code comes out wrong. `requireAuthSecret()` now refuses any secret containing whitespace for that reason.

Because one database serves every environment, re-running the seed or the repair with any other secret re-encrypts these three rows with the wrong key, and TOTP sign-in then fails on every deployment with a 500 (`invalid tag` in the function log). If the code is fresh and still rejected, the stored row has drifted from the seed derivation, which section 5 explains.

A worked example. Asha, an intern, needs to check that a staff member can see the support inbox on the preview for her pull request. She signs in as `qa-staff-1@qa.familiarise.invalid` with the operator password, and lands straight in the back office because the preview's Sentry environment is `preview`. Next she needs to check the "Reset 2FA" flow, so she signs out and signs in as `qa-admin-1@qa.familiarise.invalid`. This time the sign-in answers with a TOTP challenge. She runs `npm run qa:totp -- qa-admin-1@qa.familiarise.invalid`, sees `482913 (17s left)`, and types it in. If the timer had shown two seconds, she would wait for the next code rather than race it.

## 5. How the seed derives the TOTP secret

The seed never stores a published or constant secret. For each TOTP operator, `deriveSeedOperatorTotpSecret()` in `prisma/seedFiles/seed-two-factor.ts` computes an HMAC-SHA256 of `seed-operator-2fa:totp:<lower-cased email>` keyed with `BETTER_AUTH_SECRET`, and `buildSeedOperatorTwoFactorRow()` encrypts that secret and ten derived backup codes the same way Better Auth does. Only someone who already holds the deployment's auth secret can compute a code, so knowing the operator password and reading this page is still not enough to sign in.

The seed (`prisma/seedFiles/1a-create-users.ts`) writes that row with the update `seedOperatorEnrolmentUpdate()` builds for every TOTP operator, whether it created the user in this run or the user already existed. The write is one upsert keyed on the user, so it replaces a secret that someone minted by enrolling by hand, sets `twoFactorEnabled`, and clears the failed-attempt counter and the lock.

The live rows drifted once: three accounts had been enrolled by hand through the setup page, which stores Better Auth's own random secret (144 hex characters stored, against 208 for the seed's), and the seed used to skip existing users. `scripts/auth/repair-qa-operator-2fa.ts` puts them back. It is a dry run unless you pass `--apply`, and it refuses any address other than a `qa-admin-N` or `qa-staff-N` account on the QA domain outside the exemption list, so it cannot touch a real operator. Only the owner runs it with `--apply`, because the database is production's.

## 6. Owner steps

1. **Repair the three TOTP operators.** Done on 2026-11-06. The first `--apply` run took its secret from `netlify env:get` inside a worktree, which printed a message instead of the secret, so the rows were sealed under that text; preview QA caught it as a 500 on the TOTP step. The second run used the main checkout's `.env`, whose secret equals the Netlify one, and every row now decrypts to the seed derivation with its failure counter at zero. To repeat it, run `npx tsx -r dotenv/config scripts/auth/repair-qa-operator-2fa.ts` with the main `.env` loaded (`DOTENV_CONFIG_PATH` from a worktree), then again with `--apply`.
2. **Give the branch deploy a captcha.** Set Cloudflare's always-pass test keys in the Netlify branch-deploy context: `NEXT_PUBLIC_TURNSTILE_SITE_KEY=1x00000000000000000000AA` and `TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA`. The site key is inlined at build, so redeploy `dev` afterwards. Done on 2026-11-06; the `dev` branch deploy picks the keys up on its next build.
3. **Never put a test key on production.** If one gets there, `turnstileCaptcha()` keeps the captcha plugin but verifies every token with Cloudflare's always-fail test secret, so sign-up, password-reset requests and code resends answer 403 until the real keys are back. Each cold start logs one `AUTH_CAPTCHA_TEST_KEYS_IN_PRODUCTION` line naming the variable. Refusing was chosen over skipping the captcha, which would let every bot through, and over throwing at boot, which would take down sign-in for everyone ([decision record](../decisions/2026-11-05-environment-split-auth.md)).

## 7. What the database split unblocks

The plan to give previews, the branch deploy and local checkouts their own Supabase project is written up in [the database split plan](../deployment/db-split-plan.md). It is **planned**, gated on the Supabase Pro upgrade and real customers. Once it lands:

- A preview's back office would read only synthetic data, so a leaked preview credential would no longer reach customers. Relaxing operator 2FA on previews could then be reconsidered as a product choice, not ruled out as a security hole.
- Previews could run background jobs against their own data, instead of refusing every job.
- The seed and the repair script would run against a dev database, so nobody would have to write to production to reset a QA account.
- The load test, which would otherwise load production's connection pool, could run.

The split moves only the database. Stream, Redis and the vendor keys each need their own change; the Stream one is the planned pull request in section 2.

## 8. Glossary

- **Deploy preview**: the Netlify build for one pull request, on its own URL.
- **Branch deploy**: the Netlify build of the `dev` branch, served at `dev.familiarisenow.com`.
- **Operator**: a `STAFF` or `ADMIN` account that can use the back office.
- **TOTP**: a time-based one-time password, the six-digit code an authenticator app shows and replaces every 30 seconds.
- **Exempt QA operator**: one of the four seeded operators allowed to sign in without TOTP off production.
- **Fail closed**: when a setting is missing or wrong, the system refuses rather than allows.

Related issues: #2530 (seeded TOTP operators), #2376 (the Stream key split).

## Deprecated & Superseded Approaches

- **Enrolling QA operators by hand through the setup page.** It stored a random secret nobody could reproduce, and the seed skipped existing users, so the documented code generator stopped matching. The seed now upserts every TOTP operator, and `npm run qa:totp` reads the code.
- **Leaving the Turnstile keys unchecked on production.** A copied test key would have passed every bot or silently blocked sign-up. Production now refuses verification with a test key and logs which variable holds it.
