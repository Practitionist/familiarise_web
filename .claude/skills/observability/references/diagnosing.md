# Diagnosing a missing or wrong event

Start here for any report of the form "the error isn't showing up", "Sentry shows it but with no user", "we got a 500 and there's no issue", "Sentry is empty", or "I don't believe that was reported". The branches are ordered so the cheapest and most load-bearing check comes first, because the most common version of this problem is not a code bug at all.

Each branch ends in the response that settles it. Do not skip past a branch on the assumption you know which one you are in — the 2026-09-22 outage presented as "Sentry is empty" and was actually "Sentry is discarding", which no amount of code reading would have found.

## Step 0 — classify the complaint

| Complaint                                                             | Branch                                                  |
| --------------------------------------------------------------------- | ------------------------------------------------------- |
| Nothing in Sentry at all; app healthy; no idea whether it's reporting | [A](#a-nothing-arrives)                                 |
| Events arrive, but `Users: 0` or the wrong person                     | [B](#b-the-event-arrives-but-names-nobody)              |
| Events arrive as errors that are really business outcomes             | [C](#c-the-event-arrives-at-the-wrong-level)            |
| Events arrive, and you cannot show anyone they do                     | [D](#d-the-event-arrives-and-you-still-cannot-prove-it) |
| Sentry is drowning in events; someone wants fewer                     | [E](#e-too-many-events)                                 |

If the complaint is "we lost the error", branch A is always the right entry even if you suspect the code path. An unproven path is indistinguishable from a proven one from the outside.

---

## A. Nothing arrives

**A1 — Is Sentry accepting anything at all?** This outranks every code hypothesis, because if the answer is no, no code change can fix it.

```bash
npx tsx -r dotenv/config jobs/observability/sentry-ingest-canary.ts
```

| Verdict               | Meaning                                                 | Go to |
| --------------------- | ------------------------------------------------------- | ----- |
| `accepted`            | Ingest is healthy; the problem is upstream of Sentry    | A2    |
| `rate-limited`        | Quota or window exhausted — read `x-sentry-rate-limits` | A5    |
| `dropped-despite-2xx` | Sentry is 2xx-ing and discarding                        | A5    |
| `rejected-auth`       | DSN or public key is wrong; nothing can ever arrive     | A1.1  |
| `unavailable`         | 5xx or unreachable; Sentry is unwell                    | A5    |

**A1.1** — `rejected-auth` means the client is aimed at a project that does not exist or will not accept. Two dead values are in circulation: a numeric project id from a mis-rotation (answers `403 event submission rejected with_reason: ProjectId`) and `NEXT_PUBLIC_SENTRY_DSN` unset in the context being tested. Check that `NEXT_PUBLIC_SENTRY_DSN` is set on the Netlify context you are testing, and that it is not carrying the dead project.

**A1.2** — Repeated identical alerts? That is a symptom of a long outage, not of noise: it means ingest has been unhealthy for days and the cause is further down. Check `alertSuppressed` in the route's JSON. `true` means the cooldown is correctly holding the repeats back. `false` on a stream of emails means the cooldown's Redis state is unreachable — it fails open by design so you keep getting told, but the store needs fixing.

**A2 — Does the code path report at all?** Read it. If it has no `reportSentryError`/`reportSentryMessage` call, or swallows the error in a `catch` that only logs, the event was never intended. The canonical shape of this bug is on the `maintenance` skill's list: a post-commit `scheduleAfter` failure or a `recordSystemError` whose rejection was unhandled. Both are fixed; grep for `.catch(() => {})` near any error you expected to be reported.

**A3 — Is the SDK initialised in this runtime?** Three runtimes call `initSentry()` from `sentry.shared.config.ts`: server, edge, and client via `instrumentation-client.ts`. A runtime added later does not call it, and `instrumentation.ts` must register the server hooks. A bare-Node job needs `initJobSentry()` from `lib/observability/job-sentry.ts` and a `flushJobSentry()` with a budget before exit — a job missing either is invisible however loudly it fails.

**A4 — Is the error `expected`?** If the error carries the expected marker, `beforeSend` re-levels it to a **warning**. Warnings do not appear in the issue list, only under the log and trace views, so an issue list that is "missing" all of its warnings is a level problem rather than a capture problem — go to [C](#c-the-event-arrives-at-the-wrong-level).

**A5 — Quota or unavailability.** The response names itself:

```
x-sentry-rate-limits: 60:default;error;security;attachment:organization:error_usage_exceeded
```

`error_usage_exceeded` is the period's **included volume** spent, and it does not clear until either the billing period rolls over or the plan's allowance is raised. Raising the plan raises the ceiling immediately — do not advise waiting for the month. See `06-ingest-canary.md` for the plan numbers and the standing risk of a 5,000-error allowance.

If instead the header names a _short_ window (a `retry-after` with no `organization` clause), it is an ordinary throttle: it clears on its own and needs no action beyond not retrying inside `retry-after`.

---

## B. The event arrives but names nobody

**B1 — Confirm the gap is real before changing anything.** Open the issue, check `Users`. Sentry derives a user from an IP when no user is attached, so a non-zero `Users` count is not evidence of identity. The reliable check is the `user.id` on a single event, and the reliable way to get one is branch [D](#d-the-event-arrives-and-you-still-cannot-prove-it).

**B2 — Is the surface request-scoped at all?** Identity is stamped per request by `lib/observability/identity.ts`, entered through `requireApiAuth`, `requireOrgAccess`, the server guards, `AuthSyncProvider` and the sign-out path. A surface that never enters one of those has no identity to attach: a new route group, a background job, a `scheduleAfter` continuation (which runs after the request has ended and the AsyncLocalStorage scope has closed), an edge route, or anything firing from a webhook with no session.

The `scheduleAfter` case is the recurring one. Work that continues past the response is a different lifetime from the request, and `05` covers the shape of the fix.

**B3 — Is the surface inside a request at all?** There is no identity _store_ to go stale and nothing is cleared at the
end of a request: `lib/observability/identity.ts` holds no state and uses no AsyncLocalStorage. Per-request isolation is the
**SDK's** — `@sentry/nextjs` forks a fresh isolation scope at every request boundary, and `Sentry.setUser`/`setTag` write to
that scope rather than the process scope. So the question is not whether a value went stale but whether the surface still has
a live request scope at all. A `scheduleAfter` continuation, a cron job, an edge route or a webhook has left it, and there is
no scope to inherit — which is why those surfaces are the ones that legitimately show no user. Anything that reaches _around_
the SDK to remember the last user itself is the actual bug: a warm Lambda serves requests concurrently, so a remembered user
is routinely a different person's, and misattribution is worse than no attribution. That is the harm the isolation scope
exists to prevent, reintroduced through the back door.

**B4 — Is the event client-side?** Browser events take the client scope set by `AuthSyncProvider`. A client event that is unattributed usually means the provider has not run yet, or the user is signed out and the scope was cleared. Server events take the request scope. Identify which side produced the event before choosing a branch — `environment` and `release` tell you, and a preview vs. production split is the fastest discriminator.

**B5 — Are you blocked on disclosure rather than plumbing?** The identity is a stable cuid, which is pseudonymous personal data under DPDP. It is deliberately not an email address. If the request is "just put the email on the event", the answer is that this needs the compliance sign-off recorded in `05`, not a code change.

---

## C. The event arrives at the wrong level

An event that should be a warning is an error burns quota at 4,000× the rate of a warning and pages someone for a non-problem.

**C1** — Does the error carry a code registered in `BUSINESS_ERROR_CODES` (`lib/errors/classification/payment-error-classification.ts`)? If yes it is a modelled outcome and the route's catch should already be reporting it with `expected: true`. If it is not registered, the code should be — copying the `Object.assign(new Error(msg), { httpStatus, code })` shape.

**C2** — A sweep or reconciler that _finds_ something is not a fault; a sweep that _crashes_ is. One `reportSentryMessage` per run with the count and ids in `extra`, expected, and the HTTP twin answering 207. Reporting a finding as a failure buys retries and noise instead of visibility — see `02-conventions.md`.

**C3** — A cross-region cold-connect timeout or a pooler `Connection terminated` inside a chunk is a platform-ceiling event with a known cause and a fixed set of ignored issue ids. `lib/data/fail-open` (`isTransientDbError`, `reportTransient`) turns it into a breadcrumb. Re-escalation of one of those ids means the platform problem changed shape, not that the route is broken.

---

## D. The event arrives and you still cannot prove it

Go to `docs/observability/sentry/07-verifying-end-to-end.md` for the full procedure. In short:

1. Verify against a **Netlify deploy preview**, not `next dev` — dev skips the upload path, the release is a dirty tree, and the traffic lands in the production project.
2. Sign in as a real seeded user and **write down the cuid first**.
3. Attach a transport spy from a **main-world `<script>`**. A DevTools-protocol evaluation runs in an isolated world where your injected `error` never reaches the page's listeners — indistinguishable from a broken SDK.
4. Trigger a real error, not a synthetic one: the point is that the _server_ supplied the identity.
5. Read the envelope, and resolve the status of the request that carried the **error** item — a `session` and an `event` in one envelope can succeed and fail independently, and the `200` belongs to whichever item got there first.
6. **State the rung** you reached and what blocked the next.

If the block is quota, that is a legitimate, dated answer — and the canary is the instrument for the healthy case, so verify both states separately.

---

## E. Too many events

**E1** — Establish the volume and the shape before reacting. The rate-limit header gives the included allowance and what is left of it.

**E2** — Classify the flood. A single dependency and a narrow error class is throttle-able: `INFRA_THROTTLE_MS` in the shared config exists because one ran to 2,147 `UpstashError` plus ~900 `CronLockUnavailableError` events in 24 hours on 2026-09-21 — 80% of the whole monthly allowance, spent in a day. It trickles one event per class per ten minutes, so the bound is warm instances × 6/hour/class against ~3,000/hour unthrottled. A flood that is _diverse_ rather than repetitive is bounded per class, so its ceiling scales with the number of distinct classes and the throttle is not the answer — that is the plan's included volume.

**E3** — Check level correctness first ([C](#c-the-event-arrives-at-the-wrong-level)). Modelled outcomes reported as errors are usually the cheapest available reduction.

**E4** — Decide throttle vs aggregate before reaching for a plan upgrade, because they fix different shapes:

- **One failure recurring** (`UpstashError` on every request while a dependency is walled off) → **throttle**. `INFRA_THROTTLE_MS` keeps one event per class per 10 min and drops the rest in `beforeSend`; a throttled event never reaches the transport, so it never costs quota. The issue's count then under-reports by design, which is correct — it means "at least one per window", not 3,000.
- **One run finding many distinct things** (a reconcile pass finding 12 missing ledger transactions) → **aggregate** into one `reportSentryMessage` with the count and ids in `extra`, tagged `expected`. Nothing is discarded, so nothing needs inventing.
- **Never aggregate a recurrence.** You would replace a real stack trace with a number the code produced by dropping events, and that number silently under-reports during the incident you are trying to size. Events lost to a window boundary, an instance dying mid-window, or a deploy are invisible and uncountable.
- **Grouping ≠ saving.** A shared `fingerprint` gives N events one issue with a count and costs N. The canary did exactly this and still cost 8,640 events a month until its cadence was cut to 30.

**E5** — Check whether the `ignoreErrors`/`denyUrls` lists and the breadcrumb path are doing their job, then consider a second sink. `system_events` in Postgres already holds the audit row for money paths, and `lib/observability/betterstack-telemetry.ts` has an out-of-band path that is currently disabled.
