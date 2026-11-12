# ADR: Growth — the appointment waitlist, the newsletter and announcements, and referrals

- **Status**: Accepted (owner decisions, 2026-11-08). Items marked **(planned)** are built by the pull requests named beside them; each pull request flips its own lines when it merges.
- **Date**: 2026-11-08
- **Author**: Platform engineering
- **Related**: [A notify-me list for sold-out webinars and classes](2026-11-07-event-seat-waitlist.md), [Notification preferences have one owner](2026-11-06-notification-single-preference-owner.md), [Booking v2 direction](2026-11-03-booking-v2-direction.md), `docs/referrals/03-reward-economics-and-decisions.md`, `docs/email/README.md`, `docs/prisma/02-schema-freeze-and-migration-cutover.md`

## Context

Three parts of the product grow the platform: the appointment waitlist (a learner queued for a seat on a sold-out webinar or class), the newsletter and announcements, and referrals. They share consent, email and in-app delivery, and platform-funded credits, yet they had no subsystem document and one overloaded word. "Waitlist" meant both the pre-launch email list and the sold-out queue, so the newsletter table was still called `"Waitlist"` in Postgres next to `AppointmentWaitlist`.

A read of the code and the live database on 2026-11-08 found the following. The appointment waitlist works as its 2026-11-07 record describes. The plan editor writes the plan's capacity onto every event it saves, which pins a per-event override that later plan edits can no longer reach. A host sees how many people wait only on one event's participants page. The 1:1 slot backup-interest list has no purge and no re-notice. The newsletter confirmation writes no consent record, and the newsletter signing secret also signs calendar, support and account-unsubscribe links. The referral engine is complete but switched off (a monthly budget of zero), and it has no same-payer, device or review-queue controls.

The platform is pre-launch: every newsletter, waitlist and referral row is seed data, and no newsletter email has been sent.

## Vocabulary

One word per concept, in code, copy and docs.

| Concept                                                    | Term                                                   | Model                  |
| ---------------------------------------------------------- | ------------------------------------------------------ | ---------------------- |
| People who asked for product news and launch email         | **newsletter subscribers** (the newsletter list)       | `NewsletterSubscriber` |
| A learner queued for a seat on a sold-out webinar or class | **appointment waitlist** (the button says "Notify me") | `AppointmentWaitlist`  |
| A learner asking to be told when a 1:1 window frees        | **slot backup interest**                               | `WindowBackupInterest` |

## Decisions

### Part 1: the appointment waitlist

1. **Notify everyone; the first to pay gets the seat.** The 2026-11-07 model stays: no queue position, no reservation and no claim window. No Indian ticketing or creator platform publishes a stronger standard, and a reserved seat needs an offer timer, a re-offer sweep and a hold that blocks the seat while a waiter ignores the email. Ordered offer waves are reconsidered only if the monthly conversion read-out or learner complaints show waiters losing races; rows are already ordered by `createdAt`, so no migration is needed. **(planned: post-launch trigger)**
2. **Capacity is normalised on the server.** The webinar and class `crud-with-plan` PATCH routes write no per-event override (`null`) when the submitted capacity equals the plan's, and an override only when it differs. The editor loads the event's effective capacity. Pre-launch rows are seed data, so there is no backfill. **(shipped)**
3. **Hosts see demand where they decide capacity.** "N waiting" appears on the planner and offering event cards and beside the capacity field in the editor, and switching the list off first says how many open entries will expire. Hosts see counts only, never names. **(shipped)**
4. **Two tables, one shared interest module.** `AppointmentWaitlist` is keyed on a group event's roster and `WindowBackupInterest` on an expert's time window, so their matching queries differ (an equality on the appointment against a time-range overlap), and booking v2 keeps 1:1 and group bookings apart. They keep separate tables and share one module for statuses, the 12-hour re-notice and the 30-day purge, one "Notify me" component, one learner "My alerts" list, and one read-only `demand` SQL view over both, with no user ids, for analytics and ranking. Both tables carry the same lifecycle columns, so a later merge stays cheap if a real need appears. **(shipped)**

### The rename

5. **Every legacy newsletter name moves, with no aliases.** `/api/waitlist/*` becomes `/api/newsletter/*`, the admin routes and back-office path follow, the email templates, senders and email types become `NEWSLETTER_*`, and the rate limiter, erasure field, footer copy and seed module are renamed. No old route is kept, because no newsletter email exists in the wild. **(shipped in the newsletter pull request)**
6. **The Postgres table and enums are renamed now.** `"Waitlist"`, `"WaitlistStatus"` and `"WaitlistSource"` become `"NewsletterSubscriber"`, `"NewsletterStatus"` and `"NewsletterSource"`, and the dead source `EVENT_SOLD_OUT` is dropped. One Postgres project serves dev and prod, so the owner runs the reviewed `RENAME` script and `npm run db:push` immediately before promoting the release that carries the code; prod's newsletter and consent writes fail only for that gap. **(shipped in the newsletter pull request; the owner runs the SQL at release)**
7. **No separate link-signing secret.** `WAITLIST_HMAC_SECRET` is deleted. Newsletter confirm and unsubscribe, account email unsubscribe, calendar links and support requester verification are signed with a key derived from `BETTER_AUTH_SECRET` under a fixed label, the pattern the referral own-link token already uses, and the consent IP hash uses its own label. Rotating the auth secret now also voids old links, so the invalid-link page points the reader to their account settings. **(shipped in the newsletter pull request)**

### Part 2: the newsletter and announcements

8. **One consent ledger for everyone.** Every newsletter confirmation writes a `ConsentArtifact` for `MARKETING_COMMS` with the notice version, linked to the account when the email matches one and to a pseudonymous subject otherwise. Every unsubscribe, complaint or withdrawal withdraws it, and a broadcast reads the ledger: a subscriber is mailed only while it holds a live `MARKETING_COMMS` artifact (`withLiveMarketingConsent`), and the others are counted as `skippedNoConsent`. Double opt-in stays: Indian law was not found to require it, but it is the evidence the DPDP Act asks for and it protects sender reputation. **(shipped in the newsletter pull request)**
9. **Resend Pro at go-live, our own send path.** The account moves to Resend Pro at go-live because the free plan stops at 100 emails a day. The newsletter keeps sending through our own batch path, so consent, suppression and erasure stay in one database with no copy of the list in Resend. The broadcast gains an audience filter (role, source, tags) with a count preview, a test send and a warm-up send to the most recently confirmed subscribers, and it refuses an audience above about 2,000 recipients; a ticker-driven campaign outbox is the next step at that size. Moving the list to Resend Broadcasts stays a documented later option. **(shipped in the newsletter pull request)**
10. **Announcements and the newsletter stay separate.** An announcement is a product or service notice for account holders (the site banner and an in-app bell) and needs no marketing consent. The newsletter is marketing email and goes only to subscribers with consent. An item meant for both is written once and sent twice, each under its own rule, and announcements get no email channel. **(shipped: the newsletter pull request fixed the notification family label that said "No opt-out")**
11. **Lifecycle email.** The welcome email and the launch broadcast exist; re-engagement email waits until after launch.

### Part 3: referrals

12. **What is on at launch.** Both expert programmes start on: an expert's own link (a lower platform fee on that expert's sales to the learners it brings) and expert-to-expert referral (fee-free sessions for both experts); neither costs cash. Learner-to-learner referral (a welcome discount for the friend and a platform credit for the referrer) starts on with a capped monthly budget, reviewed after 60 days of booking data. The budget figure is kept in Notion, not in this repository.
13. **Cheap fraud controls before learner referral goes live.** Disposable domains are refused when a code is applied, and email aliases are normalised only for the self-referral check; a vest is voided when the referrer and the referee paid with the same UPI address or phone (card comparison is not built); a hashed IP and user agent are stored on the referral; suspicious vests wait in a "held for review" state with an admin queue; and the code-customise and expert-link routes are rate-limited. No paid device-fingerprinting vendor is added until abuse appears. Review thresholds are configuration, and their values are kept in Notion. **(shipped)** Card comparison and alias-aware matching beyond the self-referral check stay out of scope.
14. **A lost chargeback after vest voids what is left.** When the dispute on the friend's qualifying payment is lost, the unspent part of the referrer's credit is voided through the existing reversal posting, and any part already spent is absorbed. **(shipped)**
15. **Attribution precedence is unchanged.** An expert's own link still wins over a learner referral for that expert's sales, as decided on 2026-10-04.

### Cross-cutting

16. **Where the knowledge lives.** `docs/growth/` holds the subsystem documents and `.claude/skills/growth/` the playbook; `docs/referrals/` stays and is refreshed. **(shipped)**
17. **The repository holds mechanisms; Notion holds levers and intelligence.** Code, docs and skills carry how things work, the invariants, configuration field names and the terms a user sees on screen. The owner's Notion workspace ("Familiarise / Growth & Marketing") holds the referral budget, fraud thresholds, vendor costs and plan choices, growth targets, detailed competitor research and the conversion read-outs. A document that needs one of those values says it is in Notion.
18. **Delivery order.** The newsletter pull request lands first (the widest rename, the schema rename, the link key and consent, the go-live blockers), then the appointment waitlist, then the referral money work with a second review round, then the documentation. Each code pull request updates the docs and skills that describe the code it changes.
19. **The migration cutover comes last.** Moving from `db push` to versioned, CI-applied migrations, with a Supabase-aware runbook and a rehearsed expand-and-contract step (dropping the unused referral statuses and reward columns), follows the coding work. **(planned)**

## Alternatives considered

| Alternative                                                             | Why it lost                                                                                                                         |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Ordered offer waves or a reserved claim window for waiters              | Needs an offer timer and a re-offer sweep; a waiter who never answers blocks the seat. Kept as a post-launch option behind data.    |
| Merging `AppointmentWaitlist` and `WindowBackupInterest` into one table | The two match differently, every query would branch on kind, and the merge rewires about 18 release hooks during the schema freeze. |
| Keeping old `/api/waitlist/*` routes as aliases                         | No email carrying them has been sent, so an alias would only be dead code.                                                          |
| Keeping the `"Waitlist"` table name behind `@@map`                      | Leaves the collision in every SQL console; renaming is cheapest before launch.                                                      |
| A dedicated `LINK_SIGNING_SECRET`                                       | One more secret on every host; deriving from the auth secret is already a pattern here.                                             |
| Moving the newsletter to Resend Contacts and Broadcasts now             | A second copy of personal data that erasure must reach; revisit when the list grows.                                                |
| Email on announcements                                                  | A second marketing-email path to guard; two sends keep each consent rule simple.                                                    |
| A device-fingerprinting vendor for referral fraud                       | Cost and a new personal-data processor before there is any abuse to stop.                                                           |
| A negative credit balance on a lost chargeback                          | A new money state for a loss capped at one reward.                                                                                  |

## Consequences

- The owner runs the newsletter `RENAME` script and `db:push` at release time, then deletes `WAITLIST_HMAC_SECRET` from Netlify after the deploy.
- At go-live the owner moves Resend to Pro, sets the referral budget from Notion and approves the launch fee schedule.
- Tax questions raised here — GST on credits and welcome discounts, TDS under section 194R on expert rewards and fee waivers, and how long consent artifacts are kept against erasure — are handed to the taxes and compliance design session.
- **Superseded in part (2026-11-11).** The referral budget and the credit and discount values are re-set by the owner; the approved values are kept in Notion (Familiarise / Growth & Marketing / Growth & Marketing Lever Register), and the configuration fields stay as named here. Resend Pro moves from "at go-live" to a purchase on a trigger. See [the 2026-11-11 levers record](2026-11-11-cfo-csmo-levers.md).

## Deprecated & Superseded Approaches

- **"Waitlist" as the name of the newsletter list.** The pre-launch email list was called the waitlist in routes, templates, email types, the rate limiter, the secret and the Postgres table. It now has one name, the newsletter.
- **The sold-out toast that captured emails into the newsletter.** Sold-out events once offered a newsletter signup (source `EVENT_SOLD_OUT`); the appointment waitlist replaced it on 2026-11-07, and the source value is dropped here.
- **`WAITLIST_HMAC_SECRET`.** A standalone secret that signed every unauthenticated link; replaced by a key derived from the auth secret.
