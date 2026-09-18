---
title: Engineering log — onboarding hardening train, September 2026
band: onboarding
audience: sde1
status: live
last-reviewed: 2026-09-18
---

# Engineering log — onboarding hardening train, September 2026

This log records what the September 2026 onboarding train changed and why, in the order it landed, so the next person reading the code finds the reasoning without re-deriving it from pull requests. The decisions it rests on were taken with the owner on 2026-09-18 and are listed at the end.

## What prompted it

Three stacked pull requests opened on 2026-09-17 hardened the onboarding subsystem page by page: #1698 added rate limits, force-fresh sessions, an email-ownership check, a gate on transient uploads and a DEGRADED write-block; #1699 closed the half-onboarded operator window, made the invite gate a flat tri-state, gave multi-org users a deterministic landing and made EXPERT invites strict; #1700 added Resend twins for the verification, membership and organisation notices plus the referral bells. Reviewing the workflow as a whole rather than the pages surfaced the gaps the three did not cover, and the train grew to six.

## What the review found

Availability had three independent copies of "validate and replace" that had drifted, and the schedule-type switch guard ignored trials and was not atomic. Verification documents stored a one-hour signed URL that had always expired by the time staff opened it, the onboarding-completion path linked any document id it was handed (#1224), submissions were check-then-create without a transaction, the staff and admin review routes carried two copies of the same body with no transition guard, the staff–consultant NEEDS_INFO loop had no bound, and uploads had no quota beyond a rate limit. On identity, #1699's strict EXPERT accept combined with the wizard's own guard left an onboarded learner or operator invited as an expert with no way forward. And #1700 had moved the outbox stage itself into `after()`, which is not where durability lives.

## What landed

The table below lists the six pull requests and the one sentence that explains each.

| PR    | Branch                            | The change in one sentence                                                                                                                                                                                                                     |
| ----- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1698 | `fix/onboarding-p1-p0-hardening`  | Handler-side rate limits, force-fresh sessions, email ownership, the consultant-draft gate on transient uploads, DEGRADED blocks the wizard's server actions; plus, from review, the live-role check on submit and a 400 for a malformed body. |
| #1699 | `fix/onboarding-p2-org-hardening` | The operator profile is created at the role handoff, the invite gate cannot flash the picker, the multi-org fallback is deterministic, EXPERT accept is strict and documented as such.                                                         |
| #1700 | `fix/onboarding-p3-email-twins`   | Five email twins and the referral bells; every route stages its outbox rows before the response and attempts them inside `after()`, through `scheduleAfter()` which survives a scope without a request.                                        |
| PR-4  | `feat/availability-contract`      | One availability contract on every write, the switch guard re-checked in-transaction with a CAS and extended to trials, shrinking reported rather than refused, the completion score computed.                                                 |
| PR-5  | `feat/verification-model`         | Documents are rows from upload with an owner, a quota and a sweep; one submission writer and one review writer, both transactional; reason codes on flagged documents; a three-round cap with a reminder and a stale close.                    |
| PR-6  | `feat/add-expert-identity`        | The wizard's add mode creates a consultant identity on an onboarded account, and the invite page points there.                                                                                                                                 |

## What was verified

Each pull request ran a cold `tsc`, eslint on every touched file and its jest suites; #1700 additionally ran every payments and booking suite that imports the checkout and webhook modules it touches (69 suites), because bare `after()` throws outside a request scope. #1698 was exercised end to end on its Netlify deploy preview by a QA agent: the wizard through to a staff approval, the upload gate, the email-ownership refusal, the rate limiter tripping on the eleventh call, the role check, session revocation biting immediately, and the settings page — eight scenarios, all passing, with three pre-existing defects recorded and folded into PR-4 and PR-6.

## Decisions

The owner locked eight decisions on 2026-09-18; the table below records them.

| Decision               | Choice                                                                                                                                                                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Notice sequencing      | Stage the outbox row before the response, attempt inside `after()`; never put the stage in `after()`. Netlify backs `after()` with `waitUntil` (full support), so the rule is about the 60-second ceiling and request scope, not dropped work. |
| Document model         | A row at upload time with an owner column, an ACL'd download route, and a seven-day sweep of unlinked rows; the schema change lands now because the freeze is the launch gate.                                                                 |
| Shrinking availability | Allowed and reported (`uncoveredUpcoming`); the type switch stays a hard block, now atomic and trial-aware.                                                                                                                                    |
| The EXPERT dead end    | Solved by the wizard's add mode, not by a placeholder profile.                                                                                                                                                                                 |
| The NEEDS_INFO loop    | Three answered rounds, structured reason codes, unflagged documents carry over, a day-7 reminder and a day-14 close.                                                                                                                           |
| Storage                | 40 MB per user, five outstanding uploads, magic-byte sniffing, no new dependency.                                                                                                                                                              |
| Train shape            | Serial merges into `dev`; only `dev`-based pull requests receive CI and review here, so the follow-on PRs are opened against `dev` after the first three merge rather than stacked.                                                            |
| #698                   | OB-1 and OB-3 ride the train; OB-5 waits for product analytics.                                                                                                                                                                                |
