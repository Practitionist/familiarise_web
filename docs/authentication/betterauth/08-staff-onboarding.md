# Staff onboarding and sign-in

| Field | Value |
|---|---|
| Status | Implemented |
| Audience | All engineers |
| Last reviewed | 2026-10-01 |
| Source files | `lib/auth/operators.ts`, `app/api/admin/team/members/`, `scripts/bootstrap-admin.ts`, `lib/auth/operator-session-policy.ts`, `lib/auth.ts`, `lib/auth-helpers.ts`, `lib/auth-guard.ts`, `lib/compliance/operator-consent.ts` |

## 1. Adding an operator

An operator is a `STAFF` or `ADMIN` user. There is one way to create one:
`createOperator()` in `lib/auth/operators.ts`.

1. An ADMIN opens the Team page and uses **Add staff** (email, name, role, and
   an audit reason). This calls `POST /api/admin/team/members`, gated on
   `users.moderate` and written to `OpsActionLog`. An existing email answers
   409.
2. The route calls `auth.api.createUser` server-side with no headers, so the
   admin plugin's HTTP surface stays closed (§4). The account gets a random
   32-byte password nobody knows, plus `emailVerified` and
   `onboardingCompleted`. A Staff/AdminProfile row is created and linked.
3. The route sends BetterAuth's password-reset link. While the operator has
   no second factor, the email is worded as "Set your Familiarise staff
   password". The link is single-use and expires in 30 minutes. A lapsed link
   is re-requested from **Forgot password**.
4. The operator sets a password, signs in, and is sent to
   `/auth/two-factor/setup` (§2).
5. On first entry to the back office, they give their own DPDP consent (§3).

The **first** admin comes from `scripts/bootstrap-admin.ts --email … --name …`,
which uses the same path and refuses once any ADMIN exists. `--print-link`
prints the set-password link instead of emailing it, for local development only.

Email domain is never an authorisation key: staff use a mix of personal and
company addresses, so there is no domain allowlist and no domain SSO for
operators.

## 2. Sign-in and mandatory 2FA

Operators sign in with **email + password + TOTP**, and nothing else.

- **Session creation.** `databaseHooks.session.create.before` refuses an
  operator session unless the endpoint is `/sign-in/email`,
  `/two-factor/verify-totp`, `/two-factor/verify-backup-code` or
  `/change-password` (`refusesOperatorSession`). Google, GitHub, SSO,
  magic-link, email-verification and sign-up sessions are refused with
  `STAFF_PASSWORD_SIGN_IN_ONLY`, because the twoFactor plugin never
  challenges those callbacks.
- **Challenge.** Once enrolled, `/sign-in/email` answers `twoFactorRedirect`;
  the sign-in page sends the operator to `/auth/two-factor`, which verifies a
  TOTP code or a backup code. Trusted devices are refused.
- **Before enrolment.** The password-only session is real but confined:
  `requireApiAuth` answers 428 `TWO_FACTOR_REQUIRED` with
  `X-Auth-Action: enroll-2fa`, and `requireOperator()` redirects every
  back-office page to `/auth/two-factor/setup`. The setup page is the only
  page-level exemption, and it is keyed on the page, not on a request header.
  Middleware strips any client-supplied `x-pathname`.
- **Enrolment.** QR code and manual secret, verify a code first, then the
  backup codes are shown once.
- **No self-service removal.** `/two-factor/disable` is refused for operators.
  An ADMIN resets a lost authenticator with **Reset 2FA**
  (`DELETE /api/admin/team/members/{id}/two-factor`): the TwoFactor row is
  deleted, `twoFactorEnabled` cleared, every session revoked, and the reason
  logged. Confirm who you are talking to first: whoever signs in next with the
  password enrols the new authenticator.

## 3. Consent

Nobody consents on an operator's behalf. `user.create.after` skips the signup
consent rows and the consumer welcome email for `/admin/create-user`. The
back-office layout shows `OperatorConsentGate` until the operator has any
`PRIMARY_PROCESSING` artifact, granted or withdrawn. It posts to
`POST /api/user/consent`, which writes the signup purposes for the session's
own user, once.

## 4. What is switched off

- **Admin plugin endpoints.** All 15 `/admin/*` endpoints are in
  `disabledPaths`, so none is reachable over HTTP. `auth.api.*` server calls
  still work. `__tests__/security/admin-plugin-fenced.test.ts` reads the list
  from the installed plugin.
- **Impersonation.** Off. Support reads a customer's data through the back
  office. `Session.impersonatedBy` remains for display only.

## 5. Open items

| # | Item |
|---|---|
| 1 | Operator sessions share the 30-day consumer lifetime. |
| 2 | A social account can still auto-link to an operator's email; the resulting session is refused, not the link. |
