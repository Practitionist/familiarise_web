# Proving an event actually arrives

A claim like "I verified the error was reported" is worth almost nothing until you say _what_ you observed and _where_. This page is the ladder of evidence, the procedure for climbing it in this repo, and the traps that each rung hides. Written after verifying the request-scoped identity work on 2026-09-28 and failing to prove more than I could.

## The ladder

Each rung costs more and proves more. The failure that motivates this page is claiming a high rung after standing on a low one.

| Rung | Evidence                                                   | What it proves                                                                  | What it does not prove                                                                 |
| ---- | ---------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1    | The code path calls `reportSentryError`                    | The code _intends_ to report                                                    | That the SDK initialised, that a DSN exists, that anything left the process            |
| 2    | A `beforeSend` log line, or a spy on the helper            | The event reached the SDK                                                       | That Sentry accepted or stored it                                                      |
| 3    | The raw envelope captured **off the wire**                 | Sentry was addressed, with the exact payload — user, tags, release, environment | That Sentry stored it, or made it searchable                                           |
| 4    | A `2xx` with no drop notice from the envelope endpoint     | Sentry accepted the event                                                       | That it is queryable — events are not immediately searchable, and retention is 30 days |
| 5    | The event visible in the Sentry UI, queryable by `user.id` | End to end                                                                      | —                                                                                      |

Rung 5 was unreachable in the 2026-09-28 verification, because the ingest was answering `429 error_usage_exceeded` (see `06-ingest-canary.md`). Reporting that honestly — "rung 3, storage unproven, blocked by quota" — is the correct outcome, and the canary exists precisely so the next attempt can reach rung 5 without any browser work at all.

The trap in rung 3 is that it is genuinely good evidence and feels final. Reading the payload off the wire tells you the SDK serialised `user.id` into the event. It does not tell you Sentry stored it, and the whole incident on this page began at the boundary between those two facts.

## Why not just the local dev server

Verify against a **Netlify deploy preview**, not `next dev`. A local dev server is not a representative environment for this: dev builds skip the Sentry upload path, the release is a dirty working tree rather than a commit SHA, and the traffic would land in the production project where a real person might see a synthetic test error attributed to nobody in particular. The preview is a real build of a real commit, so `release` and `branch` are meaningful and the events are separable from production by the `environment` tag.

The trade-off is that a preview cannot see a local `.env`, so anything the test needs must be on the Netlify context. In practice the seeded test accounts are the hard part — see the recipe below.

## The procedure

1. **Get the preview URL and a signed-in session.** Sign in as a real seeded user in the preview browser context. Do not fabricate an identity: the point of the test is that the _server_ supplies it from the session, and a hand-set client scope proves nothing about that.
2. **Note which user you are.** Get the cuid from the account page. Write it down before you start; you will need it to correlate the envelope, and reconstructing it afterwards from a log is painful.
3. **Attach a transport spy.** The SDK is bundled by `sentry.shared.config.ts` and is deliberately **not** put on `window`, so there is no `window.Sentry` to inspect. The reliable place to see events is the HTTP layer: wrap `fetch` and `XMLHttpRequest` from a page-context script, and record the request URL, status, response body and the `x-sentry-rate-limits` header. `X-Sentry-Auth` carries the DSN, so the spy also confirms which project the client is aimed at.
4. **Trigger a real, harmless error.** Navigate to something that fails for a modelled reason, or use a route with a test-only error. A synthetic `throw` from a script proves the transport works but not that the identity was applied by the server.
5. **Read the envelope.** Expand the captured body. The items arrive as a header line, then the payload JSON per item. Look for the `event` item and confirm `user.id`, `user.username`, `release`, `environment` and `branch`. Record the status code of the _request that carried the error item_ — not the first one.
6. **State the rung.** Write the claim as the rung you reached, and say what blocked the next one. This is the whole point of the page.

## The isolated-world trap

This one cost an hour and is worth its own heading, because it fails _silently_.

A script run through a DevTools-protocol `Runtime.evaluate` — which is what an automated browser-driving tool does when it evaluates an expression — runs in the page's **isolated world**, not the main world. Isolated worlds share the DOM but not the JavaScript context. Consequences, all of them observed the hard way:

- An `error` event thrown by your injected script is dispatched in the isolated world and **never reaches the page's own listeners**. Listening for `window.onerror` in that same isolated context sees nothing, which reads exactly like "Sentry is not initialised".
- A `window.onerror` handler installed by the page's bundle is invisible to you, and your handler is invisible to the page's bundle.
- CSP can block a dynamically injected inline `<script>` on the main world even when it runs fine in the isolated world — the opposite trap, and just as confusing.

The fix is to stop trying to run code in the isolated world. Inject a real `<script>` element into the document, with the transport spy in its text, and let the page's own main world execute it. Only then does the spy see the page's traffic.

## The two-header trap

Sentry's envelope endpoint returns one HTTP response for a multi-item envelope. A single page load typically sends a `session` item and an `event` item in the same body, and they can succeed or fail **independently**. During the 2026-09-22 quota exhaustion the `session` item was answered `200` and the `event` item `429`, on the same request.

So: a `200` you observed on any Sentry request is not evidence that error events are being accepted. Always resolve which item the status belongs to, and read `x-sentry-rate-limits` — that header names the limited categories (`error`, `security`, `attachment`) and omits the healthy ones, which is the fastest way to see a partial outage. This is also why the quota incident was invisible for six days: the error rate-limited while spans and sessions kept flowing, so the dashboard kept looking alive.

## The seeded-account recipe

A preview has no local `.env` and no local database, so the test user must exist in the shared Postgres project. Deterministic seed accounts are the intended route — see the `maintenance` skill's Prisma seed-suite reference. The failure mode to watch for is signing in as a user whose session exists but whose org membership row does not, which produces a request that is correctly authenticated and correctly missing an org, and will look like an identity bug if you do not know the difference.

Record, from the verification, the exact values you observed. For the 2026-09-28 run they were: user `cmu15v9cb03spc7yo6gvhzecx` (`tour-owner@familiarise.com`, role `ORG_WORKSPACE`), org `cmu15uus703ruc7yo99zv05t4` (membership `OWNER`), preview release `98eb2810eb7970b1e0f1ab1061a2722cba3bf8b1`, branch `pull/1868/head`. The `session` envelope's `did` field corroborated the client scope independently, which is a useful cross-check because it is set on a different code path than the event's `user`.

## What to do when the quota blocks rung 5

Do not substitute a weaker claim, and do not go quiet. Say which rung you reached, quote the response that blocked you, and switch to the mechanism designed for it: the ingest canary, which reads the response directly and can report `healthy: true` the moment the ceiling is raised, with no browser involved. Verify the quota case and the healthy case separately and date both — a check that has only ever been seen in one state has not been tested.
