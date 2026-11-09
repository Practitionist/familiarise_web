---
title: Growth — Roadmap
type: reference
status: live
last-reviewed: 2026-11-08
---

# Growth Roadmap

This table lists every growth item: what shipped, what the owner does at go-live, what comes after launch, and what other design sessions own. Priority runs P0 (blocks launch) to P4 (nice to have); BS means a business-side owner step, and defer means do nothing until a trigger appears. Phase is pre-launch or post-launch. Status names the pull request that ships it (#2655, #2656 or #2657, see [the index](./README.md#which-pull-request-carries-which-code)) or the open issue. "Done when" is the check that closes the item. Budgets, thresholds and costs are never written here; they are kept in Notion (Familiarise / Growth & Marketing).

## Shipped

| #   | Item                                                                                                                                | Priority | Phase      | Status                                            | Done when                                                                                                  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1   | Newsletter rename: routes, templates, email types, rate limiter, erasure field, seed module                                         | P0       | pre-launch | shipped in #2655                                  | `rg -n "waitlist" app/api lib emails` finds no reference to the newsletter list.                           |
| 2   | Table and enum rename in Postgres (`"NewsletterSubscriber"`, `NewsletterStatus`, `NewsletterSource`), dead `EVENT_SOLD_OUT` dropped | P0       | pre-launch | shipped in #2655; the owner runs the SQL (item 9) | The reviewed rename script and `npm run db:push` have run and the app reads `NewsletterSubscriber`.        |
| 3   | Link keys derived from `BETTER_AUTH_SECRET`                                                                                         | P0       | pre-launch | shipped in #2655                                  | No code reads `WAITLIST_HMAC_SECRET`.                                                                      |
| 4   | One consent ledger: `MARKETING_COMMS` artifact on confirm, withdrawn on unsubscribe, lock order                                     | P0       | pre-launch | shipped in #2655                                  | A confirmation writes an artifact and an unsubscribe withdraws it, in tests under `__tests__/newsletter/`. |
| 5   | Segmented broadcasts: preview, test, warm-up, all; the 2,000 refusal; signup-order keys                                             | P0       | pre-launch | shipped in #2655                                  | The back-office page quotes a settled preview count before any send.                                       |
| 6   | Capacity normalisation (`capacityOverrideFor`)                                                                                      | P1       | pre-launch | shipped in #2656                                  | Saving an event at the plan's capacity stores no override.                                                 |
| 7   | Host demand counts, the shared interest lifecycle (12-hour re-notice, 30-day purge), "My alerts", the `demand` view                 | P1       | pre-launch | shipped in #2656                                  | Hosts see "N waiting"; the stale-requests job purges settled rows; `demand` exists after `db:sidecars`.    |
| 8   | Referral fraud controls, review hold, shared-payer void, chargeback void                                                            | P0       | pre-launch | shipped in #2657                                  | The held queue works and a lost dispute voids the unspent credit.                                          |

## Owner go-live steps

| #   | Item                                                                                                      | Priority | Phase      | Status     | Done when                                                                        |
| --- | --------------------------------------------------------------------------------------------------------- | -------- | ---------- | ---------- | -------------------------------------------------------------------------------- |
| 9   | Run the `RENAME` script and `npm run db:push` immediately before promoting the release that carries #2655 | BS       | pre-launch | owner step | Newsletter writes succeed on production.                                         |
| 10  | Delete `WAITLIST_HMAC_SECRET` from Netlify after the deploy                                               | BS       | pre-launch | owner step | The variable is gone and the site still signs links.                             |
| 11  | Move Resend to the owner-selected paid plan (recorded in Notion)                                          | BS       | pre-launch | owner step | The account is on the plan recorded in Notion.                                   |
| 12  | Set `EMAIL_DELIVERY_MODE=live`                                                                            | BS       | pre-launch | owner step | A non-allowlisted test address receives mail.                                    |
| 13  | Set the referral budget and the hold thresholds from Notion (`PATCH /api/admin/referrals/config`)         | BS       | pre-launch | owner step | `ReferralProgramConfig` has a non-zero budget and the hold fields are set.       |
| 14  | Approve the launch fee schedule (`fee-schedule-launch`)                                                   | BS       | pre-launch | owner step | `POST /api/admin/fee-schedules/[scheduleId]/approve` has run by a second person. |

## Post-launch, open

| #   | Item                                                     | Priority | Phase       | Status                                     | Done when                                                                                           |
| --- | -------------------------------------------------------- | -------- | ----------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| 15  | Host demand dashboard over the `demand` view             | P2       | post-launch | open, #2658                                | A host sees demand by plan and period with no names.                                                |
| 16  | Voided and expiring-soon referral notices                | P2       | post-launch | open, #2660                                | A voided referral and a credit near expiry each send a notice.                                      |
| 17  | Ordered offer waves for the appointment waitlist         | P3       | post-launch | open, #2658, only if data shows lost races | The monthly read-out shows waiters losing races and a wave is a `take` on the same compare-and-set. |
| 18  | Move the newsletter to Resend Broadcasts                 | P3       | post-launch | open, #2659, if the list outgrows our path | Erasure, consent and suppression are reconciled across both stores.                                 |
| 19  | The campaign outbox, #2508 "Newsletter system design v1" | P3       | post-launch | open, #2508                                | A list above 2,000 is sendable across several runs.                                                 |
| 20  | Re-engagement email                                      | P3       | post-launch | open, #2659                                | Inactive subscribers receive one gated nudge.                                                       |
| 21  | Vendor device fingerprinting for referrals               | defer    | post-launch | deferred until abuse appears, #2660        | Held-queue data shows abuse the cheap controls miss.                                                |

## Retention

| #   | Item                                                                      | Priority | Phase       | Status      | Done when                                                                     |
| --- | ------------------------------------------------------------------------- | -------- | ----------- | ----------- | ----------------------------------------------------------------------------- |
| 22  | #2562 "Consent-gated marketing path", which depends on the consent ledger | P2       | post-launch | open, #2562 | Retention messages send only to people with a live `MARKETING_COMMS` consent. |

## Handed to the taxes session

| #   | Item                                                                  | Priority | Phase      | Status      | Done when                                                              |
| --- | --------------------------------------------------------------------- | -------- | ---------- | ----------- | ---------------------------------------------------------------------- |
| 23  | GST on referral credits and welcome discounts                         | P1       | pre-launch | handed over | The taxes session decides and the invoice shows the answer.            |
| 24  | Section 393(1) Sl. 8(iv) (old 194R) on expert rewards and fee waivers | P1       | pre-launch | handed over | The taxes session decides whether and how tax is deducted.             |
| 25  | How long consent artifacts are kept against an erasure request        | P1       | pre-launch | handed over | The retention period and its legal basis are written in the DPDP page. |

## Last phase

| #   | Item                                                                                                                                                                                                    | Priority | Phase            | Status  | Done when                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 26  | The live-migration cutover: `db push` to versioned, CI-applied migrations, a Supabase-aware runbook and a rehearsed expand-and-contract step (dropping the unused referral statuses and reward columns) | P1       | pre-launch, last | planned | The rehearsal ran against a copy and the runbook is in [the schema docs](../prisma/02-schema-freeze-and-migration-cutover.md). |

## Deprecated & Superseded Approaches

- **A roadmap in each decision record.** The decision record keeps the owner's decisions; this page owns the status of the work. Do not add a second tracker.
- **Per-feature launch checklists.** The newsletter, waitlist and referral go-live steps are in one table above. Do not keep a separate checklist per feature.
- **The ₹500 and ₹200 cash reward plan and the `WAITLIST_HMAC_SECRET` variable.** Both are gone; item 10 removes the last reference.
