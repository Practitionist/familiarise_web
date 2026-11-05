# Notification system

Familiarise uses Resend for email and Novu for the in-app inbox. Novu's sixteen workflow families contain in-app steps only. Push delivery is not implemented; the settings control is disabled.

## Delivery flow

Business producers prepare recipient-specific content and stage durable rows in Postgres. Where a producer owns a transaction, it passes that transaction client through policy reads and outbox writes. Network attempts run after commit through `flushNotificationsAfter`; the cleanup registry's email and bell relays finish pending work on the active platform ticker.

| Channel                      | Durable state             | Attempt and recovery                                        |
| ---------------------------- | ------------------------- | ----------------------------------------------------------- |
| Transactional email          | `FailedEmail`             | `lib/email/deliver.ts`, then `retry-failed-emails`          |
| Newsletter batches           | `FailedEmailBatch`        | Admin waitlist broadcast, then the same email relay         |
| In-app inbox                 | `NotificationOutbox`      | `lib/novu/outbox.ts`, then `drain-notification-outbox`      |
| Enterprise customer webhooks | `OutboundWebhookDelivery` | Enterprise webhook worker; separate from user notifications |

Rendering uses React Email once per recipient and derives a plain-text part. Email rows preserve rendered content; credential messages store a redacted body and are never replayed by the relay. A fresh credential must be requested if its inline send did not succeed.

An outbox row proves staging, and a provider response proves acceptance. Neither proves inbox delivery or human acknowledgement. Resend callbacks persist delivery events and enforce permanent-bounce and complaint suppression.

## Preferences and recipient safety

Postgres `NotificationPreference` is the authority. Novu subscriber data mirrors the settings for its workflow conditions; it is not the email preference source.

- Optional email obeys master, email, category, and workspace routing settings. Required notices (`category: null`) bypass optional switches and workspace email routing.
- Bells obey master, in-app, category, and workspace routing settings. Unknown recipients are excluded. Failed policy reads never authorize a send; transactional failures propagate, while the nontransactional service returns failure.
- Routine bells honor quiet hours; security changes, actionable payment/refund/payout failures, disputes opened, and compliance deadlines bypass quiet-hours deferral. Other preference switches still apply.
- Enabling quiet hours persists the displayed start, end and timezone. Shared-recipient rows currently use the latest applicable quiet-hours end.
- Email suppression is checked at staging and again before inline delivery; the relay also checks it.
- Recipient-aware email stores explicit user/category context in nullable `FailedEmail.deliveryPolicy`. Inline attempts and retries re-read the current account, address, category and workspace policy; required notices bypass optional switches but never recipient identity checks. Temporary read failures leave durable work pending. Older rows and direct-address mail lack this context and retain their existing policy.

- Newsletter batch retries validate the stored payload, current subscription state and suppression. If any recipient is no longer eligible, the whole batch is dead-lettered with `batch audience changed: consent or suppression`. Operators must review it before a new send; the relay never edits a previously attempted payload under the same idempotency key.
- Every email passes the pre-launch delivery guard, including batch replay. No audit or test should send real messages to seeded addresses.

The delivery-policy column is additive work in this PR. The human-run schema rollout must precede deployment of its reader/writer; the audit did not change the shared database.

## Idempotency and recovery

Email attempts use a row-scoped idempotency key. Bell rows use a deterministic event/recipient/payload key, or an explicit event identity supplied by the producer; the wire request carries it as the provider's idempotency header. A legitimate repeated business event must have a distinct identity. Failed payouts retain their payout ID for this reason.

The flush helper attempts each staged bell row once per invocation even if a multi-recipient result repeats it. The initial retry grace window prevents routine inline/relay overlap; registry jobs use the Postgres cron lease.

Provider deduplication is time-limited. An extended outage or manual replay after that window can duplicate a previously accepted request. Local SENT state is authoritative; durable staging alone does not provide exactly-once external delivery.

## Announcements and marketing

Public banners return only currently active announcements. The authenticated management feed (`?view=manage`) returns up to 100 recent records, including drafts, scheduled and expired announcements, with private/no-store caching. The admin form validates its local-time schedule and API responses; rejected writes keep the form open instead of showing success.

Creating an active announcement stages a publication in its business transaction. Future publications use the existing outbox's `notBefore` floor and relay; there is no separate activation job. Edits replace an unsent revision, and deactivation/deletion cancels queued rows in the same transaction. A recorded send is not broadcast again by ordinary edits. Before delivery, the sender checks the source record, revision, content, links and date window. Expired, deleted or superseded work becomes an expected terminal cancellation without bug alerts or an operator-recovery entry.

Provider-accepted and in-flight notices cannot be recalled atomically. The deletion dialog makes that limit explicit. Older queued announcement payloads without source/revision context require operator review rather than an unverified broadcast.

Waitlist newsletters use confirmed waitlist subscriptions and separate newsletter sending identities. Account marketing consent and waitlist membership are separate surfaces; neither should be inferred from optional transactional preferences.

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

## Deprecated & Superseded Approaches

The former landing page mixed historical audit diagrams, target architecture and current behavior. Use code, this overview and dated verification evidence together. Earlier per-event Novu workflows were replaced by family templates; Novu email/push arrows do not describe active delivery. Sentry traces/logs/metrics are not the operational backlog alert owner.
