# Identity and triage

Why this page exists: in 90 days of production the Sentry project captured
**38 of 40 open issues with `Users affected: 0`**, and the two that did carry a
"user" carried an IP-derived placeholder — a `user` field holding a raw
requester IP and a derived `user.geo` country, with no application identity
anywhere on the event. Not one event had ever carried a real user id. (The
address and country are redacted here; both were real values read off live
events, and neither belongs in a committed file.) A support agent reading "the payment page 500s" had no way to find
which of their users hit it.

This is a code problem, not a tooling problem. Sentry already indexes
`user.id`, already counts unique users per issue, and already offers a
`Users` sort on the Issues page. None of it was populated, because the one
function that holds a session in hand — `requireApiAuth()` — never called
`Sentry.setUser`.

**Read the rest of this page knowing the fix is not on.** The code exists and
is wired into six call sites, and none of it runs: `SENTRY_IDENTITY_ENABLED`
defaults to off, deliberately, and the sections below explain what switching it
on is waiting for. So "Sentry shows no user" is the expected state of the
system today, not a symptom of anything.

## Where identity is stamped

`lib/observability/identity.ts` is the whole module. Six call sites, because
there are three server-side entry points into a request plus three client-side
and fallback ones:

| Call site                                             | Covers                                 | Stamps                      |
| ----------------------------------------------------- | -------------------------------------- | --------------------------- |
| `requireApiAuth()` — `lib/auth-helpers.ts`            | 106 API-route call sites, transitively | user                        |
| `requireOrgAccess()` — `lib/auth-helpers.ts`          | 122 org-route call sites               | org, then org role on grant |
| `resolveGuardSession()` — `lib/auth-guard.ts`         | every page/server-component guard      | user                        |
| `AuthSyncProvider` — `providers/AuthSyncProvider.tsx` | the browser, all sign-in paths         | user                        |
| `signOut` — `lib/auth-client.ts`                      | the browser                            | clears                      |
| `apiError()` — `lib/errors/api-error.ts`              | routes that reach it without the guard | user                        |

Nothing was added to the 48 individual routes. The win comes from the fact that
the auth helpers were already the chokepoint.

**None of it is switched on.** Every one of those call sites is in place and
every one of them early-returns until `SENTRY_IDENTITY_ENABLED=on`. The module
is written, wired and deliberately inert; see the preconditions below for why,
because "we added identity to Sentry" is otherwise the natural thing to
believe about this page and it is not what is running.

## Why the org is not guessed

`setSentryOrgContext` is called only where a route has actually resolved a
tenant. A user can hold active memberships in several orgs, and `firstOrgId`
in the dashboard layout is a _landing_ heuristic, not an authorisation
context. Stamping the first membership would put a confidently wrong tenant on
money and booking events — worse than no tenant at all, because it reads as
authoritative in triage.

`requireOrgAccess` stamps the org id as soon as the row is read (so a 403 is
still attributable — "user X was bounced off org Y" is a real support
question), and upgrades it to the real `org_role` + `membership_id` only at the
grant. A platform admin crossing a tenant boundary gets `org_role: "ADMIN"`
and **no** membership id: the `__admin_stub_${userId}` value that path
synthesises is not a real `Membership.id` and would be a broken join key.

## `setUser` replaces, it does not merge

The single easiest way to ship this module uselessly is to call
`Sentry.setUser({ org_id })` after `Sentry.setUser({ id })` — the second call
discards the first, and every event is unattributed again while looking
correct in the code. `identity.ts` reads the current user off the isolation
scope and merges. `__tests__/observability/identity.test.ts` pins this in both
orders.

## Why it is safe without AsyncLocalStorage

Sentry forks the isolation scope around every server request boundary
automatically, and `setUser`/`setTag` write to the **isolation** scope, not
the process scope. So a call inside a route handler is per-request by
construction: no `AsyncLocalStorage` plumbing, and no possibility of one
request's identity bleeding into a concurrent request on a warm instance.

## What is deliberately not sent

No email. `User.id` is a cuid — opaque, random, no personal data encoded — and
it is the join key support already holds, so an agent resolves an event to a
person in-app without the address leaving the system.

A cuid is a _pseudonym_, which is still personal data under GDPR and DPDP, and
it is **not** equivalent to the requester IP the SDK already collects. Those two
differ in the ways that matter for a data-protection assessment:

|                        | requester IP (already collected)                                  | `User.id` (this change)                                  |
| ---------------------- | ----------------------------------------------------------------- | -------------------------------------------------------- |
| What it identifies     | a network location, often shared (household, office, carrier NAT) | exactly one account                                      |
| Stability              | changes with the connection, home address, and carrier            | constant for the life of the account                     |
| Correlation            | weak — two events from one person rarely match                    | strong — every event that person ever had links together |
| Resolution to a person | indirect, via access logs                                         | direct, one lookup in our own database                   |

So the disclosure is a **real increase, not a negligible one**. What makes it
defensible rather than merely arguable is narrower than "we already collect an
IP":

- It is a pseudonym, not an identity. The mapping to a person stays in our
  database; the processor sees an opaque token.
- No email, name, phone, or address is sent by this module.
- It is an explicit, documented, auditable label rather than an IP the SDK
  inferred — which is what makes the disclosure reviewable at all.

**Revocability is partial, and the honest scope is worth stating.** Sign-out
clears the id from the live scope (`clearSentryIdentity`), so no _subsequent_
client event carries it. It does not un-send anything: Sentry retains already
delivered events for its retention window — 90 days on the Team plan — and a
cuid sitting in a historical event stays a stable link back to that account
until the event ages out or is deleted. Account erasure therefore does NOT
retroactively anonymise Sentry's copy, and nothing in this change should be
described as if it did. If a subject-access or erasure request covers the
error-monitoring processor, the operative questions are Sentry's deletion API
and the retention window, and they belong in the DPA review below.

The codebase already has the pattern: `User.pseudonymousId` is
`SHA-256(userId + salt)`, documented as existing "so historical
investigations still trace events back to a (deterministic) actor without
exposing PII".

### The disclosure is opt-in, and it is off

`lib/observability/identity.ts` exports `isSentryIdentityEnabled()`, which is
`process.env.SENTRY_IDENTITY_ENABLED === "on"`, and that is the whole of it.
**The default is off.** `setSentryIdentity` and `setSentryOrgContext` both
return immediately when it is false; the org is gated separately from the user
so that turning the switch off cannot leave a named tenant on an otherwise
anonymous event. `clearSentryIdentity` is deliberately _not_ gated — clearing
is always safe, and on the client the isolation scope outlives a sign-out, so an
unset switch must never be the reason a previous user's identity survives on the
scope.

The check is an exact `=== "on"` and that is deliberate rather than fussy. Unset,
`true`, `1`, `yes`, `ON` and every typo are all **off**. A privacy gate that a
misspelling can switch on is not a gate. It is read per call, not at module
load, so a test can toggle it and a runtime env change takes effect without a
rebuild.

**What off costs is the thing at the top of this page.** The issues go back to
`Users: 0` and a support agent again cannot answer "which of my users hit
this" from Sentry alone. That is the deliberate trade, and the trade has a
direction: an unattributable error is an operational cost, while a disclosed
pseudonym is a legal one, and only the second is irreversible. The code is
present, the toggle is one environment variable, and nothing else is blocking a
switch-on; what is blocking it is the next section.

### Preconditions before this is considered settled

Treat these as blocking for flipping the switch on in production, and route them
through whoever owns DPDP compliance — **not** through code review:

1. **Sentry DPA** — confirm the existing data processing agreement covers
   transferring a stable pseudonymous user id to a US processor, and check the
   sub-processor / transfer-position implications for an India-origin data
   principal.
2. **Data inventory / RoPA** — add the Sentry event contents to the internal
   processing record. That is not only the user id: on an org-scoped route the
   event also carries `org_id`, `org_role` and `membership_id` as user fields,
   plus the `org_id` tag, so a single recorded account is correlated to a named
   tenant and a role within it. The geo and IP already flowing today should be
   recorded at the same time; they are currently undocumented.
3. **Privacy notice** — confirm the notice already covers error monitoring by a
   third-party processor, and that the notice does not promise anything this
   change breaks.

**A negative answer on any of the three is blocking.** It does not get worked
around by substituting a hash — shipping the feature on a surrogate because the
review came back unfavourable is shipping it anyway, with less evidence.

Three things about those three that are easy to get wrong, and which is why
this is a compliance question rather than an engineering one:

**Consent does not solve the transfer problem, and that is the part only a
legal determination can close.** The data principal is in India and Sentry's
region is not, so every event carrying a cuid is a transfer out of India. DPDP
§16 governs that transfer _separately_ from the consent that would justify the
processing in the first place. They are two gates, and only one of them is ours
to set: a consent flag is a switch we can throw, a transfer position is a
determination about our arrangements with the processor and our ability to
honour an erasure or a purpose limitation once the data has left. No code review
can supply that determination, and the flag being available is not evidence that
it has been made. For the statutory position, what the industry actually does,
and the same wire measurements below written up for reuse outside this
repository, see [08 error telemetry and privacy](08-error-telemetry-privacy-reference.md).

**The end state is per-user consent layered on top of this flag, and it does not
exist yet.** Granular consent at consumer signup is Gap #1 in
`docs/compliance/08-dpdp-and-privacy.md`, dated to Phase 3 — so there is no
per-user value to check, and a global environment variable is the only thing
that can be gated today. It is the coarse switch that has to exist first. It is
not the finished answer, it should not be read as one, and the natural
refinement — check the individual user's consent before stamping their cuid —
is blocked on that gap rather than on anything in this module.

**The cost of being wrong is not symmetric, which is why this defaults off.** If
the disclosure turns out to have been unlawful, no later change to a flag undoes
it — the events are already at the processor. If the identity turns out to have
been worth having, the price of waiting is slow triage. The switch exists to make
that asymmetry explicit and to let whoever owns the legal call make it, rather
than leaving it as an accident of deployment order.

The surrogate is a separate, _additional_ data-minimisation measure, worth
considering on its own merits, and it is not a one-line change. The same
transform has to be applied when _querying_, or the back-office panel searches
for a value that was never written. Both sides need it —
`lib/observability/identity.ts` to stamp, and
`lib/observability/sentry-issues.ts` to look up — over a salt in the runtime
environment, plus a decision about events already written under the
untransformed id: either a second search path, or accepting that the panel only
covers events from the cut-over onward.

## The `dataCollection` migration is load-bearing

`sendDefaultPii: false` is deprecated as of SDK 10.54. The resolver
(`@sentry/core/utils/data-collection/resolveDataCollectionOptions`) documents
the trap in its own source:

> In v10, DEFAULTS only apply when `dataCollection` is explicitly provided.
> When `dataCollection` is absent, the legacy `sendDefaultPii` bridge is used,
> which defaults to `userInfo: false` to preserve backward compatibility.
>
> TODO(v11): Remove `sendDefaultPii` support and always fall through to DEFAULTS
> so that `userInfo: true` will always apply.

So on an SDK upgrade, `userInfo` flips to **on** unless the config is explicit.
`sentry.shared.config.ts` now names every category it does not want. Two of
them were not obvious:

- **`stackFrameVariables` defaults to `true`** — local variable _values_ are
  captured into server stack frames. In a Prisma codebase a frame routinely
  holds a `userId`, an email, or a whole row. Now `false`.
- **`httpHeaders` is a `{ request, response }` object, not a boolean.** The
  documented form `dataCollection: { httpHeaders: false }` is a type error, and
  writing the wrong shape would have left response headers on.

Source context lines (`frameContextLines`, 5 by default) are kept: they are the
difference between a readable N+1 frame and a bare file/line, and the
surrounding source contains no tenant data.

## Do NOT put `user_id` in a tag

`user.id` is a first-class indexed event property. It is what powers
`count_unique(user)`, the "Users affected" count, and `sort=user` on the
Issues page. Duplicating it into a custom tag buys nothing and creates a
high-cardinality key — see getsentry/sentry#94727, where a 10.6k-value tag
broke the Tag Details UI.

`org_id` **is** a tag (`lib/observability/identity.ts:ORG_ID_TAG`), because
tenant filtering has no first-class field. That is a deliberate trade: one
value per tenant is high-cardinality by construction, acceptable while the org
count is in the tens or low hundreds.

If it grows past that, the tag has to be _replaced_, not dropped: the event
still needs a tenant, because a user can belong to several orgs and
`user.id` cannot disambiguate which one the event was about. The options are a
lower-cardinality tenant attribute (`tier`, `funding_source` — useful for
aggregation but not for lookup) or a dedicated low-cardinality surrogate that
is not the raw id. Do not fall back to inferring the org from the membership
list; that is the same confidently-wrong tenant this module refuses to stamp,
and it is worse than no tenant because it reads as authoritative in triage.

## Triage: the ticket → error join

`lib/observability/sentry-issues.ts` answers "which issues is this user
hitting" for the back-office, using the same indexed field:

```
GET /api/0/organizations/practitionist/issues/
      ?query=user.id:"<cuid>" is:unresolved
      &project=familiarise_web&statsPeriod=14d&sort=date
```

It needs `SENTRY_API_TOKEN` (scope `event:read`) — **not**
`SENTRY_AUTH_TOKEN`, which is the build-time source-map uploader with
`project:releases`, present in a different set of environments, and currently
dead locally (401). Two differently-scoped tokens with similar names is a
trap, so the new one is app-only and separately named.

It is wired into `readUser360` as the last section, and every failure path —
no token, 401, 403, 429, timeout, malformed body, and a malformed
`SENTRY_API_URL` — resolves to `{ configured: false }` rather than throwing. A
triage panel is an enrichment, not a gate: an agent opening the page
mid-incident must not be shown a failure caused by the observability provider.
The token is not set yet, so the panel currently renders empty and nothing else
changes. The `SENTRY_API_URL` case has its own history worth reading before you
change that base — it used to reject rather than degrade, and the regression
test for it was a false green — and it is on the setup page next to the
coordinate itself.

Still open, and deliberately not in this change:

- `SupportTicket` has no `sentryEventId` column. `recordSystemError` writes
  the audit row and fires the Sentry event but never stores the returned event
  id back, so the join is currently one-directional (user → issues, not
  ticket → issue).
- `RatingCause.PLATFORM_TECHNICAL` is dead schema.
  `docs/feedback/01-architecture.md` confirms _"No route writes either column
  yet"_, so the existing "our stack failed" taxonomy records nothing. This is
  the cheapest remaining win for support: the column and the enum value already
  exist and mean exactly the right thing.
- Sentry source maps are still not uploading, so stack traces remain
  minified. That is the `SENTRY_AUTH_TOKEN` note in `.env.sample`, and it caps
  how much of this work is usable until it is fixed.

## Sizing

No new vendor. Sentry Developer ($0) includes 5k errors/month; the 2026-09-21
Upstash incident consumed ~80% of that in 24 hours, which is what the
`INFRA_THROTTLE_MS` throttle in `sentry.shared.config.ts` exists to mitigate.
The real fix is the **Team plan at $26/mo** — 50k errors, 90-day retention
instead of 30, and the REST API scope the triage panel above needs.

Cron monitors are 1 free then $0.78 each, and worth turning on: the cron fleet
is where the observed outages were, and 34 of the 53 `/api/cleanup/*` routes
are not in `cron-tick.mts`'s `TARGETS`, so they only run on the daily/weekly
Actions schedule.

Datadog, Grafana/Prometheus, PostHog and GA were all evaluated. None of them
would have supplied the missing line of code.

## The error quota is exhausted, and it fails silently

Found while verifying this change end to end, on 2026-09-28. It is the reason
nothing in this document could be demonstrated in the Sentry UI, and it is worth
knowing about independently of it.

The organisation's error allowance for the billing period was spent on
2026-09-22 — the day after the Upstash request-cap incident put ~5,000 events
through the Developer plan's 5,000/month in a single day. Sentry then began
answering the **error** items of every envelope with:

```
429  retry-after: 60
x-sentry-rate-limits: 60:default;error;security;attachment:organization:error_usage_exceeded
{"detail":"Sentry dropped data due to a quota or internal rate limit being reached."}
```

Two things make this the worst possible failure mode for an error tracker:

- **The SDK is well behaved.** It drops the event, honours `retry-after`, and
  never surfaces anything to the application. The app stays healthy, deploys
  stay green, and the cron jobs stay quiet.
- **Only the error category is limited.** `sessions`, `transactions` and
  `logs` are not in the limited set, so the Sentry dashboard keeps showing
  _something_ recent — the span-derived N+1 issues kept updating for days
  after every error issue went silent. A glance at the dashboard reads as
  "healthy, just quiet".

The error stream was therefore empty for six days and nothing in the product or
in CI could tell.

### Confirming it yourself, in one request

Every value below comes from the environment — never paste a real DSN into a
terminal, a ticket or a commit.

```bash
# $NEXT_PUBLIC_SENTRY_DSN looks like https://<publicKey>@<host>/<projectId>
dsn="${NEXT_PUBLIC_SENTRY_DSN:?set NEXT_PUBLIC_SENTRY_DSN first}"
read -r key host path <<<"$(printf '%s' "$dsn" | sed -E 's#^https://([^@]+)@([^/]+)/(.+)$#\1 \2 \3#')"

curl -sS -D - -o /dev/null -X POST \
  "https://${host}/api/${path}/envelope/?sentry_version=7&sentry_key=${key}" \
  -H 'content-type: application/x-sentry-envelope' \
  --data-binary $'{"event_id":"'"$(head -c 16 /dev/urandom | xxd -p)"'"}\n{"type":"event"}\n{"event_id":"…","level":"error","platform":"javascript","logger":"manual-check"}\n'
```

Look at the status code, and at `x-sentry-rate-limits`. A `429` naming
`error_usage_exceeded` is the smoking gun; a `200` is the healthy case. This is
the same probe `lib/observability/ingest-canary.ts` runs every 30 minutes.

### Fixing it does not mean waiting for the month to end

The quota is measured against the plan's included volume, so **raising the plan
raises the ceiling immediately** — the usage already spent is under the new
number, and `error_usage_exceeded` clears on the next event. Moving from
Developer (5k errors/month) to Team (50k) is $26/mo and also brings 90-day
retention and the `event:read` REST scope the triage panel above needs.

So the sequence is: upgrade, then `POST /api/cleanup/sentry-ingest-canary` and
confirm `healthy: true`. No need to wait for the period to roll.

## The canary: the one check that can catch the above

`lib/observability/ingest-canary.ts` posts a real, minimal error envelope and
classifies the **response** — status, the `x-sentry-rate-limits` header, and
the body. It is wired into the five-minute `cron-tick` ticker and has a
bare-Node job twin at `jobs/observability/sentry-ingest-canary.ts` for the
Actions schedule.

Three design points, each of which exists because of how the failure presented:

- **A raw `fetch`, not the SDK.** `captureException` + `flush()` cannot answer
  this: `flush()` returns a boolean, not a reason, and a dropped event is
  indistinguishable from a delivered one. The ingest response is the only
  evidence available while ingest is broken.
- **A 2xx is not assumed to be success.** Sentry can answer 200 and report a
  drop in the body, so the body is read rather than assumed — treating 200 as
  healthy is precisely how this stayed invisible.
- **It emails, and never reports to Sentry.** A check that reports its own
  failure through the failing system is not a check. The alert goes through
  Resend (`lib/observability/ingest-alert.ts`), a separate quota and a separate
  provider, and says what to do: the reader's dashboard looks healthy and cannot
  derive the fix. Recipient is `OBSERVABILITY_ALERT_EMAIL`, defaulting to the
  platform support mailbox.

The canary event carries a fixed fingerprint, so half-hourly runs collapse into
one issue with a count rather than hundreds of near-identical ones, and it
carries no user, org, IP or URL — it is an infrastructure probe and should never
become a record about a person.

## What was verified, and what was not

Stated plainly, because the two are easy to conflate and one of them is easy to
over-claim:

**Verified end to end** — the client SDK serialises the acting identity onto
the wire. A captured envelope from a deploy preview of this branch, sent while
signed in as a Wipro org OWNER, contained:

```json
"user": { "id": "<cuid>", "username": "ORG_WORKSPACE" },
"tags": { "branch": "pull/1868/head" },
"release": "<this commit>",
"settings": { "infer_ip": "never" }
```

and the session envelope carried `"did":"<cuid>"`, Sentry's distinct-id, which
is derived from `setUser`. Before this branch the same project's events carried
`user: ip:<address>` and no application identity at all. That preview ran with
`SENTRY_IDENTITY_ENABLED=on` set explicitly, because that is the path under
test and the default is off — so this is evidence about what the module does
_when it stamps_, not evidence that it stamps today.

**Not verified** — that Sentry stored, indexed or displayed any of it. Every
error event in that window was refused at ingest with a 429. So the claim is
"the plumbing labels the event correctly", not "the event is queryable in
Sentry". The second half needs the quota fixed, and can then be checked in one
request against the canary. And the whole rung ladder is conditional on the
switch above: with the flag off, the correct observation on any of these is that
nothing is attached, which is the switch working rather than a regression.

Measured on the wire on 2026-09-29, across `@sentry/nextjs` 10.59.0, 10.75.3
and 11.1.0 with this repo's exact config: **`contexts.culture.timezone` is still
sent** — `CultureContext` is not covered by `dataCollection`, and a timezone is
a coarse location signal, so it is now stripped in `beforeSend` and
`beforeSendTransaction`. **`request.headers` does NOT carry `User-Agent`**: the
earlier claim here was wrong, and with `httpHeaders: {request:false}` the header
is absent from every captured payload in all three versions.

Three other measurements from the same experiment, recorded because each was
assumed rather than known:

- **`Sentry.setUser()` is always sent regardless of `dataCollection`.** Sentry's
  own documentation says so. `userInfo: false` therefore cannot be relied on to
  withhold the cuid — the call site and the switch in `identity.ts` are the
  control, which is why the switch exists and why it defaults off.
- **`userInfo: false` strips IP.** Contrary to the assumption, no IP address
  reached the payload in any version, by header, cookie or query string: the
  integration drops all twelve IP-bearing header names when `userInfo` is off.
  With `userInfo: true` the IP does appear.
- **Query strings were a live leak on 10.59.0 and are fixed by 10.75.3.** On
  10.59.0 `queryParams: false` only suppressed the separate `query_string`
  field; `event.request.url` still carried the raw query string, so an email or
  token in a query parameter reached Sentry in cleartext. This is why the SDK is
  pinned to 10.75.3, and why `urlQueryParams: false` now sits alongside
  `queryParams: false` — v11 renamed the key with no fallback, and its default
  is `true`, so a v11 upgrade carrying only the old key would reintroduce the
  leak silently.

One thing no client-side measurement can answer: the payload is what the SDK
puts in the event, not what Sentry's edge observes. Their ingest endpoint still
sees the connecting IP address regardless of `dataCollection`, and scrubbing is
never retroactive for events already accepted. Both belong in the privacy
review as open questions rather than as resolved facts.
