# Triage runbook

This is how a Sentry pass is run on this project so that its output is a set of decisions rather than a longer list. The finance train of 2026-09-19/20 ran it five times (once per deploy preview and once for the 24-hour production sweep); the shape below is what survived.

## Scope the pass by release, not by time alone

Production and every deploy preview report into the same project, so a time window mixes the owner's production traffic with QA fixtures on three previews. Filter first by `release:<sha>` for the build under test, or by `branch:pull/<n>/head` for a preview, and only then by time. For a production sweep use `environment:production` and the last 24 hours, and expect to see preview noise in the unfiltered list.

## Attribute every new issue to one of three causes

Each issue that is new in the window gets exactly one attribution before anything else is decided. Either it was caused by the pass itself or by a QA run (the event carries the preview's branch tag, or the fixture ids the QA report lists, or it is a message tagged `expected:true` that a test case deliberately provoked); or it is a pre-existing pattern that re-fired (the same fingerprint exists with an older first-seen, usually one of the platform-ceiling ids or a seed-data artifact); or it is genuinely new in production. Only the third kind needs a human now, and the sweep's report must say which issues those are in a short "needs a human" list, with the count of everything else. A sweep that reports fifteen issues without this split has not been triaged.

Two attributions are easy to get wrong. A burst of `cron failed:` events is the Actions failure sink working, not a burst of new failures — check the run dates in Actions against the issue's first-seen (see the failure-sink page). And an `expected:true` warning from a money path is a modelled refusal or a reconciler finding; its presence is the signal that the code refused correctly, and the only question is whether the volume is right.

## Decide, then write the reason on the issue

An issue caused by the pass is resolved with a one-line comment naming the QA report and the fixture. A re-fired platform-ceiling issue stays ignored-until-escalating; if it did escalate, that is the #1124 signal and the comment says so. A genuinely new issue gets an owner: a GitHub issue if it needs a PR, an append to the tracking issue that already owns the mechanism if one exists (the Sentry ledger issue #1611 collects the ones with no better home), or a fix in the open PR when the pass is a preview QA. Resolving without a reason is how the same issue gets re-triaged a week later by someone who cannot tell whether it was fixed or dismissed.

## Chronic issues you will meet

`FAMILIARISE_WEB-9` and `-A` are cross-region cold-connect timeouts on the single-connection pool, ignored until escalating, tracked on #932/#937 and #1124. `-44` is the edge layer answering non-JSON to a `fetch().json()` on the checkout success page during an instance-boot stall, ignored, same family. `-51` is the session lookup's replica-lag guard firing as designed (warning, expected); since #1752 the success page waits it out instead of routing to failure. `-4P` (`reconcile-payment-status: N pending payments have gateway ids the gateway does not know`) fired every five minutes for weeks on thirteen seed rows that no sweep could claim; #1761 retires such rows once, so a recurrence means a new orphan, not the old ones. `-4Y`/`-4Z`/`-59` are the overlapping-occurrence seed data on `reconcile-occurrence-availability`. `-56` is `SessionLookupFailedError` thrown from the `/profile` layout server component, which throws where an API route would answer 503; it is tracked on #1611 and goes away when `/profile` folds into Account. The four `cron failed:` ids from 2026-09-20 are the sink's first deliveries (previous page).

## The tools

The Sentry MCP is read-mostly: `search_issues`, `search_events`, `get_sentry_resource` and `update_issue` (resolve/ignore with a comment) cover a sweep. It cannot create alert rules; the workflow-engine API answers `400 This API no longer exists` to the old projects/rules endpoint, and the working path is the Sentry CLI's `sentry alert issues create practitionist/familiarise_web …` with the `--condition`, `--filter` and `--action` JSON documented in the memory of the 2026-09-19 pool-exhaustion rule (rule id 6031144, which pages on `pool_exhaustion:true` events). The CLI authenticates through its own OAuth login, not the dead `.env` token. Gmail carries no Sentry mail for this project today — the alert rules email the owner directly — so a "check Gmail for Sentry" step confirms absence rather than finding anything.

## One rule for agents running the pass

Read verdict-level summaries, not raw event lists, and never take an agent's attribution on trust for a money-surface issue: open the event, read its tags, and check the run log or the QA report it claims. The two misreadings above both came from agents that had the facts but not the context, and both were caught only because the human asked why.
