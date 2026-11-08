---
title: Growth — The Newsletter and Announcements
type: explanation
status: live
last-reviewed: 2026-11-08
---

# The Newsletter and Announcements

This page explains how a person joins the newsletter, how their consent is recorded, how an administrator sends to a chosen audience, how a person leaves, and how announcements differ. The email machinery itself (the outbox, retries, webhooks and DNS) is in [the email architecture](../email/README.md) and is not repeated. Behaviour that is not on `dev` yet carries the tag `#2655` for #2655 "Growth: rename the newsletter list, derive link keys, one consent ledger, segmented broadcasts".

## Joining: double opt-in

1. A visitor enters an address in the footer form. `POST /api/newsletter` is rate limited to 3 tries an hour per IP (`newsletterLimiter` in `lib/rate-limit.ts`) and shows the purpose notice `NEWSLETTER_NOTICE` (`lib/newsletter/notice.ts`). **(after #2655)**
2. `subscribe()` (`lib/newsletter/service.ts`) writes a `NewsletterSubscriber` row as `PENDING` and sends a confirmation email. It does not reveal whether the address was already subscribed, so the public route cannot be used to probe membership. If links cannot be signed (see below), it fails the same way for every address before it looks anyone up.
3. The visitor clicks the link. `confirmSubscription()` verifies the signature and the age of the link (48 hours, `CONFIRM_TOKEN_TTL_MS`) and then, in one transaction, sets the row to `SUBSCRIBED` and writes the consent record. A welcome email follows.
4. A previously unsubscribed address that signs up again goes back to `PENDING`, not straight to `SUBSCRIBED`. Re-consent must be a fresh click.

Double opt-in is kept although no Indian source found for [the research page](./04-market-research-india-first.md#dpdp) requires it. It is the evidence the DPDP Act asks for, and it protects sender reputation because nobody can add someone else's address. The enforcer is the status machine: only `confirmSubscription()` moves a row to `SUBSCRIBED`, apart from the account consent switch described next.

A signed-in account has one marketing control, its `MARKETING_COMMS` consent in settings. Granting it subscribes the account's verified address in the same transaction as the consent record with no confirmation email, because the authenticated grant is itself the evidence. Withdrawing it unsubscribes every row linked to the account (`subscribeForMarketingConsent`, `unsubscribeForWithdrawnConsent` in `lib/newsletter/consent-link.ts`).

## The consent ledger

The newsletter does not keep its own record of agreement. Every confirmation writes a `ConsentArtifact` for the purpose `MARKETING_COMMS`, stamped with `NEWSLETTER_NOTICE_VERSION` so a later change of wording is a new version. **(after #2655)**

- If the confirmed address belongs to an account, the artifact is linked to that account and the row's `userId` is set. The account is found from the confirmed address itself, never from a stored id that might not own it.
- Otherwise the artifact is **pseudonymous**: it carries a `subjectPseudonymousId`, an HMAC of the normalised address (`newsletterSubjectId`), so the address itself is never stored on the artifact. The id is copied to the row's `consentSubjectId` at confirmation, and every later withdrawal and erasure reads it back. Rotating `BETTER_AUTH_SECRET` therefore cannot orphan the artifact. The id is recomputed only for a row that has none.
- A live artifact for the same subject is reused, so a repeat confirmation writes no second one.
- The sign-up IP is stored only as a keyed hash (`hashIp`), under its own key label, so it cannot be reversed from the IPv4 space.

**The lock order.** Every path that withdraws consent first row-locks the matching `NewsletterSubscriber` rows (`lockNewsletterRows`) and only then writes `ConsentArtifact` rows. The paths are the newsletter unsubscribe, the Resend webhook, the account consent withdrawal and erasure. One order means concurrent withdrawals cannot deadlock, and a confirmation racing a withdrawal is seen rather than missed, because the lock returns the linkage as committed after the lock. The enforcer is the shared helper itself; a new withdrawal path must call it.

**Retention against erasure.** A withdrawn artifact is kept as audit evidence until `auditRetainedUntil` and the weekly consent retention sweeper is the only path that deletes it. How long to keep it against a request to erase is a question for the compliance session; see [the roadmap](./05-roadmap.md).

## Signed links

Every emailed link that works without a login is a signed token: newsletter confirm and unsubscribe, account email unsubscribe, calendar links and support requester verification. **(after #2655)**

- `signToken(purpose, subject, issuedAt)` in `lib/auth/link-signing.ts` is an HMAC-SHA256 over `purpose|subject|issuedAt` using a key **derived from `BETTER_AUTH_SECRET`** under the fixed label `familiarise/link-signing/v1`. There is no separate link secret.
- Each link binds its purpose, so a confirm token never verifies as an unsubscribe token. The enforcer is `safeEquals`, a constant-time comparison.
- Confirm links expire after 48 hours. Unsubscribe links never expire, because an unsubscribe link in a two-year-old email must still work and the one-click header relies on it.
- Because the key comes from the auth secret, rotating the auth secret voids every link already sent. The invalid-link page therefore sends the reader to their account settings.
- `canSignLinks()` is checked before any lookup. If `BETTER_AUTH_SECRET` is missing or shorter than 16 characters, the sign-up answers the same failure for every address.

## Broadcasting

The back-office Newsletter page (`components/admin/NewsletterManagement.tsx`, permission `newsletter.manage`, administrators only) posts to `POST /api/admin/newsletter/broadcast`. The body is validated by a Zod schema with four modes. **(after #2655)**

| Mode      | What it does                                                                                               |
| --------- | ---------------------------------------------------------------------------------------------------------- |
| `preview` | Counts only: how many confirmed subscribers match, how many are suppressed or held, how many are sendable. |
| `test`    | Sends to the calling administrator's own address, through the same suppression check and guard.            |
| `warmup`  | Sends to the `limit` most recently confirmed sendable subscribers, newest first.                           |
| `all`     | Sends to every sendable subscriber in the audience, in signup order.                                       |

**Segments.** An audience filter (`broadcastAudienceSchema` in `lib/newsletter/broadcast-audience.ts`) narrows the `SUBSCRIBED` rows by `sources`, by `tags` (a match on any given tag) and by `role`: `EXPERT` is a linked account with a consultant profile, `LEARNER` is a linked account without one, and `NO_ACCOUNT` is a row with no `userId`. The page keeps every send button off until a preview of the current filters has settled, and the confirmation quotes that preview's count.

**The 2,000 refusal.** One request sends every batch itself, so it must fit in one function run. A send whose sendable audience is above `BROADCAST_AUDIENCE_LIMIT` (2,000) is refused with `422 AUDIENCE_TOO_LARGE`. The remedy is a narrower audience or a warm-up send.

**Batches and keys.** Recipients are sent in batches of up to 100 through Resend's batch API. Each batch is a `FailedEmailBatch` row **before** the request goes out, with an idempotency key derived from its content (`NEWSLETTER_BROADCAST/<digest>`). A lost response or failed send is replayed by the relay under the same key. In `all` mode the audience is ordered by signup (`createdAt`, then `id`), so a re-sent broadcast that gained a new subscriber keeps every earlier full batch, and its key, unchanged. The newcomer joins the last batch, and if that batch was partial its content and therefore its key change, so a re-send delivers the message again to everyone already in that batch. Only `warmup` orders by confirmation time. A `test` send carries a one-time nonce so a repeat test really sends.

**What is skipped.** Before sending, the route drops addresses in `EmailSuppression` (a bounce or complaint not yet reflected in the subscriber status) and addresses the pre-launch guard holds (`heldRecipientDomain`). Both counts are returned.

For example (illustrative numbers), 1,200 confirmed subscribers exist, 700 of them with a learner account and 150 tagged `launch`. An administrator previews `role: LEARNER, tags: ["launch"]`, sees `matching: 90`, sends a `test` to themselves, runs a `warmup` of 25, and then `all`. The `all` send is one batch of 90 recipients, one `FailedEmailBatch` row.

## Leaving

Every message carries an unsubscribe link in the footer and the one-click headers `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058), which Gmail and Yahoo require of bulk senders. **(after #2655: the link signing and the consent withdrawal; the headers are on `dev`)**

- `GET /api/newsletter/unsubscribe` shows a confirmation page with a form and **never changes a row**, so a link scanner that prefetches the link cannot unsubscribe anyone. Only `POST` changes state.
- The `POST` sets the status to `UNSUBSCRIBED`, withdraws the `MARKETING_COMMS` consent (the linked account's and the pseudonymous subject's) in the same transaction, and always reports success for a valid token, so it cannot leak membership. If the transaction fails the page says "We could not unsubscribe you" with a 500, never "You are unsubscribed".
- A bounce, a complaint or a Resend contact deletion also unsubscribes through the Resend webhook (`app/api/webhooks/resend/route.ts`), in the same transaction that records the event.

## The two sending subdomains

Transactional email (receipts, security, bookings) is sent from `mail.familiarisenow.com` and the newsletter from `news.familiarisenow.com` (`EMAIL_TRANSACTIONAL_DOMAIN`, `EMAIL_NEWSLETTER_DOMAIN` in `lib/company.ts`; `SENDERS` in `lib/email/config.ts`). The split exists so that a spam complaint about a newsletter harms the bulk sender's reputation, not the reputation of a payment receipt. Each subdomain has its own DKIM, SPF and bounce records; the record details are in [the email architecture](../email/README.md).

## The pre-launch guard

`EMAIL_DELIVERY_MODE` decides who may receive mail. Unset or `allowlist`, it sends only to our own domain and `EMAIL_ALLOWLIST`; only `live` sends to everyone. Production stays on the allowlist until launch, so the faker addresses in the shared seed data can never be mailed. Setting `live` is an owner step in [the roadmap](./05-roadmap.md). The enforcers are `deliver()` for single sends and `heldRecipientDomain()` for the broadcast batch; a held single message is stored as `DEAD_LETTER` with `held:pre-launch`.

## Sending volume

The Resend free plan stops at 100 emails a day, so a broadcast to more than that cannot run on it. At go-live the account moves to the owner-selected paid plan (recorded in Notion). Gmail expects SPF, DKIM, a DMARC policy aligned with the From domain, a spam rate under 0.3 % and one-click unsubscribe from senders above 5,000 messages a day. Yahoo asks the same of bulk senders but publishes no volume threshold, so the broadcast meets these rules on every send, whatever its size (see [the research page](./04-market-research-india-first.md#gmail-and-yahoo-bulk-sender-rules)).

## Announcements versus the newsletter

| Question                | Announcement                                                                   | Newsletter                          |
| ----------------------- | ------------------------------------------------------------------------------ | ----------------------------------- |
| What is it              | A product or service notice                                                    | Marketing email                     |
| Who gets it             | Account holders                                                                | Confirmed subscribers who consented |
| Channels                | The site banner and, if ticked, an in-app bell                                 | Email only                          |
| Needs marketing consent | No                                                                             | Yes (`MARKETING_COMMS`)             |
| Where it is written     | `components/dashboard/shared/AnnouncementsPage.tsx`, `POST /api/announcements` | The Newsletter back-office page     |

An item meant for both audiences is written once and sent twice, each under its own rule. "Both" means two sends, never one send with two rules. Announcements get no email channel, because a second marketing path would need its own guard and consent check. The enforcer on the announcement side is bell policy (`bellAudience` in `lib/novu/policy.ts`), which respects each user's switches, and the audience ceiling of 2,000 users (`MAX_BELL_AUDIENCE`). The notification family label for announcements no longer says "No opt-out", because announcements follow the in-app switches. **(after #2655)**

## Lifecycle email

Two lifecycle emails exist: the confirmation and welcome emails (`emails/newsletter/`, after #2655), and the launch broadcast, which is simply the first `all` send. Re-engagement email, which would nudge subscribers who stopped opening, waits until after launch; see [the roadmap](./05-roadmap.md).

## Resend Broadcasts as a later option

Resend can host the list and send a broadcast itself (Contacts, Segments and Broadcasts; priced by contacts, see [the research page](./04-market-research-india-first.md#resend)). The trade-off is that the list then exists twice, once in our database and once at Resend. An erasure request has to reach both, and consent and suppression have to be kept in sync across the boundary. The platform keeps its own send path today so that consent, suppression and erasure stay in one database. The platform does not subscribe to `contact.*` Resend events for this reason. Move only if the list grows beyond what our own path can send in one run.

## The next step past 2,000

The campaign outbox is #2508 "Newsletter system design v1" and is **planned**: a ticker-driven outbox that stages a campaign as rows and sends them over several runs, so a list above 2,000 is sendable and a send survives a restart. Until it exists, the 2,000 refusal is the guard.

## Where in code

`lib/newsletter/**`, `lib/auth/link-signing.ts`, `app/api/newsletter/**`, `app/api/admin/newsletter/**`, `app/api/webhooks/resend/route.ts`, `app/api/user/privacy/consent/route.ts`, `emails/newsletter/` (`emails/waitlist/` until #2655), `lib/email/unsubscribe.ts`, and the erasure footprint in `lib/compliance/erasure/mail-footprint.ts`.

## Related issues

- #2508 "Newsletter system design v1".
- #2562 "Consent-gated marketing path".

## Deprecated & Superseded Approaches

- **`/api/waitlist/*` and the `WAITLIST_*` names.** Routes, templates, senders, email types, the rate limiter, the erasure field and the seed module for the newsletter list all used "waitlist". All were renamed with no alias, because no newsletter email had been sent. Delete any reference that remains.
- **`WAITLIST_HMAC_SECRET`.** A separate secret for newsletter links, with no fallback. It is replaced by the derived key; the owner deletes the variable after the release.
- **Confirmation without a consent record.** The first double opt-in changed the row status but wrote no `ConsentArtifact`, so there was no evidence of what the person agreed to. It now writes the artifact.
- **A `GET` unsubscribe that changed the row.** Link scanners triggered false unsubscribes. The `GET` now only shows a page.
- **The `marketingEmails` switch.** The notification panel once had a marketing switch that nothing read. `MARKETING_COMMS` consent now drives the subscriber row directly. Delete any new reader of the column.
- **Whole-list broadcasts.** The first broadcast sent to every subscriber with no filter, test, preview or ceiling. Segments, the test and warm-up modes and the 2,000 refusal replace it.
