# Notification system

Familiarise uses Resend for email and Novu for the in-app inbox. Novu's sixteen workflow families contain in-app steps only. Push delivery is not implemented; no push control is offered.

## Delivery flow

Business producers prepare recipient-specific content and stage durable rows in Postgres. Where a producer owns a transaction, it passes that transaction client through policy reads and outbox writes. Network attempts run after commit through `flushNotificationsAfter`; the cleanup registry's email and bell relays finish pending work on the active platform ticker.

| Channel                      | Durable state                                | Attempt and recovery                                                          |
| ---------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------- |
| Transactional email          | `FailedEmail`                                | `lib/email/deliver.ts`, then `retry-failed-emails`                            |
| Newsletter batches           | `FailedEmailBatch`                           | Admin waitlist broadcast, then the same email relay                           |
| In-app inbox                 | `NotificationOutbox`                         | `lib/novu/outbox.ts`, then `drain-notification-outbox`                        |
| Subscriber preference mirror | Pending revision on `NotificationPreference` | Existing notification relay, current snapshot and conditional acknowledgement |
| Enterprise customer webhooks | `OutboundWebhookDelivery`                    | Enterprise webhook worker; separate from user notifications                   |

Rendering uses React Email once per recipient and derives a plain-text part. Email rows preserve rendered content; credential messages store a redacted body and are never replayed by the relay. A fresh credential must be requested if its inline send did not succeed.

An outbox row proves staging, and a provider response proves acceptance. Neither proves inbox delivery or human acknowledgement. Resend callbacks persist delivery events and enforce permanent-bounce and complaint suppression.

## One place to manage delivery

Settings → Notifications & emails owns the optional master, email/in-app channels, service categories, routine inbox quiet hours and marketing email consent. Turning the master off keeps saved choices visible and disabled. Marketing consent can still be withdrawn. Required account/security email remains an exception; old inbox history and unread counts are not deleted. Cookie permissions remain under account Privacy. Privacy consent rows show purpose status and link to the relevant control.

The bell renders the notification feed and a role-aware settings link. It does not mount Novu's independent preferences/schedule editor. Novu's weekly Schedule applies to its other channel steps, not ordinary in-app steps or the direct Resend channel. Familiarise owns routine inbox timing through recipient-specific `notBefore`.

Existing native Novu inbox restrictions can still veto delivery. The unified page reads and displays those restrictions. Only an account-owner confirmation may replace them: sync current Familiarise subscriber data, enable only the owned in-app global/workflow preferences, then verify the provider read-back. No automatic reset runs during subscriber sync, and no email channel, schedule or unrelated workflow is changed. Failed reads/writes remain visibly unconfirmed.

The cookie banner and Privacy form share one API/cache. Cookie flags and current account ANALYTICS evidence commit in the same transaction. Anonymous browser choices are not inherited as account consent. Identity loading and late responses cannot borrow another identity's cached choices. A failed save does not dismiss the banner or write its acknowledgement. Optional cookie-using analytics/advertising integrations were not found in the app source; saving these permissions does not configure a vendor.

| Endpoint                           | Caller payload and effect                                                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PUT /api/novu/preferences`        | Explicit channel/category/quiet-hour fields or `marketingEmails`; current settings, purpose evidence and mirror revision commit together.                                      |
| `GET /api/novu/preferences/inbox`  | Current authenticated verified user's native inbox restrictions; no write.                                                                                                     |
| `POST /api/novu/preferences/inbox` | `{useFamiliariseSettings:true}` after explicit confirmation; changes only this user's owned in-app restrictions and verifies them. Caller-selected subscriber IDs are refused. |
| `PUT /api/cookie-preferences`      | `analytics` and/or `marketing` booleans; server chooses authenticated account or opaque anonymous identity. Essential cookies remain enabled.                                  |

## Preferences and recipient safety

Postgres `NotificationPreference` is the authority. Preference/routing/consent changes atomically mark a pending subscriber revision. The existing notification relay rereads current data, retries failed mirrors and conditionally clears only the acknowledged revision. Novu subscriber data mirrors the settings for its workflow conditions; it is not the email preference source. The React Inbox requires a successful subscriber-sync response with a valid HMAC. Failed or malformed responses show an unavailable/retry bell, never an unsigned session. Vendor-side HMAC enforcement must also be enabled; the client check does not protect a publicly callable vendor endpoint by itself.

- Optional email obeys master, email, category, and workspace routing settings. Required notices (`category: null`) bypass optional switches and workspace email routing.
- Bells obey master, in-app, category, and workspace routing settings. Unknown recipients are excluded. Failed policy reads never authorize a send; transactional failures propagate, while the nontransactional service returns failure.
- Routine bells honor quiet hours; security changes, actionable payment/refund/payout failures, disputes opened, and compliance deadlines bypass quiet-hours deferral. Other preference switches still apply.
- Enabling quiet hours persists the displayed start, end and timezone. New targeted deliveries stage one stable row per unique eligible recipient, with that recipient's quiet-hours end. Another recipient's settings cannot change its identity or delivery floor.
- Email suppression is checked at staging and again before inline delivery; the relay also checks it.
- Recipient-aware email stores explicit user/category context in nullable `FailedEmail.deliveryPolicy`. Inline attempts and retries re-read the current account, address, category and workspace policy; required notices bypass optional switches but never recipient identity checks. Temporary read failures leave durable work pending. Older rows and direct-address mail lack this context and retain their existing policy.

- Newsletter sends and retries check subscription, suppression and matching account preferences. Existing accounts require marketing, master and email switches enabled plus current Familiarise marketing-purpose evidence; a missing preference row uses the displayed marketing-off default. Confirmed subscribers without an account remain eligible. If any staged recipient becomes ineligible, the whole batch is dead-lettered with `batch audience changed: consent, preferences or suppression`; its stored payload/key pair is never modified.
- Every email passes the pre-launch delivery guard, including batch replay. No audit or test should send real messages to seeded addresses.

The delivery-policy column and two nullable subscriber-sync markers plus their pending-time index are additive work in this PR. The human-run schema rollout must precede deployment of its reader/writer; the audit did not change the shared database.

## Idempotency and recovery

Email attempts use a row-scoped idempotency key. Bell rows use a deterministic event/recipient/payload key, or an explicit event identity supplied by the producer; the wire request carries it as the provider's idempotency header. A legitimate repeated business event must have a distinct identity. Failed payouts retain their payout ID for this reason.

The flush helper attempts each staged bell row once per invocation even if a multi-recipient result repeats it. The initial retry grace window prevents routine inline/relay overlap; registry jobs use the Postgres cron lease.

Provider deduplication is time-limited. An extended outage or manual replay after that window can duplicate a previously accepted request. Local SENT state is authoritative; durable staging alone does not provide exactly-once external delivery.

## Announcements and marketing

Public banners return only currently active announcements. The authenticated management feed (`?view=manage`) returns up to 100 recent records, including drafts, scheduled and expired announcements, with private/no-store caching. The admin form validates its local-time schedule and API responses; rejected writes keep the form open instead of showing success.

Creating an active announcement stages a publication in its business transaction. Future publications use the existing outbox's `notBefore` floor and relay; there is no separate activation job. Edits replace an unsent revision, and deactivation/deletion cancels queued rows in the same transaction. A recorded send is not broadcast again by ordinary edits. Before delivery, the sender checks the source record, revision, content, links and date window. Expired, deleted or superseded work becomes an expected terminal cancellation without bug alerts or an operator-recovery entry.

Provider-accepted and in-flight notices cannot be recalled atomically. The deletion dialog makes that limit explicit. Older queued announcement payloads without source/revision context require operator review rather than an unverified broadcast.

Waitlist newsletters use confirmed waitlist subscriptions and separate newsletter sending identities. Account switches can veto delivery but cannot subscribe an address or replace double opt-in. Account settings and personal privacy controls update the marketing switch and current purpose evidence in one transaction. Withdrawal also unsubscribes current matching waitlist enrollment. Granting creates no enrollment or cookie permission. Cookie preferences and confirmed newsletter membership keep their separate purposes. Old bundled consent artifacts are not migrated. Confirmation checks the current PENDING status and exact signup revision, so withdrawn or stale links cannot restore a subscription.

The public announcement bar is a date-filtered site surface with browser-local dismissal by announcement ID. Closing it does not mark a bell read, unsubscribe email or hide maintenance banners. Maintenance banners follow the maintenance provider's state, independently of communication preferences. General announcement bells obey master/in-app/routing switches, but have no marketing category: do not use that operational workflow as a promotional audience.

## Collaborator and referral journeys

Invite/reactivate, accept/decline, remove/withdraw and expiry stage email/bell work with their collaborator transition. Forced departures through moderation, erasure and enterprise membership removal use the same transaction-local helper; bulk paths leave delivery to the existing relay. Expiry repeats its stale timestamp condition so a freshly resent invitation cannot be expired by an older scan. Lifecycle identities include the collaborator ID, event and current revision.

Referral application stages an eligible welcome-discount explanation, vesting stages the earned reward, and confirmed checkout/capture stages credit redemption. Reward identities use the referral ID; redemption identities use the payment ID. Normal gateway checkout does not announce a redemption before capture. Staging uses the supplied transaction for policy reads and outbox writes. Failed staging propagates so its owning transaction can retry.

## Clawback payee journey

Both consultant clawback writers, organisation share clawbacks, next-payout recovery, failed/cancelled/reversed recovery release and originating-payout voiding stage bell and email work only when their existing journal insert is new. Journal identity distinguishes events and recipients; repeat ledger calls stage nothing. Recipient reads and both outboxes use the journal's transaction. Staging/rendering failures propagate to prevent a journal committing without its notice obligation. No provider call runs there.

The recipient is the consultant profile's user or the existing active organisation finance visibility roster (owner, maintainer, manager). Existing payments/org-billing preferences and workspace routing apply. The two event IDs use existing payout and org-billing Novu families. A reserved offset is described as pending payout preparation; release means the debt remains owed, and voiding describes only the unrecovered slice. The original money arithmetic, ledger keys and payout transitions are unchanged. Old journals are not backfilled.

## Recovery and replay

Immediately before a targeted bell attempt, the current account, soft-erasure state, category and workspace routing are read again. A revoked single recipient cancels only its row. Older shared rows with a partially revoked audience stop with `review:audience_changed`, preserving the original payload/key and owed recipients for manual review. Entirely revoked audiences are expected cancellations. Temporary read failures retain pending work. Quiet-hours floors stay fixed after staging.

Email and bell attempts stop automatic replay once the conservative 24-hour provider window has elapsed. The lower bound is row creation, or its later scheduled due floor for bells; it is not a recorded first wire attempt. Consequently an old row that never reached the provider may also require review. A stored Resend receipt is acknowledged without another send. Stable keys protect only within the provider contract, and Novu organization-level idempotency enablement still needs evidence.

The failed-email recovery door requires an operator reason, writes an audit with its compare-and-set mutation, and refuses credential bodies, pre-launch holds, prior receipts, policy cancellations and expired/invalid replay timestamps. It checks current account policy and suppression in the same transaction. Manual review means inspecting provider evidence and choosing an appropriate fresh business action; there is no force-resend switch.

A request/post-commit bundle starts at most five bell attempts. Remaining staged rows use the existing relay; its ten-minute cadence (at UTC minutes ending in 5) means staging is not an immediate delivery guarantee. Nontransactional helpers open a short staging transaction and never send if persistence fails. Broadcast announcements retain their source/revision check. Per-recipient staging uses more rows and writes than the former shared audience row.

## Operational ownership

Sentry owns code failures; Better Stack owns uptime, freshness and backlog incidents. The email backlog gauge includes both individual and batch outboxes. Renderer failures are aggregated once per fan-out rather than reported per recipient. The ops chat mirror is optional; do not assume it is provisioned.

Active/standby scheduler selection uses the existing Upstash key, while cron mutual exclusion uses Postgres. Keep Netlify failback configuration alongside any active host. Vendor credentials, alert routes and DNS authority require live verification.

## References

- [Journey audit, findings and verification](07-journey-audit.md)
- [Workflow and API reference](02-workflows-and-api.md)
- [Template specifications](03-novu-template-specs.md)
- [Schema reference](06-schema-reference.md)
- [Pre-production checks](05-pre-production-checklist.md)
- [Email delivery](../email/README.md)
- [Observability ownership](../observability/01-ownership-sentry-betterstack.md)
- [Domains and DNS](../deployment/README.md#domains-and-dns-records)
- [Permanent tracking issue](https://github.com/Practitionist/familiarise_web/issues/2589)

Subscriber synchronization provisions verified accounts only. Unverified revisions remain pending until verification; the worker and pending-age signal exclude them while waiting. This preserves the auth lifecycle's verified-address boundary.

## Deprecated & Superseded Approaches

The former landing page mixed historical audit diagrams, target architecture and current behavior. Use code, this overview and dated verification evidence together. Earlier per-event Novu workflows were replaced by family templates; Novu email/push arrows do not describe active delivery. Sentry traces/logs/metrics are not the operational backlog alert owner.
