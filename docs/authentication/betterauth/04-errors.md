# Errors

| Field | Value |
|---|---|
| Status | Stable |
| Audience | All engineers |
| Last reviewed | 2026-09-29 |
| Source files | `lib/labels/auth-error-codes.ts`, `lib/labels/auth-errors.catalog.ts`, `lib/labels/auth-errors.ts`, `lib/auth/attempts.ts`, `lib/auth/sign-in-attempt-hooks.ts` |

## 1. Background

An authentication failure has always had a sentence. What it did not have was a
**closed set of reasons**, so every code Better Auth has ever added, plus every
code we minted, funnelled through a `Record<string, AuthErrorCopy>` into a
generic toast: *"Something went wrong on our side."* That sentence is
unactionable for the person reading it, undiagnosable for the person supporting
them, and indistinguishable in a log from a genuine fault.

This document is the contract that replaced it. There are three files and they
are ordered by how much they constrain you:

| File | Constraint |
|---|---|
| [`lib/labels/auth-error-codes.ts`](../../../lib/labels/auth-error-codes.ts) | The set of codes is **closed**. A new one does not compile. |
| [`lib/labels/auth-errors.catalog.ts`](../../../lib/labels/auth-errors.catalog.ts) | Every code has copy. `Record<AuthErrorCode, AuthErrorCopy>`, not `Record<string, …>`. |
| [`lib/labels/auth-errors.ts`](../../../lib/labels/auth-errors.ts) | One function turns any failure into a sentence, in a documented order. |

The net effect is that a Better Auth minor release which introduces a new error
code fails the build in CI. That is the whole productionisation story: the
inversion from "silently degrade" to "refuse to compile".

## 2. Scope

| In scope | Out of scope |
|---|---|
| `AuthErrorCode` and where each code is minted | The refusal rail for business outcomes — see [`docs/errors/01-refusals.md`](../../errors/01-refusals.md) |
| The catalog, the flow overrides, the action union | Org-dashboard refusals — `lib/labels/org-errors.ts` |
| `humanizeAuthError`'s resolution order | Which limiter produced the 429 — see [`04-rate-limiting.md`](./04-rate-limiting.md) |
| The per-account lockout and graded disclosure | The cross-service failure matrix — see [`09-failure-modes.md`](./09-failure-modes.md) |
| i18n seam | |

## 3. Where to start

| # | Section | Reading time |
|---|---|---|
| 1 | [The closed union](#4-the-closed-union) | 4 min |
| 2 | [Resolution order](#5-the-resolution-order-in-one-place) | 4 min |
| 3 | [Tiered disclosure](#7-tiered-disclosure-and-its-threat-model) | 8 min |
| 4 | [Where a 401 is not a wrong password](#8-why-a-401-from-the-auth-api-is-a-deployment-problem) | 4 min |

## 4. The closed union

`AuthErrorCode` is `BetterAuthErrorCode | AppAuthErrorCode`, and the two halves
are kept deliberately apart.

**`BetterAuthErrorCode`** is not hand-invented. Every member is a literal that
appears in the installed package, read off `@better-auth/core`'s
`BASE_ERROR_CODES` plus the `admin`, `organization`, `two-factor` and `captcha`
plugin tables. A typo here cannot become an unreachable branch, because the type
would not match what the plugin actually throws.

It is also **narrowed**, not copied. The `admin` plugin's table is 40-odd codes
and only two are here. The `YOU_ARE_NOT_ALLOWED_*` family is back-office
authorisation, which the back-office refusal rail answers with its own copy, and
rendering it on a public sign-in page would leak which administrative actions
exist. The `organization` plugin keeps three of its codes, and only the ones the
invite-accept path surfaces.

**`AppAuthErrorCode`** is ours, and each member names the single file allowed to
mint it — the SSO veto in `lib/auth.ts`'s `session.create.before`, the edge rate
limiter, the session-lookup tri-state, the account lockout, the B2C entitlement
layer, staff onboarding. A new refusal has to be *declared* in the same commit
that introduces it, which is what makes the list reviewable.

### Why closed

`AUTH_ERROR_COPY` is declared `as const satisfies Record<AuthErrorCode,
AuthErrorCopy>`. Add a member to either half of the union and that `Record` has
a missing key, so `tsc` fails. There is no default arm, no index signature, and
no runtime path that renders a code we have not written a sentence for.

`AUTH_ERROR_CODES` — the runtime set used by `isAuthErrorCode` and
`normalizeAuthErrorCode` — is derived from the *same* `const` the types are
written against, via its own `satisfies Record<AuthErrorCode, AuthErrorCode>`.
That is the belt to the types' braces: the classic way a `Record<string, …>`
runtime guard quietly rots is for the type union and the runtime set to be
edited separately, and one `tsc` check makes that impossible.

The runtime helpers exist because **Better Auth is not the only thing that puts
a `code` on the wire.** The edge limiter answers `{ error, code, scope,
retryAfterSeconds }`, our own routes answer `{ error, code }`, and a
hand-written `Refusal` is not obliged to match Better Auth's casing.
`normalizeAuthErrorCode` trims and upper-cases for that reason.

### What the catalog entry carries

```ts
export interface AuthErrorCopy {
  title: string;
  description: string;
  field?: "email" | "password" | "newPassword" | "referral" | "code";
  needsVerification?: boolean;
  action?: AuthErrorAction;
  unlocked?: { title: string; description: string };
}
```

`action` is a closed ten-member union — `forgot-password`,
`resend-verification`, `request-new-link`, `switch-to-sso`, `sign-in`,
`sign-up`, `retry`, `contact-support`, `enroll-2fa`, `upgrade-plan`. Every
member maps to a component that already exists or is trivial to add, so a page
can never be handed an affordance it does not know how to render. Adding a
member is a deliberate act with a UI consequence, not a string.

`unlocked` is the strong sentence, and its **absence on almost every code is
the guarantee that the code cannot disclose**. Only three codes carry one. See
§7.

### i18n

`description` is a plain string, not JSX, precisely so a message catalogue can
extract it. `support@familiarisenow.com` is interpolated from a `SUPPORT`
constant rather than typed in, so a support-address change is one edit. Every
customer-facing auth string in the product originates in this one file, which
makes wrapping the module in `next-intl` a change to *this file* and the pages
that call it, rather than a hunt through two hundred components.

## 5. The resolution order in one place

`humanizeAuthError(flow, error, options?)` is the only path from a failure to a
sentence. The order is load-bearing; each step is documented at its call site
in [`auth-errors.ts`](../../../lib/labels/auth-errors.ts).

| # | Step | What it decides |
|---|---|---|
| 0 | `if (!error)` | `GENERIC[flow]`. A caller that failed to capture the error still gets a sentence. |
| 1 | **Code** | `normalizeAuthErrorCode(error.code)`, then `AUTH_ERROR_COPY`. Matched case-insensitively and trimmed. |
| 2 | **Flow override** | `AUTH_ERROR_COPY_BY_FLOW[flow][code]` — an *amendment* merged over the base. |
| 3 | **Status** | Code-less failures: 429 → timed; 401/403 → `REQUEST_REJECTED`; 0/5xx → `UNREACHABLE`; 410 and 409 get their own sentences; anything else → `GENERIC[flow]`. |
| 4 | **Lockout rewrite** | `ACCOUNT_TEMPORARILY_LOCKED` gains a real duration, whichever branch produced the base. |
| 5 | **Disclosure** | Sign-in **only**, and only when `options.disclosure.unlocked` is true. |
| 6 | `GENERIC[flow]` | True last resort. |

Two details worth knowing before you touch it.

A flow override is a **merge**, not a replacement: `return { ...base, ...perFlow }`.
That is why the override table only has to state what differs. It also means an
override with no base is a bug, and `copyForCode` throws on it rather than
rendering `{ title: undefined }` into a toast.

The one place a server message is read is `fieldFromValidationMessage`, and it
reads only a **path token** out of a zod message — `[body.email]` →
`field: "email"`. Never the value, which is user input and may itself be
sensitive. This is needed because Better Auth validates the body with zod
*before* its own codes apply, so a blank field arrives as `VALIDATION_ERROR`
with generic copy, and the field name is the entire message.

> [!IMPORTANT]
> The raw `error.message` is **never** returned. Not for a known code, not for
> an unknown one, not in a fallback. Better Auth's messages are
> developer-facing ("Invalid email or password"); `lib/sso/signin-with-toast.ts`
> used to render one verbatim, and a SAML parse failure reached a customer as
> `TypeError: Cannot read properties of undefined (reading 'metadata')`.

## 6. Per-flow overrides

`AUTH_ERROR_COPY_BY_FLOW` has three keys today: `reset`, `verify`, `forgot`.
Only the first two carry entries.

`INVALID_TOKEN` and `TOKEN_EXPIRED` are the codes that need it. A password-reset
link and a verification link are the same two codes, and telling a customer
their verification link "lasts 30 minutes" when it lasts an hour is worse than
the generic sentence. The reset flow says 30 minutes and offers a new link; the
verify flow says 1 hour and offers a resend.

`forgot` is **deliberately empty**, and the emptiness is the security property.
The `requestPasswordReset` response is uniform for a known and an unknown
address, so nothing on that page may vary on whether the address exists. An
override there would reintroduce the enumeration oracle through a different
door.

Adding a flow override is a two-line change and a review question: *does this
sentence reveal anything the collapsed base was hiding?* For `forgot` the answer
is always yes.

## 7. Tiered disclosure, and its threat model

`INVALID_EMAIL_OR_PASSWORD` means three different things — wrong password, no
such account, and this account has no password — and Better Auth will not tell
the client which. Flattening it into "no such user" would be the largest single
security regression available in this subsystem. It turns the sign-in form into
an **enumeration oracle**: type any address, get told whether a paying customer
has one. The reply-all address book, a competitor, and a scraper each become one
form submission.

So disclosure is **graded**, and the grade is the whole design.

| Failures recorded for this address | What the page may say |
|---|---|
| 1–2 | The collapsed sentence: *"That email and password don't match."* |
| 3+ | The specific one: *"No account matches that email"*, *"This account is no password yet"*, *"Your directory account is no longer active"*, *"Your organisation's sign-in"*, *"This account is suspended"*. |

Two constants govern it, both in [`lib/auth/attempts.ts`](../../../lib/auth/attempts.ts):
`DISCLOSURE_UNLOCK_AFTER = 3` and `LOCKOUT_THRESHOLD = 8`. Three is the smallest
number genuinely useful to a human (a mistyped address, a stale saved password, a
half-remembered one) and the largest that does not hand out a meaningful number
of free probes.

### The lockout is what makes disclosure affordable

This is the load-bearing claim, and it is worth stating without hedging: the
graded disclosure is not a *concession* made despite the lockout. It is made
**because of** it.

The per-account counter is keyed on the same address being probed. By attempt
three a probe is already inside a window that ends in a lock at attempt eight, so
enumerating N addresses costs N lockouts and yields nothing after the first three
probes per address. An attacker rotating IPs — the obvious defence against a
per-account counter — does not help, because they cannot rotate the address they
are probing.

Meanwhile a real user with a real account who mistypes three times gets the
*useful* sentence **and** the lockout. That combination is exactly what makes
them contact support instead of abandoning the account. A customer told "no such
account" and then locked out for fifteen minutes has been told the tool is
unusable. A customer told "that address is not verified yet, resend the link" and
then locked out has been told what to do.

> The lockout is not a tax on the feature. It is what makes the feature
> affordable.

### The disclosure is read-only and inert

It describes **an address the caller already typed**. It returns no ids, never
reveals whether an address is staff or enterprise, and says nothing about an
address the caller has not submitted. The `accountState` classifier
(`classifyAccountState`) runs three indexed reads — `User`, the `credential`
`Account` row, and the same `lookupEnforcedOrg` the session-creation veto uses —
and the `enforceSSO` probe is deliberately the *same helper*, so the two answers
cannot disagree about whether a domain is enforced.

`classifyAccountState` is split out of the request path so the caller can compute
it **only once disclosure is unlocked**. Computing it unconditionally is the bug
the split exists to prevent: the query cost is trivial, but a response body
carrying `banned: true` for an arbitrary address is a live oracle.

The classifier's order matters and is not alphabetical:

```
!user                    → "unknown"
user.banned              → "banned"        (before everything else)
!user.emailVerified      → "unverified"
ssoEnforced              → "sso_only"
!hasPassword             → "no_password"
otherwise                → "active"
```

A banned account is reported as banned whatever else is true, because telling a
suspended user to check their verification is both wrong and a dead end for
them.

### The client is never the authority

This is the rule the whole mechanism is built to make true, so it is worth
stating as a rule rather than a tendency:

> **Nothing in the browser decides whether an address exists.**

`humanizeAuthError` will render the `unlocked` sentence only when
`options.disclosure?.unlocked` is true, and the only thing that sets that flag is
`SignInDisclosurePayload` built on the server by
[`toDisclosurePayload`](../../../lib/auth/attempts.ts) and carried on a response
header. A caller that constructs the options object itself is not reading a
secret out of thin air — it is asserting a fact the server published, and the
page under audit (`app/auth/signin/page.tsx`) does exactly that and nothing more.

The `unlocked` copy sitting unread in the client bundle is **not** a disclosure.
The threat here is a determined caller with a script, not a curious user with
devtools; a script has to be *told* by the server which branch to render, and
that is the branch the server withholds until the attempt counter says the
caller has already paid three attempts for this address.

### The one asymmetry that looks like an oversight

A Redis failure **fails open for the lockout and closed for disclosure**:

```ts
catch (error) {
  captureThrottled("auth/attempts:readSignInAttempt", error, { …, expected: true });
  return NO_ATTEMPT_INFO;   // lockedUntil: null, disclosure.unlocked: false
}
```

Two directions, opposite on purpose. An unreachable counter must not lock every
paying customer out of their own account, and it must not hand an enumeration
oracle to whoever knocked Redis over. The IP-keyed edge limiter is still doing
its job in this state. §[the failure matrix](./09-failure-modes.md) records what
is still missing on that degraded path.

### Why the verdict rides on a header

A response header is unconditional. The tempting design — rewrite the 401 body to
say "no such account" — does not survive contact with Better Auth:
`isAPIError(result.response)` at `to-auth-endpoints.mjs:119` decides whether the
response is *thrown* or *returned*, so replacing the `APIError` with a plain
object turns a 401 into a **200**. The value can be attached to the error, but
then the plugin's serialiser decides whether it reaches the wire.

`runAfterHooks` merges `result.headers` into `context.responseHeaders` (`:203`)
regardless of the body's type, and the client already has an `onResponse` hook
reading `Retry-After` the same way
([`components/auth/useRetryAfterCapture.ts`](../../../components/auth/useRetryAfterCapture.ts)).
So the verdict arrives on the same channel as the honest wait time, and the
page's `humanizeAuthError(flow, err, { disclosure })` call is unchanged.

Three headers, namespaced so they cannot collide with anything Better Auth sets:
`x-auth-attempts`, `x-auth-disclosure`, `x-auth-account-state`.

The **after** hook only counts a real credential rejection — the allowlist is
`INVALID_EMAIL_OR_PASSWORD` and `INVALID_PASSWORD` and nothing else. Counting a
captcha rejection, a rate-limit refusal, a `REQUIRE_EMAIL_VERIFICATION` bounce
or a validation error as a "failed password" would hand an attacker who cannot
authenticate at all a denial of service against real customers. The attempt that
*trips* the lockout is itself refused: letting it succeed and only then
reporting a lockout would hand a credential staller one last authenticated
session for free.

## 8. Why a 401 from the auth API is a deployment problem

`copyForStatus` maps a code-less **401 or 403** to `REQUEST_REJECTED`, not to
`GENERIC[flow]`.

Those statuses out of `/api/auth/*` mean the request never reached a handler. A
`trustedOrigins` or CSRF rejection happens at the edge, before Better Auth's
router runs, so there is no account, no password and no code to speak of. The
failure is a *deployment* problem: the origin serving the page is not on the
list.

The previous behaviour fell through to `GENERIC[flow]`, which turned a
`trustedOrigins` misconfiguration on a Netlify deploy preview into *"Something
went wrong on our side"* — the single most confusing auth failure this app can
produce. The customer's password was correct. The customer's address was
correct. The platform was wrong, and the sentence said the platform was right and
something unspecified was broken. Support had nothing to grep for.

`REQUEST_REJECTED`'s copy names the deploy-preview case in the description,
because it is the case that actually happens: a preview deployment serves a
wildcard origin that `BETTER_AUTH_TRUSTED_ORIGINS` has to be told about, and the
operator who opens a preview is the operator who hits it. *"'Our security policy
stopped the request before it reached the sign-in service. If you're on a preview
deployment, use the main site's address instead."*

Two neighbouring rows are worth the same treatment and have it:
`CROSS_SITE_NAVIGATION_LOGIN_BLOCKED` and `INVALID_ORIGIN` /
`MISSING_OR_NULL_ORIGIN` are separate codes, so a client can tell "this looked
like a cross-site request" from "the address this page was opened from isn't
recognised" — the first is a threat, the second is usually a misconfiguration.

## 9. Retry-After, and why the copy is rewritten

A 429 is only useful if the customer knows when to come back. `formatRetryAfter`
renders "in 12 minutes", not "in 731 seconds" and not "in a moment".

Rounding is deliberately coarse and **up**. A customer told to come back in
"9 minutes" for a 9m30s lockout has been told to come back too early, and the
natural reaction is to hammer the button — which is precisely the behaviour a
lockout exists to interrupt.

```
< 60s     → "in 42 seconds"
< 60min   → "in 12 minutes"
< 48h     → "in 3 hours"
else      → "in 4 days"
```

The number arrives two ways and the page takes whichever it has. `authClient.*`
resolves failures as `{ data: null, error }`, and that `error` is
`@better-fetch/fetch`'s — the parsed body plus `status`, with **no reference to
the `Response`**. So headers are unreadable from it, full stop, and
`useRetryAfterCapture` registers `fetchOptions.onResponse` per call to read
`Retry-After` before the body is parsed. Our own limiter additionally repeats the
number in the body (`retryAfterSeconds`), so a caller that forgets the hook still
renders a real duration.

Both header spellings are read. Ours is `Retry-After`; Better Auth's own
rate-limit error uses `X-Retry-After`. Reading only one silently loses the wait
time on a BetterAuth-native 429. `HTTP-date` is parsed as well as `delay-seconds`
— three lines, because "try again in -1 seconds" is worse than no number at all.

`scope` rides on the 429 body for the same reason: a client can tell *"you are
being slow on sign-up"* from *"this IP is over the SSO-callback budget"* without
string-matching a sentence. The scope strings are wire format and are not safe to
rename once shipped.

## 10. What is deliberately absent

| Not here | Why |
|---|---|
| Raw `error.message` | Developer-facing text. See §5. |
| A `default` arm on the catalog | The absence of a default arm is the compile error. |
| An action outside the ten-member union | A page must never be handed a affordance it cannot render. |
| A flow override on `forgot` | Uniformity is the anti-enumeration property there. |
| `unlocked` on any code but three | Its absence is what guarantees the code cannot disclose. |
| Org-dashboard refusals | `lib/labels/org-errors.ts` owns those. A `YOU_ARE_NOT_ALLOWED_*` code rendered on a public sign-in page leaks which administrative actions exist. |
| Money refusals | The `Refusal` rail, [`docs/errors/01-refusals.md`](../../errors/01-refusals.md), with a `devMessage` that may name ids and a `userMessage` that may not. |

## 11. How to add a code

1. Add the member to `BetterAuthErrorCode` — only if the literal appears in the
   installed package — or to `AppAuthErrorCode`, in the block that names the file
   allowed to mint it.
2. Add the same literal to `AUTH_ERROR_CODES`. Two `satisfies` records fail if
   you forget either.
3. Add the copy to `AUTH_ERROR_COPY`. `tsc` will not let you skip this.
4. If the sentence must vary by page, add an entry to `AUTH_ERROR_COPY_BY_FLOW`
   and answer: does this reveal what the collapsed base hid?
5. If the code is throttling, give it a `description` that the `withRetryAfter`
   rewrite will overwrite with a real duration.
6. Add a case to `__tests__/auth/auth-errors.test.ts` and a row to
   `__tests__/auth/auth-error-catalog.test.ts`.

Steps 1 and 3 failing to compile is the designed outcome, not friction to work
around. If a code is genuinely not ours to copy — a Better Auth plugin we do not
install, a gateway error, a platform 504 — it belongs in `copyForStatus` as a
status, not in the catalog as a code.

## 12. Open items

| # | Item | Why it is not done |
|---|---|---|
| 1 | Nothing calls `markExpected` on the expected auth errors | `lib/observability/expected.ts` defines it and `sentry.shared.config.ts` honours it, but no auth call site stamps an error, so a guard firing by design still arrives looking like a fault (FAMILIARISE_WEB-10). See [`09-failure-modes.md`](./09-failure-modes.md#10-the-auth-layer-itself). |
| 2 | `SCIM_USER_NOT_ACTIVE` has copy but no minting site | The code and its sentence exist; the pre-session check that would refuse a deactivated directory identity before a session is created does not. The current behaviour is a *successful* login to an empty dashboard. |
| 3 | The `Retry-After` value is not surfaced in the sign-in UI | The number reaches `humanizeAuthError` correctly and becomes "Try again in 12 minutes."; a pool-exhaustion 503's `Retry-After` is the one case where a page-level countdown is still missing. |
| 4 | `TWO_FACTOR_REQUIRED` arrives as a bare 428 body, not through the catalog | The guard in `lib/auth-helpers.ts` writes `{ error, code: "TWO_FACTOR_REQUIRED" }` with `X-Auth-Action: enroll-2fa` itself, so the code resolves and the copy is right — but the sentence is hand-written rather than read from `AUTH_ERROR_COPY`, which is the one place in the auth surface where two sources of truth exist for the same string. |
| 5 | `INVITATION_REVOKED` and `SETUP_TOKEN_*` have no emitter | The staff invitation flow they belonged to is removed (staff are added from the Team page, see [`08-staff-onboarding.md`](./08-staff-onboarding.md)). The codes are dead and can be dropped from the catalog. |

## 13. Related docs

- [`04-rate-limiting.md`](./04-rate-limiting.md) — which budget produced the 429,
  and the `/request-password-reset` route the old rule never matched.
- [`09-failure-modes.md`](./09-failure-modes.md) — the cross-service matrix; the
  degraded-Redis and cold-instance rows are the ones this document's fallbacks
  exist for.
- [`03-sessions-and-hooks.md`](./03-sessions-and-hooks.md) — the hook
  mechanism `signInAttemptBeforeHook` / `signInAttemptAfterHook` plug into.
- [`../../enterprise/20-iam-and-security/01-sso-and-authentication.md`](../../enterprise/20-iam-and-security/01-sso-and-authentication.md)
  — the enterprise view of the same codes.
- [`lib/labels/auth-errors.catalog.ts`](../../../lib/labels/auth-errors.catalog.ts)
  — the catalog itself. Every sentence quoted here is in that file.
